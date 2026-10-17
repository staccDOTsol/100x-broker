// Market views from the server snapshot (/api/markets) instead of ~80 RPC calls per tab: same MarketView objects, revived.
import { PublicKey } from "@solana/web3.js";
import type { MarketView } from "./chain";

const revive = (_k: string, v: unknown) => {
  if (v && typeof v === "object") {
    const o = v as Record<string, string>;
    if ("$b" in o) return BigInt(o.$b);
    if ("$p" in o) return new PublicKey(o.$p);
    if ("$u" in o) return Uint8Array.from(atob(o.$u), (c) => c.charCodeAt(0));
  }
  return v;
};

/** Every market, newest server snapshot (≤10 s old). Throws when the server can't reach the chain; callers keep their last good value. */
export async function fetchViews(): Promise<MarketView[]> {
  const r = await fetch("/api/markets");
  if (!r.ok) throw new Error(`markets ${r.status}`);
  const j = JSON.parse(await r.text(), revive) as { at: number; markets: MarketView[] };
  // JSON has no NaN or Infinity: both arrive as null. The pots tell them apart, the same way loadMarketView computed them:
  // an empty side facing a full one pays without limit (Infinity); two empty pots have no payout yet (NaN).
  for (const m of j.markets)
    for (const [i, s] of m.side.entries())
      if (s.leverage === null || s.leverage === undefined) s.leverage = s.vault === 0n && m.side[1 - i].vault > 0n ? Infinity : NaN;
  return j.markets;
}
