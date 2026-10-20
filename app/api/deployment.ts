import type { VercelRequest, VercelResponse } from "@vercel/node";
import { conn } from "../src/lib/chain.js";
import { deploymentStatus } from "../src/lib/deployment.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  res.setHeader("cache-control", "no-store");
  try {
    return res.json(await deploymentStatus(conn));
  } catch {
    return res.status(503).json({ error: "Program availability could not be verified. Trading is unavailable." });
  }
}
