// $NGU history from chain, anchored to live state: start from the pool's SOL backing and the mint's supply now, walk
// backwards through pool and crank transactions undoing each one's reserve SOL change and NGU mint/burn. Yields the
// SOL-per-NGU rate after every transaction and every buy (who, SOL in, NGU out). Exact while the pool has no validator
// (all its SOL sits in the reserve). Incremental across warm invocations via memo().
import { Connection, PublicKey, type ParsedInstruction, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction } from "@solana/web3.js";
import { conn } from "../../src/lib/chain.js";
import { memo } from "./memo.js";
import { NGU } from "../../src/ngu.js";

export type Point = [number, number]; // [unix seconds, SOL per NGU]
export type Buy = { sig: string; t: number; wallet: string; via: "not-a-presale" | "direct"; lamports: number; ngu: number };
type Hist = { newest: Record<string, string>; points: Point[]; buys: Buy[] };
type Sig = { signature: string; slot: number; blockTime: number | null };

const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MAX_TXS = 1500; // bound a cold rebuild
// Signatures and transactions come from Helius: the shared connection prefers a live-state node that keeps no history.
export const history = process.env.HELIUS_RPC_URL ? new Connection(process.env.HELIUS_RPC_URL, "confirmed") : conn;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function retry<T>(what: string, fn: () => Promise<T | null>): Promise<T> {
  for (let i = 0; ; i++) {
    const v = await fn().catch(() => null);
    if (v !== null && v !== undefined) return v;
    if (i >= 7) throw new Error(`could not load ${what}`);
    await sleep(600 * (i + 1));
  }
}

async function sigsSince(addr: string, until: string | undefined): Promise<Sig[]> {
  const out: Sig[] = [];
  let before: string | undefined;
  while (out.length < MAX_TXS) {
    const page = await retry(`signatures of ${addr}`, () =>
      history.getSignaturesForAddress(new PublicKey(addr), { limit: 1000, before, until }, "confirmed"),
    );
    out.push(...page.filter((s) => !s.err).map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null })));
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  return out;
}

function supplyDelta(tx: ParsedTransactionWithMeta, mint: string): number {
  const ixs: (ParsedInstruction | PartiallyDecodedInstruction)[] = [...tx.transaction.message.instructions];
  for (const inner of tx.meta?.innerInstructions ?? []) ixs.push(...inner.instructions);
  let d = 0;
  for (const ix of ixs) {
    if (!("parsed" in ix) || ix.programId.toBase58() !== T22) continue;
    const { type, info } = ix.parsed as { type: string; info: { mint?: string; amount?: string; tokenAmount?: { amount: string } } };
    if (info?.mint !== mint) continue;
    const amt = Number(info.amount ?? info.tokenAmount?.amount ?? 0);
    if (type === "mintTo" || type === "mintToChecked") d += amt;
    else if (type === "burn" || type === "burnChecked") d -= amt;
  }
  return d;
}

/** A buy: SOL into the reserve with NGU minted to someone other than the fee account. The buyer is the owner of the
 *  account the NGU was minted to (even if it moved on in the same transaction, e.g. an arb selling straight into Orca). */
function buyOf(tx: ParsedTransactionWithMeta, sig: Sig, reserveDelta: number, mint: string, feeAccount: string, presale: string | null): Buy | null {
  if (reserveDelta <= 0 || !tx.meta) return null;
  const ixs: (ParsedInstruction | PartiallyDecodedInstruction)[] = [...tx.transaction.message.instructions];
  for (const inner of tx.meta.innerInstructions ?? []) ixs.push(...inner.instructions);
  let best: { account: string; amount: number } | null = null;
  for (const ix of ixs) {
    if (!("parsed" in ix) || ix.programId.toBase58() !== T22) continue;
    const { type, info } = ix.parsed as { type: string; info: { mint?: string; account?: string; amount?: string; tokenAmount?: { amount: string } } };
    if ((type !== "mintTo" && type !== "mintToChecked") || info.mint !== mint || !info.account || info.account === feeAccount) continue;
    const amount = Number(info.amount ?? info.tokenAmount?.amount ?? 0);
    if (!best || amount > best.amount) best = { account: info.account, amount };
  }
  if (!best) return null;
  const keys = tx.transaction.message.accountKeys;
  const idx = keys.findIndex((k) => k.pubkey.toBase58() === best!.account);
  const owner = [...(tx.meta.postTokenBalances ?? []), ...(tx.meta.preTokenBalances ?? [])].find((b) => b.accountIndex === idx)?.owner;
  if (!owner) return null;
  const viaPresale = !!presale && keys.some((k) => k.signer && k.pubkey.toBase58() === presale);
  return { sig: sig.signature, t: sig.blockTime ?? Math.floor(Date.now() / 1000), wallet: owner, via: viaPresale ? "not-a-presale" : "direct", lamports: reserveDelta, ngu: best.amount };
}

