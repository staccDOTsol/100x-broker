// Token metadata JSON for an UP/DOWN mint, derived entirely from the underlying via DAS.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CACHE, derived, getAsset, sideOf } from "./_lib/das.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const mint = String(req.query.mint ?? "");
  const side = sideOf(req.query.s);
  const origin = `https://${req.headers["x-forwarded-host"] ?? req.headers.host ?? "100x.broker"}`;
  try {
    const a = await getAsset(mint);
    const d = derived(a, side);
    res.setHeader("cache-control", CACHE).json({
      name: d.name,
      symbol: d.symbol,
      description:
        side === "up"
          ? `Gains 100x power when ${a.name} rises against SOL: every move of the TWAP makes the DOWN vault pay the UP vault. Redeemable for its vault share. 100x.broker`
          : `Gains 100x power when ${a.name} falls against SOL: every move of the TWAP makes the UP vault pay the DOWN vault. Redeemable for its vault share. 100x.broker`,
      image: `${origin}/api/img?mint=${mint}&s=${side}`,
      external_url: `${origin}`,
      attributes: [
        { trait_type: "underlying", value: a.symbol },
        { trait_type: "side", value: side.toUpperCase() },
        { trait_type: "leverage", value: "100x power" },
        { trait_type: "quote", value: "r-fstacc" },
      ],
    });
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : "lookup failed" });
  }
}
