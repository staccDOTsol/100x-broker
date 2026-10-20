// 1-click zaps for dnvault: the server plans, the wallet signs everything at once, we send in order.
// Zap in  = park SOL + deploy it (swap half, hedge, add liquidity) with the user acting as keeper.
// Zap out = withdraw in kind, then turn every leg back into SOL in a second, pre-signed transaction.
import { Buffer } from "buffer";
import bs58 from "bs58";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { conn, loadMarketView, sendRaw, toV0 } from "./chain";
import { assertTransactionDeployment } from "./deployment";
import { cu } from "./hooked";
import { track } from "@vercel/analytics";
import { backIxs, MIN_SHARE_LAMPORTS, raiseOpen } from "./backable";
import { DN_PROGRAM, withdrawIxs, type VaultView } from "./dn";
import { exitIxs, planExit } from "./exit";
import { poolState, withdrawSolIx, withdrawOut } from "./zap";
import { RFSTACC, WSOL } from "../config";
import { humanError } from "../hooks";

// "held": the step didn't run and nothing was lost, it waits (a deploy the vault refused for now; the SOL stays parked)
export type StepStatus = "todo" | "signing" | "sending" | "done" | "failed" | "held";
export type Step = { label: string; status: StepStatus; sig?: string; error?: string; note?: string };

/** The vault refused a deploy step with ZeroAmount (custom 6): the parked SOL was already put to work, i.e. the keeper's pass
 *  ran between your park and your deploy (it polls every ~30 s and picks up any idle SOL). */
const errText = (e: unknown) => `${e instanceof Error ? e.message : String(e)} ${JSON.stringify(e)}`;
const dnCode = (e: unknown) => {
  const m = errText(e).match(new RegExp(`${DN_PROGRAM.toBase58()} failed: custom program error: 0x([0-9a-f]+)\\b`, "i"));
  return m ? parseInt(m[1], 16) : null;
};
const keeperBeatUs = (e: unknown) => dnCode(e) === 6;
/** A deploy step the vault refused on purpose, with the SOL already parked: HedgeWorse (13) = the DOWN hedge costs more than it
 *  covers on this book; PriceSanity (14) = the pool is too far from the market's TWAP. Neither loses anything; the keeper retries. */
const HELD: Record<number, string> = {
  13: "Parked, not deployed: on this book the DOWN hedge costs more than it covers, so the vault won't buy the coin without cover. Your SOL waits in the vault as SOL; the keeper deploys it once the hedge is worth buying. Unpark any time.",
  14: "Parked, not deployed: the pool price is too far from the market's TWAP right now. Your SOL waits in the vault; the keeper retries every ~30 s. Unpark any time.",
};
export type Outcome = { sigs: string[]; held: string | null };
/** A token transfer inside a deploy step came up short (SPL InsufficientFunds, custom 1): the vault's balances moved between
 *  planning and landing, almost always because the keeper's ~30 s pass deployed the same idle SOL/coin first. */
const vaultMoved = (e: unknown) => /Token(?:keg|zQd)\w* failed: custom program error: 0x1\b|custom program error: 0x1\b/i.test(errText(e));
export type Wallet = {
  signAllTransactions?: <T extends VersionedTransaction>(txs: T[]) => Promise<T[]>;
  signTransaction?: <T extends VersionedTransaction>(tx: T) => Promise<T>;
};
type PlanIx = { programId: string; keys: { p: string; s: boolean; w: boolean }[]; data: string };
type Plan = { steps: { label: string; ixs: PlanIx[]; signers: string[] }[]; note?: string };

const toIx = (p: PlanIx) =>
  new TransactionInstruction({ programId: new PublicKey(p.programId), keys: p.keys.map((k) => ({ pubkey: new PublicKey(k.p), isSigner: k.s, isWritable: k.w })), data: Buffer.from(p.data, "base64") });

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const r = await fetch("/api/dnzap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "planning failed");
  return j as T;
}

/** One wallet prompt for the whole batch when the wallet can, otherwise one prompt per transaction. */
async function signAll(wallet: Wallet, txs: VersionedTransaction[]) {
  await Promise.all(txs.map((tx) => assertTransactionDeployment(conn, tx)));
  if (wallet.signAllTransactions) return wallet.signAllTransactions(txs);
  if (!wallet.signTransaction) throw new Error("wallet can't sign");
  const out: VersionedTransaction[] = [];
  for (const tx of txs) out.push(await wallet.signTransaction(tx));
  return out;
}

