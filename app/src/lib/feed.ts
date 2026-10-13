export type Ev = {
  sig: string;
  ts: number;
  kind: "buy" | "sell" | "redeem" | "settle" | "claim" | "rebalance" | "listed" | "burn";
  market: string;
  ticker: string;
  actor: string;
  side?: 0 | 1;
  tokens?: number;
  quote?: string;
  paid?: { from: 0 | 1; to: 0 | 1; amount: string };
};
export type Holder = { owner: string; tokens: number; valueUsd: number | null; redeemUsd: number | null; share: number };
export type Board = { market: string; ticker: string; sides: [Holder[], Holder[]]; leverage: [number, number] };
export type Wallet = { owner: string; valueUsd: number; positions: number; biggest: { ticker: string; side: 0 | 1; valueUsd: number } | null };
/** One wallet's trading over a window; `in` / `out` / `net` are r-fstacc raw (1e9), convert with usePrices().quoteSol. */
export type Active = { owner: string; in: string; out: string; net: string; trades: number; markets: number; last: number; top: { market: string; ticker: string; side: 0 | 1; quote: string } | null };

export async function fetchFeed(market?: string, actor?: string, n?: number): Promise<Ev[]> {
  const r = await fetch(`/api/feed${market ? `?m=${market}` : actor ? `?w=${actor}${n ? `&n=${n}` : ""}` : ""}`);
  if (!r.ok) throw new Error("feed unavailable");
  return (await r.json()).events as Ev[];
}
export async function fetchLeaders(market: string): Promise<Board> {
  const r = await fetch(`/api/leaders?m=${market}`);
  if (!r.ok) throw new Error("leaders unavailable");
  return r.json();
}
export async function fetchWallets(): Promise<Wallet[]> {
  const r = await fetch(`/api/leaders`);
  if (!r.ok) throw new Error("leaders unavailable");
  return (await r.json()).wallets as Wallet[];
}
export async function fetchActive(hours = 24): Promise<Active[]> {
  const r = await fetch(`/api/leaders?active=${hours}`);
  if (!r.ok) throw new Error("leaders unavailable");
  return (await r.json()).active as Active[];
}
