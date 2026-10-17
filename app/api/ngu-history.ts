// /api/ngu-history — SOL per $NGU after every transaction that moved it, launch to now (see _lib/nguHistory.ts).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { NGU } from "../src/ngu.js";
import { nguHistory } from "./_lib/nguHistory.js";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  if (!NGU.mint || !NGU.stakePool || !NGU.state) return res.status(404).json({ error: "NGU not launched" });
  try {
    const h = await nguHistory();
    res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=300");
    return res.status(200).json({ points: h.points });
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
