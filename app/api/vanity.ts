// POST /api/vanity?n=2  -> { keys: [{ pubkey, secret, vanity }], prefix }   fresh 1oox mint keypairs for the caller to sign with
// GET  /api/vanity?stock -> grinder stockpile counts (no secrets)
// Each POST pops keys from the shared stockpile, so it is rate-limited per IP and capped at 4 keys per call.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { VANITY_PREFIX, vanityKeypairs, vanityStock } from "./_lib/vanity.js";

const MAX = 4;
const hits = new Map<string, { n: number; at: number }>();
const WINDOW_MS = 60_000;
const PER_WINDOW = 12; // keys per IP per minute — a listing needs 2-3, a pump pair 2

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("cache-control", "no-store");
  if (req.method === "GET") {
    if ("stock" in (req.query ?? {})) return res.status(200).json({ prefix: VANITY_PREFIX, stock: await vanityStock() });
    return res.status(200).json({ prefix: VANITY_PREFIX, usage: "POST /api/vanity?n=2" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });
  const n = Math.max(1, Math.min(MAX, Number(req.query.n ?? 1) || 1));
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "?").split(",")[0].trim();
  const now = Date.now();
  const h = hits.get(ip);
  const used = h && now - h.at < WINDOW_MS ? h.n : 0;
  if (used + n > PER_WINDOW) return res.status(429).json({ error: "slow down" });
  hits.set(ip, { n: used + n, at: h && now - h.at < WINDOW_MS ? h.at : now });
  const keys = await vanityKeypairs(n);
  return res.status(200).json({ prefix: VANITY_PREFIX, keys });
}
