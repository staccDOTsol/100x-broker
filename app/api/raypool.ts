// /api/raypool?id=<clmm pool> -> { day, week, tvl, feeRate } fee APRs from Raydium's API (cached at the edge).
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const id = String(req.query.id ?? "");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id)) return res.status(400).json({ error: "bad id" });
  try {
    const r = await fetch(`https://api-v3.raydium.io/pools/info/ids?ids=${id}`);
    const j = (await r.json()) as { data?: { day?: { apr?: number }; week?: { apr?: number }; tvl?: number; feeRate?: number }[] };
    const p = j.data?.[0];
    if (!p) return res.status(404).json({ error: "pool not found" });
    res
      .setHeader("cache-control", "public, max-age=60, s-maxage=600, stale-while-revalidate=3600")
      .json({ day: p.day?.apr ?? 0, week: p.week?.apr ?? 0, tvl: p.tvl ?? 0, feeRate: p.feeRate ?? 0 });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "raydium failed" });
  }
}
