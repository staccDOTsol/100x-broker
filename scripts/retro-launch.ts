// Plan companion pump.fun coins for every existing market: two 1oox mints (UP / DOWN) quoted in $100XBRO,
// creator = ~/hooked.json, creator_fee_bps 300, fee-sharing split, then register_launch.
// Dry-run by default (prints the SOL total, does not take vanity keys). SEND=1 pulls keys and sends.
// Does not grind. If the stockpile is short, it says how many keys are missing.
import { appendFileSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PROGRAM_ID, cu, launchPda, decodeLaunch } from "./lib";
import { CU_BUY, CU_CREATE, CU_SHARE, firstBuyIxs, launchSideIxs, resolvePumpQuote, PUMP_QUOTE } from "../app/src/lib/pump";
import { LAUNCH_MODE_SHARED } from "../app/src/lib/hooked";
import { ALT_FALLBACK } from "../app/src/config";

const PREFIX = process.env.VANITY_PREFIX ?? "1oox";
const GRINDER = (process.env.GRINDER_URL ?? "https://sexicurves-grind.fly.dev").replace(/\/$/, "");
const SEND = process.env.SEND === "1";
const KEYS_FILE = process.env.KEYS_FILE;
/** SOL kept back for fees. The rest of the wallet, after create rent, is the first-buy budget. */
const RESERVE_LAMPORTS = 120_000_000n;
const MODE = LAUNCH_MODE_SHARED;

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadEnvFile(new URL("../app/.env.local", import.meta.url).pathname);

const RPC = process.env.RPC ?? process.env.HELIUS_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC, "confirmed");
const payerFile = `${homedir()}/hooked.json`;
if (!existsSync(payerFile)) {
  console.error("missing ~/hooked.json");
  process.exit(1);
}
const payerKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(payerFile, "utf8"))));
const payer = payerKp.publicKey;

type SidePlan = { side: 0 | 1; name: string; symbol: string; uri: string };
type MarketPlan = { market: PublicKey; sides: SidePlan[] };

function tokenMeta(data: Buffer): { name: string; symbol: string; uri: string } {
  let o = 166;
  while (o + 4 <= data.length) {
    const t = data.readUInt16LE(o);
    const l = data.readUInt16LE(o + 2);
    if (t === 0) break;
    if (t === 19 && o + 4 + 64 + 4 <= data.length) {
      let p = o + 4 + 64;
      const str = () => {
        if (p + 4 > data.length) return "";
        const n = data.readUInt32LE(p);
        const s = data.subarray(p + 4, p + 4 + n).toString("utf8");
        p += 4 + n;
        return s;
      };
      return { name: str(), symbol: str(), uri: str() };
    }
    o += 4 + l;
  }
  return { name: "", symbol: "", uri: "" };
}

async function markets(): Promise<MarketPlan[]> {
  const res = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 1008 }] });
  const live = res.filter((r) => r.account.data.subarray(0, 8).toString() === "hookmkt1");
  const out: MarketPlan[] = [];
  for (const { pubkey, account } of live) {
    const d = account.data;
    const bull = new PublicKey(d.subarray(8, 40));
    const bear = new PublicKey(d.subarray(40, 72));
    const pdas = [launchPda(pubkey, 0), launchPda(pubkey, 1)];
    const [l0, l1, m0, m1] = await conn.getMultipleAccountsInfo([...pdas, bull, bear]);
    const launched = [l0, l1].map((info, side) => (info && info.owner.equals(PROGRAM_ID) ? decodeLaunch(pdas[side], info.data) : null));
    const metas = [m0, m1].map((info) => (info ? tokenMeta(Buffer.from(info.data)) : { name: "", symbol: "", uri: "" }));
    const sides: SidePlan[] = [];
    for (const side of [0, 1] as const) {
      if (launched[side]) continue;
      const meta = metas[side];
      const mint = side === 0 ? bull : bear;
      sides.push({
        side,
        name: meta.name || (side === 0 ? "UP" : "DOWN"),
        symbol: meta.symbol || (side === 0 ? "UP" : "DN"),
        uri: meta.uri || `https://100x.broker/api/meta?mint=${mint.toBase58()}&s=${side ? "down" : "up"}`,
      });
    }
    if (sides.length) out.push({ market: pubkey, sides });
  }
  return out;
}

