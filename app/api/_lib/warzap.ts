// Zaps for Stars War token games, and USD prices for every number the War page, cards and tweets show.
// zapIn: a bidder short of the game's token gets a SOL -> token swap in the same transaction, sized so the swap's worst case
// (its slippage floor) still covers the bid. Jupiter routes $100XBRO only exact-in, so the input is found by re-quoting.
// zapOut: dividends or winnings in the token go back to SOL in the same transaction as the claim.
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount, type Connection } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { tokenProgramOf } from "../../src/lib/war.js";

// a Jupiter API key (JUP_API_KEY) moves us off the shared free endpoint, which rate-limits Vercel's shared IPs
const JUP = process.env.JUP_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
const JUP_HEADERS: Record<string, string> = process.env.JUP_API_KEY ? { "x-api-key": process.env.JUP_API_KEY } : {};
const WSOL = "So11111111111111111111111111111111111111112";
const SLIPPAGE_BPS = 300;
// lookup tables the router and Jupiter use are long-lived: fetch each once per instance (10 min)
const altCache = new Map<string, { at: number; t: Promise<AddressLookupTableAccount | null> }>();
function alt(conn: Connection, key: PublicKey) {
  const k = key.toBase58();
  const hit = altCache.get(k);
  if (hit && Date.now() - hit.at < 600_000) return hit.t;
  const t = conn.getAddressLookupTable(key).then((x) => x.value).catch(() => null);
  altCache.set(k, { at: Date.now(), t });
  return t;
}
// the last quoted SOL -> token rate per mint (tokens out per lamport at the slippage floor), so sizing takes one quote
const rateCache = new Map<string, { at: number; perLamport: number }>();

type JupIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
const toIx = (i: JupIx) => new TransactionInstruction({ programId: new PublicKey(i.programId), keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(i.data, "base64") });

async function quote(input: string, output: string, amount: bigint) {
  const r = await fetch(`${JUP}/quote?inputMint=${input}&outputMint=${output}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&restrictIntermediateTokens=true`, { headers: JUP_HEADERS, signal: AbortSignal.timeout(10_000) });
  const j = (await r.json()) as { outAmount?: string; otherAmountThreshold?: string; error?: string };
  if (!r.ok || !j.outAmount) throw new Error(`no route ${input.slice(0, 4)}→${output.slice(0, 4)}: ${j.error ?? r.status}`);
  return j as { outAmount: string; otherAmountThreshold: string } & Record<string, unknown>;
}

async function swapIxs(conn: Connection, q: Record<string, unknown>, user: PublicKey) {
  const r = await fetch(`${JUP}/swap-instructions`, {
    method: "POST", headers: { "content-type": "application/json", ...JUP_HEADERS },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: user.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: false }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await r.json()) as { setupInstructions?: JupIx[]; swapInstruction?: JupIx; cleanupInstruction?: JupIx | null; addressLookupTableAddresses?: string[]; error?: string };
  if (!r.ok || !j.swapInstruction) throw new Error(`swap build failed: ${j.error ?? r.status}`);
  const alts = (await Promise.all((j.addressLookupTableAddresses ?? []).map((a) => alt(conn, new PublicKey(a)))))
    .filter((t): t is AddressLookupTableAccount => !!t);
  return { ixs: [...(j.setupInstructions ?? []).map(toIx), toIx(j.swapInstruction), ...(j.cleanupInstruction ? [toIx(j.cleanupInstruction)] : [])], alts };
}

export async function tokenBalance(conn: Connection, owner: PublicKey, mint: PublicKey) {
  const tp = await tokenProgramOf(conn, mint);
  const a = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, owner, false, tp)).catch(() => null);
  return a ? BigInt(a.value.amount) : 0n;
}

// ---- our own router first (api.liquidityxyz.fun, the 1 bp composer), Jupiter as the fallback ----
const ROUTER = process.env.ROUTER_URL ?? "https://api.liquidityxyz.fun";
type Quoted = { outAmount: string; otherAmountThreshold: string } & Record<string, unknown>;
async function routerQuote(input: string, output: string, amount: bigint): Promise<Quoted> {
  const r = await fetch(`${ROUTER}/api/quote/solana?inputMint=${input}&outputMint=${output}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}&transactionVersion=0`, { signal: AbortSignal.timeout(15_000) });
  const j = (await r.json()) as Quoted & { error?: string; routePlan?: unknown };
  if (!r.ok || !j.routePlan || !j.outAmount) throw new Error(`router: ${j.error ?? r.status}`);
  return j;
}
/** The router hands back a whole swap transaction (its bet legs ride in separate transactions, which we leave out); take its
 *  instructions apart so the bid can join them, minus its compute-budget instructions (ours set those). */
