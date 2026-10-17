// GET /api/search?q=<text>[&cat=meme|major|stonk] -> Solana tokens matching a name/symbol (Birdeye v3 search), biggest 24h volume first,
// each hit classified (`category`: meme | major | stonk | stable | other — src/lib/category.ts, Jupiter tags for the unknown ones).
// `cat=stonk` also merges Jupiter's own search, filtered to tokenized stocks, so typing TSLA finds TSLAx / TSLAon even when Birdeye
// ranks them under the copycats. Powers the type-ahead in the list box on /new. No key -> { tokens: [] } with 200.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { memo } from "./_lib/memo.js";
import { classifyMany, jupSearch } from "./_lib/category.js";
import { parseCat, type Cat, type Category } from "../src/lib/category.js";

const BIRDEYE = "https://public-api.birdeye.so/defi/v3/search";
const LIMIT = 8;

export type Hit = {
  mint: string;
  symbol: string;
  name: string;
  logo: string | null;
  price: number | null;
  mc: number | null;
  liq: number | null;
  vol24: number | null;
  chg24: number | null; // percent
  verified: boolean;
  pump: boolean;
  category: Category;
};
export type Payload = { q: string; cat: Cat | null; tokens: Hit[]; error?: string };

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x !== "" && Number.isFinite(Number(x)) ? Number(x) : null);

type Raw = Omit<Hit, "category">;
async function search(key: string, q: string): Promise<Raw[]> {
  const u = `${BIRDEYE}?chain=solana&keyword=${encodeURIComponent(q)}&target=token&sort_by=volume_24h_usd&sort_type=desc&offset=0&limit=${LIMIT}`;
  const r = await fetch(u, { headers: { "X-API-KEY": key, "x-chain": "solana", accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`birdeye ${r.status}`);
  const j: any = await r.json();
  const items: any[] = j?.data?.items ?? [];
  const rows: any[] = items.find((i) => i?.type === "token")?.result ?? [];
  const out: Raw[] = [];
  for (const t of rows) {
    const mint = typeof t?.address === "string" ? t.address : null;
    if (!mint) continue;
    out.push({
      mint,
      symbol: String(t.symbol ?? "").slice(0, 16),
      name: String(t.name ?? "").slice(0, 48),
      logo: typeof t.logo_uri === "string" && /^https?:\/\//.test(t.logo_uri) ? t.logo_uri : null,
      price: num(t.price),
      mc: num(t.market_cap) ?? num(t.fdv),
      liq: num(t.liquidity),
      vol24: num(t.volume_24h_usd),
      chg24: num(t.price_change_24h_percent),
      verified: t.verified === true,
      pump: mint.endsWith("pump"),
    });
  }
  return out;
}

/** Birdeye hits classified; for stonk queries, Jupiter's stock hits merged in (same shape, Jupiter's numbers), by 24h volume. */
async function hits(key: string, q: string, cat: Cat | null): Promise<Hit[]> {
  const [raw, jup] = await Promise.all([search(key, q), cat === "stonk" ? jupSearch(q).catch(() => []) : Promise.resolve([])]);
  const rows: Raw[] = [...raw];
  const seen = new Set(raw.map((h) => h.mint));
  for (const t of jup) {
    if (seen.has(t.mint) || !t.verified) continue;
    seen.add(t.mint);
    rows.push({ mint: t.mint, symbol: t.symbol.slice(0, 16), name: t.name.slice(0, 48), logo: t.icon, price: t.price, mc: t.mc, liq: t.liq, vol24: t.vol24, chg24: t.chg24, verified: true, pump: t.mint.endsWith("pump") });
  }
  const cats = await classifyMany([...rows, ...jup.map((t) => ({ mint: t.mint, symbol: t.symbol, name: t.name, tags: t.tags }))]).catch(() => new Map<string, Category>());
  const out = rows.map((h): Hit => ({ ...h, category: cats.get(h.mint) ?? "other" }));
  // a stonk search is a stonk search: Birdeye's copycats drop out, the real issuers rise
  const kept = cat === "stonk" ? out.filter((h) => h.category === "stonk") : out;
  return kept.sort((a, b) => (b.vol24 ?? 0) - (a.vol24 ?? 0)).slice(0, cat === "stonk" ? LIMIT : kept.length);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const raw = typeof req.query.q === "string" ? req.query.q : "";
  const q = raw.trim().slice(0, 48);
  const cat = parseCat(typeof req.query.cat === "string" ? req.query.cat : null);
  res.setHeader("cache-control", "public, max-age=30, s-maxage=120, stale-while-revalidate=600");
  if (q.length < 2) return res.status(200).json({ q, cat, tokens: [] } satisfies Payload);
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) return res.status(200).json({ q, cat, tokens: [], error: "BIRDEYE_API_KEY not configured" } satisfies Payload);
  try {
    const tokens = await memo<Hit[]>(`search:${cat ?? "all"}:${q.toLowerCase()}`, 120_000, 600_000, () => hits(key, q, cat));
    return res.status(200).json({ q, cat, tokens } satisfies Payload);
  } catch (e) {
    return res.status(200).json({ q, cat, tokens: [], error: e instanceof Error ? e.message : String(e) } satisfies Payload);
  }
}
