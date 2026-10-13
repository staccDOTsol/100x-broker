import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CACHE, getAsset } from "./_lib/das.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const a = await getAsset(String(req.query.mint ?? ""));
    res.setHeader("cache-control", CACHE).json(a);
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : "lookup failed" });
  }
}
