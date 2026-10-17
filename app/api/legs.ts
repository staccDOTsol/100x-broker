// POST /api/legs { wallet?, hops: [{inputMint, outputMint, inAmount, outAmount, label?}], badBeat?, ref?, build?, only? }
//   only: [mints] builds just the legs betting on those coins (after their listing landed), and no listings;
//   markets: [the listed market addresses] so the new markets are read from chain, not the cached snapshot.
//   -> the swap's 100× legs (api/_lib/legs.ts): per hop, 10 bp of the hop's SOL value split into a 100× long on what it
//      bought and a 100× short on what it sold (badBeat flips), plus listing transactions for any coin without a market.
//   build:false (default) prices and maps only; build:true with a wallet also returns unsigned transactions.
// The server signs nothing but the throwaway config/mint keys of a new listing.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { planLegs, type HopIn } from "./_lib/legs.js";

const b58 = (s: unknown): s is string => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const raw = (s: unknown): s is string => typeof s === "string" && /^[0-9]{1,39}$/.test(s);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
    const hops: HopIn[] = Array.isArray(body.hops) ? body.hops : [];
    if (!hops.length || hops.length > 8) return res.status(400).json({ error: "hops: 1 to 8 route hops" });
    for (const h of hops) {
      if (!b58(h?.inputMint) || !b58(h?.outputMint) || !raw(h?.inAmount) || !raw(h?.outAmount)) return res.status(400).json({ error: "each hop needs inputMint, outputMint, inAmount, outAmount" });
    }
    if (body.wallet !== undefined && body.wallet !== null && !b58(body.wallet)) return res.status(400).json({ error: "wallet" });
    if (body.ref !== undefined && body.ref !== null && !b58(body.ref)) return res.status(400).json({ error: "ref" });
    const only = Array.isArray(body.only) ? body.only.filter(b58).slice(0, 16) : null;
    const markets = Array.isArray(body.markets) ? body.markets.filter(b58).slice(0, 16) : null;
    // orders: ["<market>:<0|1>"] rebuilds just those merged orders (retrying bets that did not land)
    const orders = Array.isArray(body.orders) ? body.orders.filter((o: unknown) => typeof o === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}:[01]$/.test(o)).slice(0, 16) : null;
    const plan = await planLegs({ wallet: body.wallet ?? null, hops, badBeat: body.badBeat === true || body.badBeat === 1 || body.badBeat === "1", ref: body.ref ?? null, build: body.build === true, only, markets, orders });
    res.setHeader("cache-control", "no-store").json(plan);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "legs failed" });
  }
}
