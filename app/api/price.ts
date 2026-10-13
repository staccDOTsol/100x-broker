// SOL/USD for display. Jupiter first, CoinGecko fallback; CDN-cached 30 s.
import type { VercelRequest, VercelResponse } from "@vercel/node";

const SOL = "So11111111111111111111111111111111111111112";
async function jup(): Promise<number> {
  const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL}`, { signal: AbortSignal.timeout(5000) });
  const j: any = await r.json();
  const p = Number(j?.[SOL]?.usdPrice ?? j?.data?.[SOL]?.price);
  if (!Number.isFinite(p) || p <= 0) throw new Error("no jup price");
  return p;
}
async function gecko(): Promise<number> {
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(5000) });
  const j: any = await r.json();
  const p = Number(j?.solana?.usd);
  if (!Number.isFinite(p) || p <= 0) throw new Error("no gecko price");
  return p;
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const solUsd = await jup().catch(gecko);
    res.setHeader("cache-control", "public, max-age=15, s-maxage=30, stale-while-revalidate=120").json({ solUsd, at: Date.now() });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : "price unavailable" });
  }
}
