// GET /api/runners[?cat=meme|major|stonk] -> what's running on Solana right now, each coin tagged with what the degen can do about it here:
//   market   -> we already run a board for it: { key, levUp, levDown }            (Trade)
//   listable -> the deepest usable oracle pool vs SOL/USDC/USDT on any venue (Raydium CLMM/CPMM, PumpSwap, Meteora DAMM v2/DLMM):
//               { id, venue, quote, tvl }                                          (List it, one click on /new)
//   venue_hint -> the listable venue (kept for older clients), null when nothing is listable
//   category -> meme | major | stonk | stable | other (src/lib/category.ts: verified mints, issuer invariants, Jupiter tags)
// Sources per `cat`:
//   (none)  Birdeye trending, classified (Jupiter tags for the unknown ones, one batched call)
//   meme    Birdeye trending, memes only
//   stonk   every Jupiter-verified tokenized stock (tag `stocks`: xStocks, Ondo GM, PreStocks, Backpack, Tessera, Shift) by 24 h volume
//   major   the curated majors + Jupiter `major`/`lst` by 24 h volume
//   stonk/major rows carry Jupiter's 24 h volume and market cap; price and 24 h change come from Birdeye `defi/multi_price` (one call),
//   market cap from Birdeye `defi/v3/token/market-data` for the top rows (per address; `…/multiple` needs a higher Birdeye plan).
// Whole payload memoized 60 s fresh / 600 s stale per cat; per-mint venue discovery 10 min / 1 h. No key -> { runners: [] } with 200.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { PublicKey } from "@solana/web3.js";
import { allViews, retry } from "./_lib/views.js";
import { memo, peek } from "./_lib/memo.js";
import { classifyMany, majorList, stonkList, type JupTok } from "./_lib/category.js";
import { parseCat, type Cat, type Category } from "../src/lib/category.js";
import { type MarketView, conn, oracleHealth } from "../src/lib/chain.js";
import { type PoolCandidate, type Venue, candidateEffectiveQuote, candidateTvlUsd, discoverPools } from "../src/lib/venues.js";

const BIRDEYE = "https://public-api.birdeye.so";
const TRENDING = `${BIRDEYE}/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=50`;
const SOL = "So11111111111111111111111111111111111111112";
const CAP = 50;
const WIDTH = 8; // enrichment concurrency
const MC_TOP = 24; // stonk/major rows that get a Birdeye market-data read (one call each)

export type Listable = { id: string; venue: Venue; quote: string; tvl: number };
export type Market = { key: string; levUp: number | null; levDown: number | null };
export type Runner = {
  mint: string;
  symbol: string;
  name: string;
  logo: string | null;
  price: number | null;
  mc: number | null;
  vol24: number | null;
  chg24: number | null; // percent, as Birdeye reports it (12.5 = +12.5%)
  liq: number | null;
  rank: number | null;
  pump: boolean;
  category: Category;
  market: Market | null;
  listable: Listable | null;
  venue_hint: Venue | null;
};
export type Payload = { at: number; cat: Cat | null; runners: Runner[]; error?: string };

type Trending = Omit<Runner, "market" | "listable" | "venue_hint" | "category"> & { category?: Category };

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x !== "" && Number.isFinite(Number(x)) ? Number(x) : null);
const round = (x: number | null, dp: number) => (x === null ? null : Number(x.toFixed(dp)));
// JSON has no Infinity: an empty opposite pot (Infinity) becomes a number lev() still prints as ">10,000×"; NaN (both pots empty) -> null
const levOut = (x: number): number | null => (Number.isNaN(x) ? null : Number.isFinite(x) ? round(x, 2) : 1e9);
const be = (key: string) => ({ "X-API-KEY": key, "x-chain": "solana", accept: "application/json" });

