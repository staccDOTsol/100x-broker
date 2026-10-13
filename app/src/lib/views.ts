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
  return j.markets;
}