async function run(
  steps: Step[],
  txs: VersionedTransaction[],
  wallet: Wallet,
  onStep: (steps: Step[]) => void,
  after?: (i: number, e: unknown) => { kind: "keeper" } | { kind: "held"; why: string } | null,
): Promise<Outcome> {
  const set = (i: number, patch: Partial<Step>) => {
    steps[i] = { ...steps[i], ...patch };
    onStep([...steps]);
  };
  steps.forEach((_, i) => set(i, { status: "signing" }));
  let signed: VersionedTransaction[];
  try {
    signed = await signAll(wallet, txs);
  } catch (e) {
    steps.forEach((_, i) => set(i, { status: "failed", error: e instanceof Error ? e.message : "not signed" }));
    throw e;
  }
  steps.forEach((_, i) => set(i, { status: "todo" }));
  const sigs: string[] = [];
  for (let i = 0; i < signed.length; i++) {
    set(i, { status: "sending" });
    try {
      const sig = await sendRaw(signed[i].serialize());
      sigs.push(sig);
      set(i, { status: "done", sig });
    } catch (e) {
      const o = after?.(i, e) ?? null;
      // the keeper got there first: what this step and the rest would have done is already done, by the keeper's transaction
      if (o?.kind === "keeper") {
        for (let j = i; j < steps.length; j++) set(j, { status: "done", note: j === i ? "the keeper deployed it first" : "done by the keeper" });
        track("zap_keeper_raced", { step: i });
        return { sigs, held: null };
      }
      // refused for now, nothing lost: this step and the rest wait with the parked SOL
      if (o?.kind === "held") {
        for (let j = i; j < steps.length; j++) set(j, { status: "held", note: j === i ? "not now · your SOL stays parked" : "waits with it" });
        track("zap_deploy_held", { step: i });
        return { sigs, held: o.why };
      }
      set(i, { status: "failed", error: humanError(e) });
      for (let j = i + 1; j < steps.length; j++) set(j, { status: "failed", error: "skipped" });
      throw e;
    }
  }
  return { sigs, held: null };
}

/** Plan the zap-in first so the UI can show the steps before the wallet opens. */
export async function planZapIn(user: PublicKey, view: VaultView, lamports: bigint) {
  return post<Plan>({ kind: "in", vault: view.v.key.toBase58(), user: user.toBase58(), lamports: lamports.toString() });
}

export async function zapIn(user: PublicKey, plan: Plan, wallet: Wallet, onStep: (steps: Step[]) => void) {
  const steps: Step[] = plan.steps.map((s) => ({ label: s.label, status: "todo" }));
  onStep([...steps]);
  const txs: VersionedTransaction[] = [];
  // measured on mainnet: deposit ~30k CU, swap+hedge ~205k, add liquidity ~97k (open position is heavier) — the limit is what the priority fee is charged on
  const limits = [80_000, 320_000, 400_000];
  for (const [i, s] of plan.steps.entries()) {
    const tx = await toV0([cu(limits[i] ?? 400_000), ...s.ixs.map(toIx)], user);
    if (s.signers.length) tx.sign(s.signers.map((k) => Keypair.fromSecretKey(bs58.decode(k))));
    txs.push(tx);
  }
  // step 0 parks; every later step deploys the parked SOL, which the keeper may already have done or the vault may refuse for now
  return run(steps, txs, wallet, onStep, (i, e) => {
    if (i === 0) return null;
    if (keeperBeatUs(e)) return { kind: "keeper" };
    const c = dnCode(e);
    if (c !== null && HELD[c]) return { kind: "held", why: HELD[c] };
    if (vaultMoved(e))
      return { kind: "held", why: "Parked. The vault's balance moved under this step (the keeper usually deploys idle SOL within ~30 s), so it didn't run as planned. Nothing is lost: your SOL is in the vault and the keeper finishes the deploy on its next pass." };
    // anything else after the park landed: the SOL is still parked, say that next to the reason
    return { kind: "held", why: `Parked, not fully deployed: ${humanError(e)}. Your SOL is in the vault; the keeper deploys what's idle on its next pass. Unpark any time.` };
  });
}