/** Birdeye's trending list, newest first by rank. */
async function trending(key: string): Promise<Trending[]> {
  const r = await fetch(TRENDING, { headers: be(key) });
  if (!r.ok) throw new Error(`birdeye ${r.status}`);
  const j: any = await r.json();
  const rows: any[] = j?.data?.tokens ?? [];
  const out: Trending[] = [];
  for (const t of rows) {
    const mint = typeof t?.address === "string" ? t.address : null;
    if (!mint) continue;
    out.push({
      mint,
      symbol: String(t.symbol ?? "").trim() || mint.slice(0, 4),
      name: String(t.name ?? t.symbol ?? "").trim(),
      logo: typeof t.logoURI === "string" && /^https?:\/\//.test(t.logoURI) ? t.logoURI : null,
      price: num(t.price),
      mc: num(t.marketcap) ?? num(t.fdv),
      vol24: num(t.volume24hUSD),
      chg24: round(num(t.price24hChangePercent), 2),
      liq: num(t.liquidity),
      rank: num(t.rank),
      pump: mint.endsWith("pump"),
    });
  }
  return out.slice(0, CAP);
}

/** Birdeye price + 24 h change for up to 100 mints in one call (`defi/multi_price`; verified fields: value, priceChange24h). */
async function multiPrice(key: string, mints: string[]): Promise<Map<string, { price: number | null; chg24: number | null }>> {
  const out = new Map<string, { price: number | null; chg24: number | null }>();
  for (let i = 0; i < mints.length; i += 100) {
    const batch = mints.slice(i, i + 100);
    try {
      const r = await fetch(`${BIRDEYE}/defi/multi_price?list_address=${batch.join(",")}`, { headers: be(key), signal: AbortSignal.timeout(8_000) });
      if (!r.ok) continue;
      const j: any = await r.json();
      for (const m of batch) {
        const d = j?.data?.[m];
        if (d) out.set(m, { price: num(d.value), chg24: round(num(d.priceChange24h), 2) });
      }
    } catch {
      /* Jupiter's numbers stand for this batch */
    }
  }
  return out;
}
/** Birdeye market cap + liquidity for one mint (`defi/v3/token/market-data`; verified fields: price, liquidity, market_cap, fdv). 5 min / 1 h. */
const marketData = (key: string, mint: string) =>
  memo<{ mc: number | null; liq: number | null } | null>(`runners:md:${mint}`, 300_000, 3_600_000, async () => {
    const r = await fetch(`${BIRDEYE}/defi/v3/token/market-data?address=${mint}`, { headers: be(key), signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return null;
    const d: any = ((await r.json()) as any)?.data;
    return d ? { mc: num(d.market_cap) ?? num(d.fdv), liq: num(d.liquidity) } : null;
  });

/** Jupiter rows (stonks or majors, already by 24 h volume) as runners, enriched with Birdeye price / change / market cap. */
async function fromJupiter(key: string, rows: JupTok[], category: Category): Promise<Trending[]> {
  const top = rows.slice(0, CAP);
  const px = await multiPrice(key, top.map((t) => t.mint));
  const md = await pmap(top.slice(0, MC_TOP), WIDTH, (t) => marketData(key, t.mint).catch(() => null));
  return top.map((t, i) => {
    const p = px.get(t.mint);
    const m = i < MC_TOP ? md[i] : null;
    return {
      mint: t.mint,
      symbol: t.symbol || t.mint.slice(0, 4),
      name: t.name || t.symbol,
      logo: t.icon,
      price: p?.price ?? t.price,
      mc: m?.mc ?? t.mc,
      vol24: t.vol24,
      chg24: p?.chg24 ?? round(t.chg24, 2),
      liq: m?.liq ?? t.liq,
      rank: i + 1,
      pump: t.mint.endsWith("pump"),
      category,
    };
  });
}

/** SOL/USD for PumpSwap depth (its API publishes no TVL; depth = 2 × SOL reserve × price). Same memo key as /api/price. */
const solUsd = (): Promise<number | null> =>
  memo("price:sol", 5_000, 30_000, async () => {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL}`, { signal: AbortSignal.timeout(5000) });
    const p = Number(((await r.json()) as any)?.[SOL]?.usdPrice);
    if (!Number.isFinite(p) || p <= 0) throw new Error("no jup price");
    return p;
  }).catch(() => null);

/** Same bar /new sets: a CLMM needs a ring with at least one observation; an AMM needs a positive (effective) quote reserve. */
const usable = (c: PoolCandidate) => (c.venue === "clmm" ? !!c.obsData && oracleHealth(c.obsData).ok : (candidateEffectiveQuote(c) ?? 0n) > 0n);

/** The deepest usable oracle pool for this mint on any venue, or null. Memoized per mint; a failed discovery is not cached
 *  (the memo throws, the caller turns that into null for this round only). */
const bestPool = (mint: string, sol: number | null): Promise<Listable | null> =>
  memo(`runners:pool:${mint}`, 600_000, 3_600_000, async () => {
    const pools = await retry(() => discoverPools(conn, new PublicKey(mint)));
    let best: Listable | null = null;
    for (const c of pools) {
      if (!usable(c)) continue;
      const tvl = candidateTvlUsd(c, sol) ?? 0;
      if (!best || tvl > best.tvl) best = { id: c.pool.toBase58(), venue: c.venue, quote: c.quote, tvl };
    }
    return best;
  });

/** Markets we already run, by underlying mint; when several share a coin, the one with the most in its pots. Bounded wait: a cold
 *  chain load must not hold the strip hostage — whatever views are already held serve, else nobody gets a Trade door this round. */
async function marketsByMint(): Promise<Map<string, Market>> {
  const held = () => peek<MarketView[]>("views:all") ?? [];
  const views = await Promise.race([allViews().catch(held), new Promise<MarketView[]>((r) => setTimeout(() => r(held()), 6_000))]);
  const pots = (v: MarketView) => v.side[0].vault + v.side[1].vault;
  const by = new Map<string, MarketView>();
  for (const v of views) {
    const cur = by.get(v.underlyingMint);
    if (!cur || pots(v) > pots(cur)) by.set(v.underlyingMint, v);
  }
  const out = new Map<string, Market>();
  for (const [mint, v] of by) out.set(mint, { key: v.acct.key.toBase58(), levUp: levOut(v.side[0].leverage), levDown: levOut(v.side[1].leverage) });
  return out;
}

/** map with at most `width` promises in flight. */
async function pmap<T, U>(xs: T[], width: number, f: (x: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(xs.length);
  let i = 0;
  const worker = async () => {
    for (;;) {
      const k = i++;
      if (k >= xs.length) return;
      out[k] = await f(xs[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, xs.length) }, worker));
  return out;
}

/** The source list for a cat: trending (classified) for none/meme; Jupiter's stock or major universe for stonk/major. */
async function source(key: string, cat: Cat | null): Promise<Trending[]> {
  if (cat === "stonk") return fromJupiter(key, await stonkList(), "stonk");
  if (cat === "major") return fromJupiter(key, await majorList(), "major");
  const list = await trending(key);
  const cats = await classifyMany(list).catch(() => new Map<string, Category>());
  const tagged = list.map((t) => ({ ...t, category: cats.get(t.mint) ?? "other" }));
  return cat === "meme" ? tagged.filter((t) => t.category === "meme") : tagged;
}

/** The whole strip: source + enrichment. Exported so it can be exercised without an HTTP server. */
export async function loadRunners(key: string, cat: Cat | null = null): Promise<Payload> {
  const [list, markets, sol] = await Promise.all([source(key, cat), marketsByMint().catch(() => new Map<string, Market>()), solUsd()]);
  const runners = await pmap(list, WIDTH, async (t): Promise<Runner> => {
    const market = markets.get(t.mint) ?? null;
    const listable = await bestPool(t.mint, sol).catch(() => null);
    return { ...t, category: t.category ?? "other", market, listable, venue_hint: listable?.venue ?? null };
  });
  return { at: Date.now(), cat, runners };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("cache-control", "public, max-age=30, s-maxage=60, stale-while-revalidate=600");
  const cat = parseCat(typeof req.query.cat === "string" ? req.query.cat : null);
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) return res.status(200).json({ at: Date.now(), cat, runners: [], error: "BIRDEYE_API_KEY not configured" } satisfies Payload);
  try {
    res.status(200).json(await memo(`runners:${cat ?? "all"}`, 60_000, 600_000, () => loadRunners(key, cat)));
  } catch (e) {
    // upstream down and nothing held: an empty strip, not a broken board
    res.status(200).json({ at: Date.now(), cat, runners: [], error: e instanceof Error ? e.message : "runners failed" } satisfies Payload);
  }
}
