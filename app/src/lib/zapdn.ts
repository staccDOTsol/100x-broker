// 1-click zaps for dnvault: the server plans, the wallet signs everything at once, we send in order.
// Zap in  = park SOL + deploy it (swap half, hedge, add liquidity) with the user acting as keeper.
// Zap out = withdraw in kind, then turn every leg back into SOL in a second, pre-signed transaction.
import { Buffer } from "buffer";
import bs58 from "bs58";
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { conn, loadMarketView, sendRaw, toV0 } from "./chain";
import { cu } from "./hooked";
import { track } from "@vercel/analytics";
import { backIxs, MIN_SHARE_LAMPORTS, raiseOpen } from "./backable";
import { withdrawIxs, type VaultView } from "./dn";
import { exitIxs, planExit } from "./exit";
import { poolState, withdrawSolIx, withdrawOut } from "./zap";
import { RFSTACC, WSOL } from "../config";

export type StepStatus = "todo" | "signing" | "sending" | "done" | "failed";
export type Step = { label: string; status: StepStatus; sig?: string; error?: string };
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
  if (wallet.signAllTransactions) return wallet.signAllTransactions(txs);
  if (!wallet.signTransaction) throw new Error("wallet can't sign");
  const out: VersionedTransaction[] = [];
  for (const tx of txs) out.push(await wallet.signTransaction(tx));
  return out;
}

async function run(steps: Step[], txs: VersionedTransaction[], wallet: Wallet, onStep: (steps: Step[]) => void) {
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
      set(i, { status: "failed", error: e instanceof Error ? e.message : "failed" });
      for (let j = i + 1; j < steps.length; j++) set(j, { status: "failed", error: "skipped" });
      throw e;
    }
  }
  return sigs;
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
  return run(steps, txs, wallet, onStep);
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
  const bal = async (ata: PublicKey) => {
    try {
      return BigInt((await conn.getTokenAccountBalance(ata)).value.amount);
    } catch {
      return 0n;
    }
  };
  const xAta = getAssociatedTokenAddressSync(v.xMint, user, false, v.xProgram);
  const downAta = getAssociatedTokenAddressSync(v.downMint, user, false, TOKEN_2022_PROGRAM_ID);
  const wsolAta = getAssociatedTokenAddressSync(WSOL, user);
  const quoteAta = getAssociatedTokenAddressSync(RFSTACC, user);
  const [x, down, wsol, quote] = await Promise.all([bal(xAta), bal(downAta), bal(wsolAta), bal(quoteAta)]);
  const steps: Step[] = [{ label: "Turn what's in your wallet into SOL", status: "todo" }];
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
  if (back.length === 1) throw new Error("Nothing from this vault is sitting in your wallet.");
  const tx = await toV0(back, user);
  return run(steps, [tx], wallet, onStep);
}

export const explorerFor = (sig: string) => `https://solscan.io/tx/${sig}`;
export { conn };