async function build(prev: Hist | undefined): Promise<Hist> {
  const pool = NGU.stakePool!, state = NGU.state!, mint = NGU.mint!;
  const accs = await retry("pool + mint", () =>
    conn.getMultipleAccountsInfo([new PublicKey(pool), new PublicKey(mint)]).then((a) => (a[0] && a[1] ? a : null)),
  );
  const reserve = new PublicKey(accs[0]!.data.subarray(130, 162)).toBase58();
  const feeAccount = new PublicKey(accs[0]!.data.subarray(194, 226)).toBase58();
  let backing = Number(accs[0]!.data.readBigUInt64LE(258)); // pool total_lamports: reserve SOL above its rent-exempt minimum
  let supply = Number(accs[1]!.data.readBigUInt64LE(36));
  const now = Math.floor(Date.now() / 1000);

  const fresh = new Map<string, Sig>();
  const newest: Record<string, string> = { ...(prev?.newest ?? {}) };
  for (const addr of [pool, state]) {
    const sigs = await sigsSince(addr, prev?.newest[addr]);
    if (sigs.length) newest[addr] = sigs[0].signature;
    for (const s of sigs) fresh.set(s.signature, s);
  }
  const ordered = [...fresh.values()].sort((a, b) => b.slot - a.slot).slice(0, MAX_TXS);
  if (!prev && ordered.length === 0) throw new Error("no transaction history returned"); // don't cache an upstream gap

  const back: Point[] = [[now, supply > 0 ? backing / supply : 1]];
  const buys: Buy[] = [];
  let reachedLaunch = false;
  for (let i = 0; i < ordered.length && !reachedLaunch; i += 4) {
    const batch = ordered.slice(i, i + 4);
    const txs = await Promise.all(
      batch.map((s) => retry(s.signature, () => history.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }))),
    );
    for (let j = 0; j < txs.length; j++) {
      const tx = txs[j], sig = batch[j], t = sig.blockTime ?? now;
      if (!tx.meta) continue;
      if (tx.meta.logMessages?.some((l) => l.includes("Initialize stake pool"))) {
        back.push([t, 1]); // launch: the pool starts at 1 SOL per NGU
        reachedLaunch = true;
        break;
      }
      if (supply > 0) back.push([t, backing / supply]); // state right after this transaction
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
      const r = keys.indexOf(reserve);
      const dRes = r >= 0 ? tx.meta.postBalances[r] - tx.meta.preBalances[r] : 0;
      const b = buyOf(tx, sig, dRes, mint, feeAccount, NGU.presaleAddress);
      if (b) buys.push(b);
      backing -= dRes;
      supply -= supplyDelta(tx, mint);
    }
  }
  const newPoints = back.reverse();
  const kept = prev ? prev.points.filter((p) => p[0] < (newPoints[0]?.[0] ?? now)) : [];
  const seen = new Set(buys.map((b) => b.sig));
  return { newest, points: [...kept, ...newPoints], buys: [...(prev?.buys ?? []).filter((b) => !seen.has(b.sig)), ...buys.reverse()] };
}

export const nguHistory = () => memo<Hist>("ngu-history-v4", 20_000, 600_000, build);

/** The pool's current SOL sell (withdrawal) fee in bps: SPL StakePool fields after the fixed header, some variable-length. */
export async function sellFeeBps(): Promise<number> {
  const d = (await retry("pool", () => conn.getAccountInfo(new PublicKey(NGU.stakePool!))))!.data;
  let o = 258 + 24 + 48;
  const fee = () => { const den = d.readBigUInt64LE(o), num = d.readBigUInt64LE(o + 8); o += 16; return den === 0n ? 0 : Number((num * 10000n) / den); };
  const future = () => { const tag = d[o]; o += 1; if (tag === 1 || tag === 2) fee(); };
  const optKey = () => { const tag = d[o]; o += 1 + (tag === 1 ? 32 : 0); };
  fee(); future(); optKey(); optKey(); fee(); fee(); future(); o += 1; optKey(); fee(); o += 1; optKey();
  return fee();
}
