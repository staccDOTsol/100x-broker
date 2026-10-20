// POST /api/dnzap  { kind: "in", vault, user, lamports }  -> { steps: [{label, ixs, signers}], note? }
// POST /api/dnzap  { kind: "out", vault, user, amountX }  -> { ixs, minOut }
// Plans the 1-click zaps; the user signs everything, the server signs nothing.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { PublicKey } from "@solana/web3.js";
import { assertProgramAvailable } from "../src/lib/deployment.js";
import { conn } from "../src/lib/chain.js";
import { DN_PROGRAM, planUserSwapOut, planZapIn } from "./_lib/dnplan.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });
  try {
    await assertProgramAvailable(conn, DN_PROGRAM);
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
    const vault = new PublicKey(String(body.vault));
    const user = new PublicKey(String(body.user));
    if (body.kind === "in") {
      const lamports = BigInt(String(body.lamports));
      if (lamports <= 0n) return res.status(400).json({ error: "lamports" });
      return res.setHeader("cache-control", "no-store").json(await planZapIn(user, vault, lamports));
    }
    if (body.kind === "out") {
      const amountX = BigInt(String(body.amountX));
      if (amountX <= 0n) return res.status(400).json({ error: "amountX" });
      return res.setHeader("cache-control", "no-store").json(await planUserSwapOut(user, vault, amountX));
    }
    res.status(400).json({ error: "kind" });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "plan failed" });
  }
}