/** What this wallet holds of a vault's legs: the coin (X), DOWN, WSOL and r-fstacc. */
type Legs = { x: bigint; down: bigint; wsol: bigint; quote: bigint };
async function walletLegs(user: PublicKey, view: VaultView): Promise<Legs> {
  const { v } = view;
  const bal = async (ata: PublicKey) => {
    try {
      return BigInt((await conn.getTokenAccountBalance(ata)).value.amount);
    } catch {
      return 0n;
    }
  };
  const [x, down, wsol, quote] = await Promise.all([
    bal(getAssociatedTokenAddressSync(v.xMint, user, false, v.xProgram)),
    bal(getAssociatedTokenAddressSync(v.downMint, user, false, TOKEN_2022_PROGRAM_ID)),
    bal(getAssociatedTokenAddressSync(WSOL, user)),
    bal(getAssociatedTokenAddressSync(RFSTACC, user)),
  ]);
  return { x, down, wsol, quote };
}
// The wallet's legs just before an unpark (per vault + wallet), so "leftovers → SOL" sells exactly what unparks withdrew and the
// second step didn't sell. A hedge leg and a directional bet are the same DOWN mint, and the coin may be the user's own bag:
// only the delta tells them apart (the same rule the dn/unpark.ts script learnt, see the wiki).
const snapKey = (view: VaultView, user: PublicKey) => `unpark:${view.v.key.toBase58()}:${user.toBase58()}`;
function loadSnap(view: VaultView, user: PublicKey): Legs | null {
  try {
    const j = JSON.parse(localStorage.getItem(snapKey(view, user)) ?? "null");
    return j ? { x: BigInt(j.x), down: BigInt(j.down), wsol: BigInt(j.wsol), quote: BigInt(j.quote) } : null;
  } catch {
    return null;
  }
}
/** Keeps the EARLIEST snapshot until a finish clears it, so several unparks in a row are all attributed. */
function saveSnap(view: VaultView, user: PublicKey, l: Legs) {
  if (loadSnap(view, user)) return;
  try {
    localStorage.setItem(snapKey(view, user), JSON.stringify({ x: l.x.toString(), down: l.down.toString(), wsol: l.wsol.toString(), quote: l.quote.toString(), at: Date.now() }));
  } catch {
    /* private mode: the finish step then sells nothing it can't attribute */
  }
}
function clearSnap(view: VaultView, user: PublicKey) {
  try {
    localStorage.removeItem(snapKey(view, user));
  } catch {
    /* nothing to clear */
  }
}
/** What unparks left in the wallet: now − before, never below zero. No record → nothing (never guess). */
export function unparkLeftovers(before: Legs | null, now: Legs): Legs {
  if (!before) return { x: 0n, down: 0n, wsol: 0n, quote: 0n };
  const d = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
  return { x: d(now.x, before.x), down: d(now.down, before.down), wsol: d(now.wsol, before.wsol), quote: d(now.quote, before.quote) };
}

