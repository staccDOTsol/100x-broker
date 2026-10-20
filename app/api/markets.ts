// GET /api/markets -> every market view, exactly what the browser's loadMarketView() returns, as tagged JSON (see src/lib/views.ts).
// Edge-cached 10 s: one upstream load serves every open tab.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { PROGRAM_ID } from "../src/config.js";
import { allViews, encode } from "./_lib/views.js";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const v = await allViews();
    res.setHeader("cache-control", "public, max-age=5, s-maxage=10, stale-while-revalidate=60").setHeader("content-type", "application/json").send(encode({ at: Date.now(), programId: PROGRAM_ID.toBase58(), markets: v }));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "markets failed" });
  }
}
