// Incremental signature windows and a parsed-transaction cache, shared by every feed-style endpoint.
//   recentSigs(c, address, limit): the newest `limit` signatures of an address. After the first fill only signatures newer
//     than the newest one already known are fetched (`until`), so a quiet account costs one tiny call per refresh.
//   parsedTxs(c, sigs): getParsedTransactions through a bounded cache keyed by signature. Confirmed transactions never
//     change, so a signature is parsed once per instance; only misses go upstream.
import type { Connection, ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";

export type SigRow = { signature: string; err: boolean; blockTime: number | null };
type Window = { rows: SigRow[]; at: number };
const windows = new Map<string, Window>();
const windowInflight = new Map<string, Promise<SigRow[]>>();
const WINDOW_MAX = 1500;

function trimWindows() {
  if (windows.size <= WINDOW_MAX) return;
  for (const k of windows.keys()) {
    if (windows.size <= WINDOW_MAX * 0.9) break;
    windows.delete(k);
  }
}

export async function recentSigs(c: Connection, address: PublicKey, limit: number): Promise<SigRow[]> {
  const key = `${address.toBase58()}:${limit}`;
  const running = windowInflight.get(key);
  if (running) return running;
  const p = (async () => {
    const w = windows.get(key);
    const until = w?.rows[0]?.signature;
    const page = await c.getSignaturesForAddress(address, { limit, until });
    const fresh: SigRow[] = page.map((s) => ({ signature: s.signature, err: !!s.err, blockTime: s.blockTime ?? null }));
    let rows: SigRow[];
    // first fill, or at least `limit` new signatures (the cursor was not reached): the page is the whole answer
    if (!w || fresh.length >= limit) rows = fresh;
    else {
      const seen = new Set(fresh.map((r) => r.signature));
      rows = [...fresh, ...w.rows.filter((r) => !seen.has(r.signature))].slice(0, limit);
    }
    windows.delete(key);
    windows.set(key, { rows, at: Date.now() });
    trimWindows();
    return rows;
  })().finally(() => windowInflight.delete(key));
  windowInflight.set(key, p);
  return p;
}

const txs = new Map<string, ParsedTransactionWithMeta>();
const TX_MAX = 3000;

export async function parsedTxs(
  c: Connection,
  sigs: string[],
  opts: { chunk?: number; maxSupportedTransactionVersion?: number } = {},
): Promise<(ParsedTransactionWithMeta | null)[]> {
  const chunk = opts.chunk ?? 100;
  const version = opts.maxSupportedTransactionVersion ?? 0;
  const miss = [...new Set(sigs.filter((s) => !txs.has(s)))];
  for (let i = 0; i < miss.length; i += chunk) {
    const part = miss.slice(i, i + chunk);
    const got = await c.getParsedTransactions(part, { maxSupportedTransactionVersion: version });
    got.forEach((t, j) => {
      if (t) txs.set(part[j], t); // a null (not indexed yet) is not cached: the next refresh asks again
    });
  }
  if (txs.size > TX_MAX) for (const k of txs.keys()) {
    if (txs.size <= TX_MAX * 0.9) break;
    txs.delete(k);
  }
  return sigs.map((s) => txs.get(s) ?? null);
}
