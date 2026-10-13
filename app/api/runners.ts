// GET /api/runners -> what's trending on Solana right now (Birdeye), each coin tagged with what the degen can do about it here:
//   market   -> we already run a board for it: { key, levUp, levDown }            (Trade)
//   listable -> a Raydium CLMM pool vs SOL/USDC/USDT exists: { id, quote, tvl }    (List it, one click on /new)
//   venue_hint 'pumpswap' -> no CLMM pool but a pump.fun mint; PumpSwap/CPMM oracles are coming, so "soon" rather than "no"
// Whole payload memoized 60 s fresh / 600 s stale; per-mint Raydium lookups 10 min / 1 h. No key -> { runners: [] } with 200.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { allViews } from "./_lib/views.js";
import { memo, peek } from "./_lib/memo.js";
import type { MarketView } from "../src/lib/chain.js";

const BIRDEYE = "https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=50";
const RAYDIUM = "https://api-v3.raydium.io/pools/info/mint";
const CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const QUOTES: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};
const CAP = 50;
const WIDTH = 8; // enrichment concurrency

export type Listable = { id: string; quote: string; tvl: number };
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
  market: Market | null;
  listable: Listable | null;
  venue_hint: "clmm" | "pumpswap" | null;
};
export type Payload = { at: number; runners: Runner[]; error?: string };

type Trending = Omit<Runner, "market" | "listable" | "venue_hint">;

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x !== "" && Number.isFinite(Number(x)) ? Number(x) : null);
const round = (x: number | null, dp: number) => (x === null ? null : Number(x.toFixed(dp)));
// JSON has no Infinity: an empty opposite pot (Infinity) becomes a number lev() still prints as ">10,000×"; NaN (both pots empty) -> null
const levOut = (x: number): number | null => (Number.isNaN(x) ? null : Number.isFinite(x) ? round(x, 2) : 1e9);

/** Birdeye's trending list, newest first by rank. */
async function trending(key: string): Promise<Trending[]> {
  const r = await fetch(BIRDEYE, { headers: { "X-API-KEY": key, "x-chain": "solana", accept: "application/json" } });
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

/** The deepest Raydium CLMM pool for this mint against one of the quotes our oracle reads, or null. Memoized per mint. */
const clmmPool = (mint: string): Promise<Listable | null> =>
  memo(`runners:clmm:${mint}`, 600_000, 3_600_000, async () => {
    let best: Listable | null = null;
    for (const [quote, qmint] of Object.entries(QUOTES)) {
      const u = `${RAYDIUM}?mint1=${mint}&mint2=${qmint}&poolType=concentrated&poolSortField=liquidity&sortType=desc&pageSize=3&page=1`;
      try {
        const r = await fetch(u);
        if (!r.ok) continue;
        const j: any = await r.json();
        for (const p of j?.data?.data ?? []) {
          if (p?.programId !== CLMM_PROGRAM || !p?.id) continue;
          const a = p.mintA?.address, b = p.mintB?.address;
          if (!((a === mint && b === qmint) || (b === mint && a === qmint))) continue;
          const tvl = Number(p.tvl ?? 0);
          if (!best || tvl > best.tvl) best = { id: String(p.id), quote, tvl };
        }
      } catch {
        /* this quote stays unknown; the others still count */
      }
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

/** The whole strip: trending + enrichment. Exported so it can be exercised without an HTTP server. */
export async function loadRunners(key: string): Promise<Payload> {
  const [list, markets] = await Promise.all([trending(key), marketsByMint().catch(() => new Map<string, Market>())]);
  const runners = await pmap(list, WIDTH, async (t): Promise<Runner> => {
    const market = markets.get(t.mint) ?? null;
    const listable = await clmmPool(t.mint).catch(() => null);
    const venue_hint: Runner["venue_hint"] = listable ? "clmm" : t.pump ? "pumpswap" : null;
    return { ...t, market, listable, venue_hint };
  });
  return { at: Date.now(), runners };
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader("cache-control", "public, max-age=30, s-maxage=60, stale-while-revalidate=600");
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) return res.status(200).json({ at: Date.now(), runners: [], error: "BIRDEYE_API_KEY not configured" });
  try {
    res.status(200).json(await memo("runners:all", 60_000, 600_000, () => loadRunners(key)));
  } catch (e) {
    // upstream down and nothing held: an empty strip, not a broken board
    res.status(200).json({ at: Date.now(), runners: [], error: e instanceof Error ? e.message : "runners failed" });
  }
}
