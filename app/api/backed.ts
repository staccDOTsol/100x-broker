// /api/backed -> how much 100x.broker exits have committed to the STACCIndex raise under the 0/20 rule: every `fund` on the
// launch that rode in the same transaction as one of our program's instructions. Amounts are USDC (6 dp).
// Incremental per instance: the first pass scans the launch's history back to SINCE, later passes fetch only what landed
// after the newest signature already tallied (`until`); 15 s fresh, a minute stale.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { PublicKey, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { memo } from "./_lib/memo.js";
import { serverConnection } from "../src/lib/upstream.js";

const LAUNCH = new PublicKey("6wot8WTk5WGoUQrSbFaTzMasUutYBfQDG3pNan3LG9sU");
const LAUNCH_PROGRAM = "moontUzsdepotRGe5xsfip7vLPTJnVuafqdUWexVnPM";
import { HISTORY_PROGRAM_IDS } from "../src/config.js";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const MEMO_TAG = "100x.broker 0/20";
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const FUND_DISC = Buffer.from([218, 188, 111, 221, 152, 113, 174, 7]);
const SINCE = Date.parse("2026-10-11T20:00:00Z") / 1000;

function fundAmount(tx: ParsedTransactionWithMeta): bigint | null {
  const ixs = tx.transaction.message.instructions as (PartiallyDecodedInstruction | { programId: PublicKey })[];
  const progs = new Set(ixs.map((i) => i.programId.toBase58()));
  // ours if: a 100x instruction rides along (exits), or our memo tag (every 0/20 tx from now on), or a Jupiter swap feeding the
  // fund in one tx (the standalone unvault leg before the tag existed — Backable's own UI never swaps-and-funds in one go)
  const memo = ixs.some((i) => i.programId.toBase58() === MEMO && "parsed" in i && String((i as any).parsed ?? "").includes(MEMO_TAG));
  if (!HISTORY_PROGRAM_IDS.some((program) => progs.has(program.toBase58())) && !memo && !progs.has(JUP)) return null;
  for (const i of ixs) {
    if (i.programId.toBase58() !== LAUNCH_PROGRAM || !("data" in i)) continue;
    const d = Buffer.from(bs58.decode(i.data));
    if (d.length >= 16 && d.subarray(0, 8).equals(FUND_DISC)) return d.readBigUInt64LE(8);
  }
  return null;
}

type Tally = { newest?: string; usdc: bigint; txs: number; backers: Set<string>; pending: string[] };

async function scan(prev: Tally | undefined): Promise<Tally> {
  const u = process.env.HELIUS_RPC_URL;
  if (!u) throw new Error("HELIUS_RPC_URL not configured");
  const c = serverConnection();
  const st: Tally = prev ? { ...prev, backers: new Set(prev.backers), pending: [] } : { usdc: 0n, txs: 0, backers: new Set(), pending: [] };
  const sigs: string[] = [...(prev?.pending ?? [])]; // transactions the RPC had not indexed on the last pass
  let before: string | undefined;
  let top: string | undefined;
  for (;;) {
    const page = await c.getSignaturesForAddress(LAUNCH, { limit: 1000, before, until: st.newest });
    if (!page.length) break;
    top ??= page[0].signature;
    let crossed = false;
    for (const s of page) {
      if ((s.blockTime ?? 0) < SINCE) { crossed = true; break; }
      if (!s.err) sigs.push(s.signature);
    }
    if (crossed || page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  for (let i = 0; i < sigs.length; i += 40) {
    const part = sigs.slice(i, i + 40);
    const batch = await c.getParsedTransactions(part, { maxSupportedTransactionVersion: 0 });
    batch.forEach((tx, j) => {
      if (!tx) return void (st.pending.length < 200 && st.pending.push(part[j]));
      if (tx.meta?.err) return;
      const a = fundAmount(tx);
      if (a === null) return;
      st.usdc += a;
      st.txs++;
      st.backers.add(tx.transaction.message.accountKeys[0].pubkey.toBase58());
    });
  }
  if (top) st.newest = top;
  return st;
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const { usdc, txs, backers } = await memo<Tally>("backed:tally", 15_000, 60_000, scan);
    res.setHeader("cache-control", "public, max-age=5, s-maxage=10, stale-while-revalidate=30")
      .json({ usd: Number(usdc) / 1e6, txs, backers: backers.size, at: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "backed failed" });
  }
}
