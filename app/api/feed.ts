// /api/feed            -> latest events across all markets
// /api/feed?m=<market> -> latest events for one market
// /api/feed?w=<wallet> -> one wallet's moves across every market
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { PublicKey } from "@solana/web3.js";
import { globalFeed, marketFeed, walletFeed } from "./_lib/feed.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const m = req.query.m ? new PublicKey(String(req.query.m)) : null;
    const w = req.query.w ? new PublicKey(String(req.query.w)) : null;
    const n = Math.min(200, Math.max(1, Number(req.query.n) || 40)); // a wallet's cost basis needs its whole history, not the last 40 moves
    const events = w ? await walletFeed(w, n) : m ? await marketFeed(m, 40) : await globalFeed(15);
    res.setHeader("cache-control", "public, max-age=5, s-maxage=8, stale-while-revalidate=60").json({ events, at: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "feed failed" });
  }
}
