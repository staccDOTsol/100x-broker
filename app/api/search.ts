// GET /api/search?q=<text> -> Solana tokens matching a name/symbol (Birdeye v3 search), biggest 24h volume first.
// Powers the type-ahead in the list box on /new: type anything, pick a coin, we fill the mint. No key -> { tokens: [] } with 200.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { memo } from "./_lib/memo.js";

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
};
export type Payload = { q: string; tokens: Hit[]; error?: string };

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x !== "" && Number.isFinite(Number(x)) ? Number(x) : null);

async function search(key: string, q: string): Promise<Hit[]> {
  const u = `${BIRDEYE}?chain=solana&keyword=${encodeURIComponent(q)}&target=token&sort_by=volume_24h_usd&sort_type=desc&offset=0&limit=${LIMIT}`;
  const r = await fetch(u, { headers: { "X-API-KEY": key, "x-chain": "solana", accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`birdeye ${r.status}`);
  const j: any = await r.json();
  const items: any[] = j?.data?.items ?? [];
  const rows: any[] = items.find((i) => i?.type === "token")?.result ?? [];
  const out: Hit[] = [];
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const raw = typeof req.query.q === "string" ? req.query.q : "";
  const q = raw.trim().slice(0, 48);
  res.setHeader("cache-control", "public, max-age=30, s-maxage=120, stale-while-revalidate=600");
  if (q.length < 2) return res.status(200).json({ q, tokens: [] } satisfies Payload);
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) return res.status(200).json({ q, tokens: [], error: "BIRDEYE_API_KEY not configured" } satisfies Payload);
  try {
    const tokens = await memo<Hit[]>(`search:${q.toLowerCase()}`, 120_000, 600_000, () => search(key, q));
    return res.status(200).json({ q, tokens } satisfies Payload);
  } catch (e) {
    return res.status(200).json({ q, tokens: [], error: e instanceof Error ? e.message : String(e) } satisfies Payload);
  }
}
