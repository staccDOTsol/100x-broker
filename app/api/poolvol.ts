// GET /api/poolvol?ids=<pool,pool,...> (max 20) -> { [pool]: { vol24: number|null, liq: number|null } } from Birdeye.
// Fills the 24h volume (and TVL when the venue has none) for PumpSwap pools on /new; the browser has no Birdeye key.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { PublicKey } from "@solana/web3.js";
import { MAX_IDS, poolVolumes } from "./_lib/poolvol.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("cache-control", "public, max-age=60, s-maxage=120, stale-while-revalidate=600");
  const raw = typeof req.query.ids === "string" ? req.query.ids : "";
  const ids: string[] = [];
  for (const s of raw.split(",")) {
    const t = s.trim();
    if (!t) continue;
    try {
      ids.push(new PublicKey(t).toBase58());
    } catch {
      return res.status(400).json({ error: `not a pool address: ${t.slice(0, 48)}` });
    }
  }
  if (!ids.length) return res.status(400).json({ error: "ids=<comma-separated pool addresses>" });
  if (ids.length > MAX_IDS) return res.status(400).json({ error: `at most ${MAX_IDS} ids per call` });
  res.status(200).json(await poolVolumes(ids));
}
