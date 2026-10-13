// /api/leaders               -> top wallets across all markets (by value at curve)
// /api/leaders?m=<market>    -> top UP and DOWN holders of one market
// /api/leaders?active=<hours> -> most active wallets over the last 1–168 h (buys, sells, cash-outs), closed positions included
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { PublicKey } from "@solana/web3.js";
import { activeWallets, globalLeaders, marketLeaders } from "./_lib/feed.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const m = req.query.m ? new PublicKey(String(req.query.m)) : null;
    const hours = req.query.active !== undefined ? Math.min(168, Math.max(1, Number(req.query.active) || 24)) : null;
    const body = m ? await marketLeaders(m) : hours ? { active: await activeWallets(hours), hours } : { wallets: await globalLeaders() };
    res.setHeader("cache-control", "public, max-age=15, s-maxage=30, stale-while-revalidate=120").json(body);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "leaders failed" });
  }
}
