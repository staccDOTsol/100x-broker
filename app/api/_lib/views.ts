// One server-side load of every market view, shared by every visitor through the edge cache. Each browser used to do
// ~80 RPC calls through the proxy every 6 s; with a few dozen tabs open that is what rate-limited the upstream for everyone.
import { PublicKey } from "@solana/web3.js";
import { listMarketKeys, loadMarketView, type MarketView } from "../../src/lib/chain.js";
import { memo } from "./memo.js";
import { classifyMany } from "./category.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function retry<T>(f: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await f();
    } catch (e) {
      last = e;
      if (!/429|Too Many/i.test(String(e))) throw e;
      await sleep(600 * (i + 1));
    }
  }
  throw last;
}

/** All market views: 5 s fresh, served stale up to 30 s more while one background load refreshes them; concurrent callers share
 *  the load (api/_lib/memo.ts). */
export const allViews = (): Promise<MarketView[]> =>
  memo("views:all", 5_000, 30_000, async () => {
    const keys = await retry(listMarketKeys);
    const v: MarketView[] = [];
    for (let i = 0; i < keys.length; i += 3) {
      const batch = await Promise.all(keys.slice(i, i + 3).map((k) => retry(() => loadMarketView(k)).catch(() => null)));
      for (const m of batch) if (m) v.push(m);
    }
    // Memes · Majors · Stonks: the static rules ran in loadMarketView; what is still `other` gets Jupiter's tags and the mint's
    // issuer authorities (both memoized a day). A miss leaves `other`, never a guess.
    const open = v.filter((m) => m.category === "other");
    if (open.length) {
      const cats = await classifyMany(open.map((m) => ({ mint: m.underlyingMint, name: m.ticker }))).catch(() => new Map<string, MarketView["category"]>());
      for (const m of open) m.category = cats.get(m.underlyingMint) ?? "other";
    }
    return v;
  });

/** JSON with bigints and public keys tagged so the browser can revive the exact MarketView shape. */
export const encode = (x: unknown) =>
  JSON.stringify(x, function (this: Record<string, unknown>, k: string, val: unknown) {
    // JSON.stringify hands the replacer the value AFTER toJSON (PublicKey -> base58 string, Buffer -> {type,data}); the
    // untouched original is still on the holder, so tag from there
    const raw = this?.[k];
    if (raw instanceof PublicKey) return { $p: raw.toBase58() };
    if (raw instanceof Uint8Array) return { $u: Buffer.from(raw).toString("base64") };
    if (typeof val === "bigint") return { $b: val.toString() };
    return val;
  });
