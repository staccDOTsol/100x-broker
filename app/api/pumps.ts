// GET /api/pumps?market=<key> -> a market's companion pump.fun coins ($TICKERUP / $TICKERDN, quoted in $100XBRO), read on chain:
// the two Launch PDAs, then each coin's bonding curve (virtual reserves -> price in $100XBRO, market cap, progress, complete).
// Two RPC calls per request, edge-cached 15 s.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { PublicKey } from "@solana/web3.js";
import { conn } from "../src/lib/chain.js";
import { PROGRAM_ID } from "../src/config.js";
import { decodeLaunch, launchPda, pumpCurvePda } from "../src/lib/hooked.js";
import { curveStats, feeSharingConfigPda, pumpUrl, type CurveStats } from "../src/lib/pump.js";

export type PumpSide = CurveStats & { launch: string; lister: string; mode: number; sharingConfig: string; url: string };
export type PumpsPayload = { market: string; up: PumpSide | null; down: PumpSide | null; quote: string };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const market = new PublicKey(String(req.query.market ?? ""));
    const pdas = [launchPda(market, 0), launchPda(market, 1)];
    const infos = await conn.getMultipleAccountsInfo(pdas);
    const launches = infos.map((i, s) => (i && i.owner.equals(PROGRAM_ID) ? decodeLaunch(pdas[s], i.data) : null));
    const live = launches.filter((l): l is NonNullable<typeof l> => !!l);
    const curves = live.length ? await conn.getMultipleAccountsInfo(live.map((l) => pumpCurvePda(l.mint))) : [];
    const side = (s: 0 | 1): PumpSide | null => {
      const l = launches[s];
      if (!l) return null;
      const c = curves[live.indexOf(l)];
      if (!c) return null;
      return { ...curveStats(l.mint, c), launch: l.key.toBase58(), lister: l.lister.toBase58(), mode: l.mode, sharingConfig: feeSharingConfigPda(l.mint).toBase58(), url: pumpUrl(l.mint) };
    };
    const out: PumpsPayload = { market: market.toBase58(), up: side(0), down: side(1), quote: "100XBRO" };
    res.setHeader("cache-control", "public, max-age=5, s-maxage=15, stale-while-revalidate=60").json(out);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "pumps failed" });
  }
}