/** Count of `prefix` keys in whatever shape GET /stock returns. null when the body has no count. */
function stockCount(body: unknown, prefix: string): number | null {
  const seen = new Set<object>();
  const walk = (v: unknown): number | null => {
    if (!v || typeof v !== "object" || seen.has(v)) return null;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (typeof o[prefix] === "number") return o[prefix] as number;
    if (o.prefix === prefix && typeof o.available === "number") return o.available as number;
    if (typeof o.count === "number" && (o.prefix === prefix || o.name === prefix)) return o.count as number;
    for (const x of Object.values(o)) {
      const n = walk(x);
      if (n !== null) return n;
    }
    return null;
  };
  return walk(body);
}

async function vanityStock(): Promise<{ body: unknown; have: number | null; error?: string }> {
  try {
    const r = await fetch(`${GRINDER}/stock`, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return { body: null, have: null, error: `grinder /stock ${r.status}` };
    const body = await r.json();
    return { body, have: stockCount(body, PREFIX) };
  } catch (e) {
    return { body: null, have: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Same pull as app/api/_lib/vanity.ts. No local grind and no Keypair.generate fallback. */
async function takeVanity(n: number): Promise<{ keys: Keypair[]; missing: number }> {
  const token = process.env.GRINDER_TOKEN;
  if (!token) return { keys: [], missing: n };
  const keys: Keypair[] = [];
  for (let i = 0; i < n; i++) {
    try {
      const r = await fetch(`${GRINDER}/take-key?prefix=${encodeURIComponent(PREFIX)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) break;
      const j: any = await r.json();
      const secret: number[] | undefined = Array.isArray(j?.secret) ? j.secret.map(Number) : undefined;
      if (!secret || secret.length !== 64) break;
      const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
      if (kp.publicKey.toBase58() !== j.pubkey || !kp.publicKey.toBase58().startsWith(PREFIX)) break;
      keys.push(kp);
    } catch {
      break;
    }
  }
  return { keys, missing: n - keys.length };
}

const lamports = (n: number) => `${(n / 1e9).toFixed(6)} SOL`;

async function main() {
  console.log(`retro-launch ${SEND ? "SEND" : "dry-run"} · payer ${payer.toBase58()} · mode ${MODE} (lister 1000 / launch 9000)`);
  const [plan, pq, stock] = await Promise.all([markets(), resolvePumpQuote(conn), vanityStock()]);
  const needed = plan.reduce((n, m) => n + m.sides.length, 0);
  console.log(`markets missing a side: ${plan.length} · coins to launch: ${needed}`);
  for (const m of plan) {
    console.log(`  ${m.market.toBase58()}  ${m.sides.map((s) => `${s.side === 0 ? "UP" : "DOWN"} ${s.symbol}`).join("  ")}`);
  }
  if (stock.error) console.log(`grinder stock: ${stock.error}`);
  else console.log(`grinder stock (${PREFIX}): ${stock.have === null ? "count not in the response" : stock.have}`);
  const have = stock.have ?? 0;
  const missing = stock.have === null ? needed : Math.max(0, needed - have);
  if (stock.have === null) console.log(`could not read how many ${PREFIX} keys are stocked. Treating all ${needed} as missing. Not grinding.`);
  else if (missing > 0) console.log(`vanity stock is short ${missing} ${PREFIX} key${missing === 1 ? "" : "s"} (have ${have}, need ${needed}). Not grinding.`);
  else console.log(`vanity stock covers all ${needed} ${PREFIX} keys.`);
  if (!process.env.GRINDER_TOKEN) console.log("GRINDER_TOKEN is unset, so SEND cannot pull keys.");
  if (needed === 0) {
    console.log("SOL total: 0");
    return;
  }

  const rentLaunch = await conn.getMinimumBalanceForRentExemption(144);
  const rentShare = await conn.getMinimumBalanceForRentExemption(1024);
  const vaultInfo = pq.quote.pumpQuote?.accounts.pool?.baseVault ? await conn.getAccountInfo(pq.quote.pumpQuote.accounts.pool.baseVault) : null;
  const ataRent = vaultInfo?.lamports ?? (await conn.getMinimumBalanceForRentExemption(182));
  const listerAta = getAssociatedTokenAddressSync(PUMP_QUOTE, payer, false, pq.quote.quoteTokenProgram);
  const listerHas = !!(await conn.getAccountInfo(listerAta));
  // per side: pump creator-vault ATA, PumpSwap coin-creator ATA, Launch PDA quote ATA. Lister ATA once.
  const shareAtaRent = 3 * ataRent + (listerHas ? 0 : ataRent);

  const sample = plan[0];
  const throwaway = Keypair.generate();
  const { create } = await launchSideIxs({
    payer, market: sample.market, side: sample.sides[0].side, mint: throwaway.publicKey,
    name: sample.sides[0].name, symbol: sample.sides[0].symbol, uri: sample.sides[0].uri, mode: MODE, pq,
  });
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer, recentBlockhash: blockhash, instructions: [cu(CU_CREATE), create[0]],
  }).compileToV0Message());
  const before = await conn.getBalance(payer);
  const sim = await conn.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true,
    accounts: { encoding: "base64", addresses: [payer.toBase58()] },
  });
  if (sim.value.err) {
    console.log("create_v2 simulation failed:", JSON.stringify(sim.value.err));
    console.log((sim.value.logs ?? []).slice(-12).join("\n"));
  }
  const after = sim.value.accounts?.[0]?.lamports ?? null;
  const createCost = after === null ? null : before - after;
  const perSide = (createCost ?? 0) + rentLaunch + rentShare + shareAtaRent + 5_000;
  const total = (createCost === null ? null : perSide * needed);
  console.log(`create_v2 (simulated, one coin): ${createCost === null ? "unknown" : lamports(createCost)}`);
  console.log(`register_launch rent (144): ${lamports(rentLaunch)} · sharing config (1024): ${lamports(rentShare)} · quote ATAs: ${lamports(shareAtaRent)}${listerHas ? "" : " incl. lister ATA"}`);
  console.log(`SOL total for ${needed} coin${needed === 1 ? "" : "s"}: ${total === null ? "unknown (create_v2 sim had no balance)" : lamports(total)}`);
  if (!SEND) {
    console.log("dry-run: nothing sent, no vanity keys taken.");
    return;
  }
  const queue = plan.flatMap((m) => m.sides.map((side) => ({ market: m.market, ...side })));
  const buyEach = await fundFirstBuys(queue.length, BigInt(perSide));
  const usedPath = KEYS_FILE ? `${KEYS_FILE}.used` : "";
  let done = 0;
  while (done < queue.length) {
    const side = queue[done];
    const registered = await conn.getAccountInfo(launchPda(side.market, side.side));
    if (registered?.owner.equals(PROGRAM_ID)) {
      console.log(`already registered ${side.market.toBase58()} ${side.side === 0 ? "UP" : "DOWN"}`);
      done++;
      continue;
    }
    const mint = await nextKey(usedPath);
    if (await conn.getAccountInfo(mint.publicKey)) {
      console.log(`retiring ${mint.publicKey.toBase58()} (already created)`);
      if (usedPath) appendFileSync(usedPath, mint.publicKey.toBase58() + "\n");
      continue;
    }
    console.log(`SEND ${side.market.toBase58()} ${side.side === 0 ? "UP" : "DOWN"} ${mint.publicKey.toBase58()} (${done + 1}/${queue.length})`);
    const built = await launchSideIxs({
      payer, market: side.market, side: side.side, mint: mint.publicKey,
      name: side.name, symbol: side.symbol, uri: side.uri, mode: MODE, pq,
    });
    await sendTx("create", [cu(CU_CREATE), ...built.create], [mint]);
    await sendTx("share", [cu(CU_SHARE), ...built.share], []);
    if (buyEach > 0n) await sendTx("buy", [cu(CU_BUY), ...(await firstBuyIxs({ payer, mint: mint.publicKey, creator: built.creator, buyQuote: buyEach, pq }))], []);
    if (usedPath) appendFileSync(usedPath, mint.publicKey.toBase58() + "\n");
    done++;
  }
  console.log(`launched ${done} coins`);
}

let tables: AddressLookupTableAccount[] | null = null;
async function alts() {
  if (tables) return tables;
  tables = (await Promise.all(ALT_FALLBACK.map((k) => conn.getAddressLookupTable(k).then((r) => r.value)))).filter((t): t is AddressLookupTableAccount => !!t);
  return tables;
}

async function sendTx(label: string, ixs: Parameters<TransactionMessage["constructor"]>[0]["instructions"], extra: Keypair[]) {
  const [{ blockhash: bh, lastValidBlockHeight }, lookup] = await Promise.all([conn.getLatestBlockhash(), alts()]);
  const vtx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: bh, instructions: ixs }).compileToV0Message(lookup));
  vtx.sign([payerKp, ...extra]);
  const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
  const res = await conn.confirmTransaction({ signature: sig, blockhash: bh, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`${label} ${sig} ${JSON.stringify(res.value.err)}`);
  console.log(`  ${label} ${sig}`);
}

function freshKeys(usedPath: string): Keypair[] {
  if (!KEYS_FILE || !existsSync(KEYS_FILE)) return [];
  const used = new Set(usedPath && existsSync(usedPath) ? readFileSync(usedPath, "utf8").trim().split("\n").filter(Boolean) : []);
  const out: Keypair[] = [];
  for (const line of readFileSync(KEYS_FILE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const j = JSON.parse(line) as { pubkey: string; secret: number[] };
    if (used.has(j.pubkey)) continue;
    const kp = Keypair.fromSecretKey(Uint8Array.from(j.secret));
    if (kp.publicKey.toBase58() !== j.pubkey || !j.pubkey.startsWith(PREFIX)) throw new Error(`bad vanity key ${j.pubkey}`);
    out.push(kp);
  }
  return out;
}

async function nextKey(usedPath: string): Promise<Keypair> {
  for (;;) {
    const got = freshKeys(usedPath);
    if (got.length) return got[0];
    if (!KEYS_FILE) throw new Error("KEYS_FILE is unset and the local stock is empty");
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

/** Swap leftover SOL (after create rent and the reserve) into $100XBRO and split it across the coins. */
async function fundFirstBuys(n: number, perSide: bigint): Promise<bigint> {
  if (process.env.BUY_EACH) return BigInt(process.env.BUY_EACH);
  const bal = BigInt(await conn.getBalance(payer));
  const buySol = bal - RESERVE_LAMPORTS - perSide * BigInt(n);
  console.log(`wallet ${lamports(Number(bal))} · create hold ${lamports(Number(perSide * BigInt(n)))} · reserve ${lamports(Number(RESERVE_LAMPORTS))} · first-buy SOL ${buySol > 0n ? lamports(Number(buySol)) : "0"}`);
  if (buySol < 20_000_000n) return 0n;
  const inMint = "So11111111111111111111111111111111111111112";
  const q = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${inMint}&outputMint=${PUMP_QUOTE.toBase58()}&amount=${buySol}&slippageBps=150`);
  if (!q.ok) throw new Error(`jupiter quote ${q.status}`);
  const quote = (await q.json()) as { outAmount: string };
  const s = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: payer.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
  });
  if (!s.ok) throw new Error(`jupiter swap ${s.status} ${(await s.text()).slice(0, 200)}`);
  const swap = (await s.json()) as { swapTransaction: string };
  const vtx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  vtx.sign([payerKp]);
  const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`swap ${sig} ${JSON.stringify(res.value.err)}`);
  const each = BigInt(quote.outAmount) / BigInt(n);
  console.log(`swapped ${lamports(Number(buySol))} → ${quote.outAmount} raw $100XBRO · ${each} per coin · ${sig}`);
  return each;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