/** Everything the withdraw hands over, turned back into SOL: X sold on the pool, WSOL unwrapped, DOWN exited, r-fstacc unstaked. */
export async function zapOut(user: PublicKey, view: VaultView, shares: bigint, wallet: Wallet, onStep: (steps: Step[]) => void) {
  const { v, x } = view;
  if (x.supply === 0n || shares <= 0n) throw new Error("nothing to unpark");
  const frac = (n: bigint) => (n * shares) / x.supply;
  // 98% of the pro-rata estimate: the vault can drift a hair between planning and landing, and the second tx is signed blind
  const safe = (n: bigint) => (n * 98n) / 100n;
  const xOut = safe(frac(x.xTotal));
  const downOut = safe(frac(x.held));
  const pool = await poolState();
  const quoteRaw = x.quoteSol > 0n ? BigInt(Math.floor(Number(x.quoteSol) / pool.rate)) : 0n;
  const quoteOut = safe(frac(quoteRaw));

  const steps: Step[] = [{ label: "Unpark in kind", status: "todo" }, { label: "Turn it all back into SOL", status: "todo" }];
  onStep([...steps]);
  // what the wallet held before: step 2 sells 98% of the estimate, so the rest (and anything step 2 fails to sell) is attributable later
  saveSnap(view, user, await walletLegs(user, view));
  const tx1 = await toV0([cu(600_000), ...(await withdrawIxs(user, view, shares))], user);

  const back: TransactionInstruction[] = [cu(600_000)];
  let solOutEstimate = 0n; // WSOL the X swap pays, lamports
  let downProceeds = 0n; // r-fstacc the DOWN exit pays
  if (xOut > 0n) {
    const sw = await post<{ ixs: PlanIx[]; minOut: string }>({ kind: "out", vault: v.key.toBase58(), user: user.toBase58(), amountX: xOut.toString() });
    back.push(...sw.ixs.map(toIx));
    solOutEstimate += BigInt(sw.minOut);
  }
  // WSOL from the swap + the withdrawn WSOL -> SOL
  back.push(createCloseAccountInstruction(getAssociatedTokenAddressSync(WSOL, user), user, user));
  if (downOut > 0n) {
    const mv = await loadMarketView(v.market);
    if (!mv) throw new Error("market unavailable");
    const plan = await planExit(mv, 1, downOut);
    downProceeds = plan.sellMin + plan.redeemMin;
    back.push(...(await exitIxs(mv, 1, plan, user, pool)).filter(notBudget)); // the exit builder adds its own compute budget; two of them is a rejected tx
  }
  if (quoteOut > 1_000n) back.push(withdrawSolIx(pool, user, getAssociatedTokenAddressSync(RFSTACC, user), quoteOut));
  const tx2 = await toV0(back, user);
  // the 0/20 rule on the unvault, as its own third transaction: tx2 is already full (X swap + DOWN exit + unstake), and the
  // SOL it pays sits in the wallet by the time this one runs. 20% of (SOL coming back − what these shares cost this wallet).
  const txs = [tx1, tx2];
  if (raiseOpen()) {
    try {
      const outLamports = solOutEstimate + withdrawOut(pool, downProceeds) + (quoteOut > 1_000n ? withdrawOut(pool, quoteOut) : 0n);
      // the vault's own yield is the gain: share price started at 1.0, so (price − 1) / price of what comes out is what the
      // vault earned on these shares. Unconditional on the holder's entry: every unpark from a vault that's up pays its 20%.
      const yieldFrac = Math.max(0, (x.sharePrice - 1) / x.sharePrice);
      const gain = BigInt(Math.floor(Number(outLamports) * yieldFrac));
      const lam = gain / 5n;
      if (lam >= MIN_SHARE_LAMPORTS) {
        const b = await backIxs(user, lam);
        txs.push(await toV0([cu(400_000), ...b.ixs], user, b.tables));
        steps.push({ label: `0/20 → STACCIndex (${(Number(b.usdc) / 1e6).toFixed(2)} USDC)`, status: "todo" });
        onStep([...steps]);
      } else track("backable_skip", { why: "vault_not_up", lam: Number(lam) });
    } catch (e) {
      track("backable_skip", { why: "error", msg: String((e as Error)?.message ?? e).slice(0, 80) });
      console.warn("0/20 skipped", e);
    }
  }
  return run(steps, txs, wallet, onStep);
}

const notBudget = (ix: TransactionInstruction) => !ix.programId.equals(ComputeBudgetProgram.programId);

/** After an unpark that stopped half way (or an in-kind one): turn whatever of this vault's legs sits in the wallet into SOL, from live balances. */
export async function zapOutFinish(user: PublicKey, view: VaultView, wallet: Wallet, onStep: (steps: Step[]) => void) {
  const { v } = view;
  const wsolAta = getAssociatedTokenAddressSync(WSOL, user);
  const quoteAta = getAssociatedTokenAddressSync(RFSTACC, user);
  // only what this browser's unparks from this vault withdrew and didn't sell: never the wallet's own DOWN bet or coin bag
  const before = loadSnap(view, user);
  if (!before) throw new Error("This browser has no record of an unpark from this vault, so it won't sell your coin or DOWN (they may be your own bets). Nothing was sent.");
  const { x, down, wsol, quote } = unparkLeftovers(before, await walletLegs(user, view));
  const steps: Step[] = [{ label: "Turn your unpark leftovers into SOL", status: "todo" }];
  onStep([...steps]);
  const pool = await poolState();
  const back: TransactionInstruction[] = [cu(600_000)];
  if (x > 0n) {
    const sw = await post<{ ixs: PlanIx[]; minOut: string }>({ kind: "out", vault: v.key.toBase58(), user: user.toBase58(), amountX: x.toString() });
    back.push(...sw.ixs.map(toIx));
  }
  if (x > 0n || wsol > 0n) back.push(createCloseAccountInstruction(wsolAta, user, user));
  if (down > 0n) {
    const mv = await loadMarketView(v.market);
    if (!mv) throw new Error("market unavailable");
    const plan = await planExit(mv, 1, down);
    back.push(...(await exitIxs(mv, 1, plan, user, pool)).filter(notBudget));
  }
  if (quote > 1_000n) back.push(withdrawSolIx(pool, user, quoteAta, quote));
  if (back.length === 1) {
    clearSnap(view, user);
    throw new Error("Nothing from your unparks is left in your wallet.");
  }
  const tx = await toV0(back, user);
  const out = await run(steps, [tx], wallet, onStep);
  clearSnap(view, user);
  return out;
}

export const explorerFor = (sig: string) => `https://solscan.io/tx/${sig}`;
export { conn };
