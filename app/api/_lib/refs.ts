// The referral ledger: every r-fstacc DepositSol that paid a referral fee to someone else's r-fstacc account.
// Mechanism (same as /api/ref): a referred wallet's SOL enters through the stake pool's DepositSol with the referrer's r-fstacc
// account as the referral fee account; the pool pays it 50% of the 0.1% deposit fee. Self-referrals and the dev account
// (the site's default referrer, i.e. unreferred traffic) are left out. Incremental like the winner feed: baseline file + scan.
import { Connection, PublicKey, type ParsedInstruction, type PartiallyDecodedInstruction } from "@solana/web3.js";
import bs58 from "bs58";

const POOL = new PublicKey("SzoSoRxsrL9sbFcwpbjbH5bRrzuvFtuytZTeuqZCfQ6");
const STAKE_POOL_PROGRAM = "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY";
const DEV_ATA = "6Jrrws5TmFTb4eCa63A4yNnaSCC62yvvHYspK3KW4SEd";

export type RefHit = {
  sig: string;
  ts: number;
  /** wallet that owns the referral fee account */
  referrer: string;
  funder: string;
  /** SOL deposited, lamports */
  lamports: number;
  /** r-fstacc paid to the referrer, raw units (9 dp) */
  fee: number;
};
export type RefState = { v: 1; at: number; cursor?: string; hits: RefHit[] };
export const emptyRefs = (): RefState => ({ v: 1, at: 0, hits: [] });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(f: () => Promise<T>, tries = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await f();
    } catch (e) {
      last = e;
      await sleep(800 * (i + 1));
    }
  }
  throw last;
}

/** Fold every pool tx newer than the cursor into the ledger. `maxSigs` bounds one pass (the baseline passes Infinity). */
export async function scanRefs(prev: RefState | null, opts: { maxSigs?: number; log?: (s: string) => void } = {}): Promise<RefState> {
  const st: RefState = prev ? { ...prev, hits: [...prev.hits] } : emptyRefs();
  const url = process.env.HELIUS_RPC_URL;
  if (!url) throw new Error("HELIUS_RPC_URL not configured");
  const c = new Connection(url, "confirmed");
  const max = opts.maxSigs ?? 3000;
  const sigs: string[] = [];
  let before: string | undefined;
  let newest: string | undefined;
  let hit = false;
  while (sigs.length < max && !hit) {
    // `until` stops the RPC at the cursor: nothing new means an empty page, not 1000 rows to compare
    const page = await retry(() => c.getSignaturesForAddress(POOL, { limit: 1000, before, until: st.cursor }));
    if (!page.length) break;
    newest ??= page[0].signature;
    for (const s of page) {
      if (s.signature === st.cursor) {
        hit = true;
        break;
      }
      if (!s.err) sigs.push(s.signature);
    }
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  sigs.reverse();
  const seen = new Set(st.hits.map((h) => h.sig));
  for (let i = 0; i < sigs.length; i += 100) {
    const chunk = sigs.slice(i, i + 100);
    const txs = await retry(() => c.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 1 as unknown as number }));
    txs.forEach((tx, j) => {
      if (!tx?.meta || tx.meta.err || seen.has(chunk[j])) return;
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
      const ixs: (ParsedInstruction | PartiallyDecodedInstruction)[] = [
        ...tx.transaction.message.instructions,
        ...(tx.meta.innerInstructions ?? []).flatMap((x) => x.instructions),
      ];
      for (const ix of ixs) {
        if (ix.programId.toBase58() !== STAKE_POOL_PROGRAM || !("data" in ix)) continue;
        const data = bs58.decode(ix.data);
        if (data[0] !== 14 || ix.accounts.length < 7) continue; // DepositSol
        const funder = ix.accounts[3].toBase58();
        const dest = ix.accounts[4].toBase58();
        const referral = ix.accounts[6].toBase58();
        // referral == destination: the account received the deposit itself, so its balance change is not a fee
        if (referral === DEV_ATA || referral === dest) continue;
        const idx = keys.indexOf(referral);
        const post = tx.meta.postTokenBalances?.find((b) => b.accountIndex === idx);
        const pre = tx.meta.preTokenBalances?.find((b) => b.accountIndex === idx);
        const referrer = post?.owner ?? pre?.owner;
        if (!referrer || referrer === funder) continue;
        const fee = Number(BigInt(post?.uiTokenAmount.amount ?? "0") - BigInt(pre?.uiTokenAmount.amount ?? "0"));
        if (fee <= 0) continue;
        seen.add(chunk[j]);
        st.hits.push({
          sig: chunk[j],
          ts: tx.blockTime ?? 0,
          referrer,
          funder,
          lamports: Number(Buffer.from(data).readBigUInt64LE(1)),
          fee,
        });
        break;
      }
    });
    if (i + 100 < sigs.length) await sleep(150);
  }
  opts.log?.(`refs: ${sigs.length} new pool txs, ${st.hits.length} referral hits total`);
  if (newest) st.cursor = newest;
  st.hits.sort((a, b) => b.ts - a.ts);
  st.at = Math.floor(Date.now() / 1000);
  return st;
}
