import type { VercelRequest, VercelResponse } from "@vercel/node";
import { allViews } from "./_lib/views.js";
import { createDflowService, DflowError } from "./_lib/dflow.js";

const dflow = createDflowService({
  // Explicitly authorized developer endpoint until production credentials are supplied.
  developerMode: !process.env.DFLOW_API_KEY?.trim(),
  apiKey: () => process.env.DFLOW_API_KEY,
  activeSideMints: async () => new Set((await allViews()).flatMap((view) => [view.acct.bullMint.toBase58(), view.acct.bearMint.toBase58()])),
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("cache-control", "no-store");
  if (req.method === "GET" && req.query.status === "1") return res.json({ provider: "DFlow", configured: dflow.configured() });
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).setHeader("allow", "GET, POST").json({ error: "GET or POST only.", code: "METHOD_NOT_ALLOWED" });
  try {
    let request: unknown = req.query;
    if (req.method === "POST") {
      try { request = typeof req.body === "string" ? JSON.parse(req.body) : req.body; }
      catch { return res.status(400).json({ error: "Provide a valid JSON swap request.", code: "INVALID_REQUEST" }); }
    }
    return res.json(await dflow.order(request, req.method === "POST"));
  } catch (error) {
    if (error instanceof DflowError) return res.status(error.status).json({ error: error.message, code: error.code });
    return res.status(500).json({ error: "DFlow trading is temporarily unavailable.", code: "DFLOW_UNAVAILABLE" });
  }
}