async function routerSwapIxs(conn: Connection, q: Quoted, user: PublicKey) {
  const r = await fetch(`${ROUTER}/api/swap/solana`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userPublicKey: user.toBase58(), quoteResponse: q, transactionVersion: "0" }), signal: AbortSignal.timeout(20_000) });
  const j = (await r.json()) as { swapTransactions?: string[]; swapTransaction?: string; error?: string };
  const wire = j.swapTransactions?.[0] ?? j.swapTransaction;
  if (!r.ok || !wire) throw new Error(`router swap: ${j.error ?? r.status}`);
  const tx = VersionedTransaction.deserialize(Buffer.from(wire, "base64"));
  const alts = (await Promise.all(tx.message.addressTableLookups.map((l) => alt(conn, l.accountKey))))
    .filter((t): t is AddressLookupTableAccount => !!t);
  const msg = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: alts });
  return { ixs: msg.instructions.filter((i) => !i.programId.equals(ComputeBudgetProgram.programId)), alts };
}
async function bestQuote(input: string, output: string, amount: bigint): Promise<{ q: Quoted; via: "router" | "jupiter" }> {
  try {
    return { q: await routerQuote(input, output, amount), via: "router" };
  } catch {
    return { q: (await quote(input, output, amount)) as Quoted, via: "jupiter" };
  }
}
const buildSwap = (conn: Connection, via: "router" | "jupiter", q: Quoted, user: PublicKey) =>
  via === "router" ? routerSwapIxs(conn, q, user).catch(() => swapIxs(conn, q, user)) : swapIxs(conn, q, user);

/** SOL -> `mint` so `owner` holds at least `need` raw units after the swap's worst case. The house router and Jupiter both
 *  quote and build at once; the router's is used when it lands within ROUTER_BUDGET_MS (it earns the 1 bp composer fee, but
 *  its swap endpoint also builds the 100x bet legs, which are slow), else Jupiter's. */
const ROUTER_BUDGET_MS = 1_200;
export async function zapIn(conn: Connection, owner: PublicKey, mint: PublicKey, need: bigint) {
  const m = mint.toBase58();
  const size = async (via: "router" | "jupiter") => {
    const at = (amt: bigint) => (via === "router" ? routerQuote(WSOL, m, amt) : (quote(WSOL, m, amt) as Promise<Quoted>));
    // first guess from the last rate seen for this mint on this venue (no probe quote), else probe once
    const key = `${via}:${m}`;
    const cached = rateCache.get(key);
    let lamports: bigint;
    if (cached && Date.now() - cached.at < 30_000) lamports = BigInt(Math.ceil((Number(need) / cached.perLamport) * 1.01)) + 1n;
    else {
      const probe = await at(100_000_000n);
      lamports = (need * 100_000_000n) / BigInt(probe.otherAmountThreshold) + 1n;
    }
    let q = await at(lamports);
    rateCache.set(key, { at: Date.now(), perLamport: Number(q.otherAmountThreshold) / Number(lamports) });
    for (let i = 0; i < 4 && BigInt(q.otherAmountThreshold) < need; i++) {
      lamports = (lamports * need) / BigInt(q.otherAmountThreshold) + lamports / 200n + 1n;
      q = await at(lamports);
    }
    if (BigInt(q.otherAmountThreshold) < need) throw new Error("could not size the swap into the token");
    const built = via === "router" ? await routerSwapIxs(conn, q, owner) : await swapIxs(conn, q, owner);
    return { ...built, via, lamportsIn: lamports, minOut: BigInt(q.otherAmountThreshold), expectedOut: BigInt(q.outAmount) };
  };
  const router = size("router");
  // Jupiter gets one retry: a single 429 or hiccup shouldn't hand the build to the slow path
  const jup = size("jupiter").catch((e) => {
    console.error("[warzap] jupiter", e instanceof Error ? e.message : e);
    return size("jupiter");
  });
  router.catch(() => null);
  jup.catch(() => null);
  const inTime = await Promise.race([router.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ROUTER_BUDGET_MS))]);
  if (inTime) return inTime;
  try {
    return await jup;
  } catch (e) {
    console.error("[warzap] jupiter retry", e instanceof Error ? e.message : e);
    // last resort: the router, but never longer than 12 s in all
    const late = await Promise.race([router.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 12_000 - ROUTER_BUDGET_MS))]);
    if (late) return late;
    throw new Error("no swap route answered in time; try again");
  }
}

/** `amount` raw units of `mint` -> SOL. */
export async function zapOut(conn: Connection, owner: PublicKey, mint: PublicKey, amount: bigint) {
  const { q, via } = await bestQuote(mint.toBase58(), WSOL, amount);
  const { ixs, alts } = await buildSwap(conn, via, q, owner);
  return { ixs, alts, via, minLamports: BigInt(q.otherAmountThreshold), expectedLamports: BigInt(q.outAmount) };
}

// ---------------------------------------------------------------- prices
const priceCache = new Map<string, { at: number; usd: number | null }>();
/** USD per whole token (Birdeye), cached 30 s. SOL games pass the wrapped SOL mint. */
export async function usdPrice(mint: string): Promise<number | null> {
  const hit = priceCache.get(mint);
  if (hit && Date.now() - hit.at < 30_000) return hit.usd;
  let usd: number | null = null;
  try {
    const key = process.env.BIRDEYE_API_KEY;
    if (key) {
      const r = await fetch(`https://public-api.birdeye.so/defi/price?address=${mint}`, { headers: { "X-API-KEY": key, "x-chain": "solana" }, signal: AbortSignal.timeout(6_000) });
      const j = (await r.json()) as { data?: { value?: number } };
      usd = typeof j.data?.value === "number" ? j.data.value : null;
    }
    if (usd === null) {
      const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { signal: AbortSignal.timeout(6_000) });
      const j = (await r.json()) as Record<string, { usdPrice?: number }>;
      usd = j[mint]?.usdPrice ?? null;
    }
  } catch {
    /* no price: the page shows token units only */
  }
  priceCache.set(mint, { at: Date.now(), usd });
  return usd;
}
export const WSOL_MINT = WSOL;
