// /api/raypool?id=<clmm pool> -> { day, week, tvl, feeRate } fee APRs from Raydium's API (cached at the edge).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { memo } from "./_lib/memo.js";

type Pool = { day?: { apr?: number }; week?: { apr?: number }; tvl?: number; feeRate?: number };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const id = String(req.query.id ?? "");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id)) return res.status(400).json({ error: "bad id" });
  try {
    const p = await memo<Pool | null>(`raypool:${id}`, 60_000, 600_000, async () => {
      const r = await fetch(`https://api-v3.raydium.io/pools/info/ids?ids=${id}`);
      const j = (await r.json()) as { data?: Pool[] };
      return j.data?.[0] ?? null;
    });
    if (!p) return res.status(404).json({ error: "pool not found" });
    res
      .setHeader("cache-control", "public, max-age=60, s-maxage=600, stale-while-revalidate=3600")
      .json({ day: p.day?.apr ?? 0, week: p.week?.apr ?? 0, tvl: p.tvl ?? 0, feeRate: p.feeRate ?? 0 });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "raydium failed" });
  }
}
