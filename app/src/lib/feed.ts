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

/** One realized win from /api/winners (SOL units; exits converted at today's r-fstacc rate). */
export type Win = {
  sig: string; ts: number; wallet: string; kind: "exit" | "unpark"; market: string; vault?: string; ticker: string; side?: 0 | 1;
  cost_sol: number; out_sol: number; gain_sol: number; ret: number; hold_s: number; per_hour_sol: number | null;
};
export type RaceLeader = { wallet: string; net_sol: number; won_sol: number; lost_sol: number; ref_sol: number; trades: number; best_sol: number; best_sig: string; first: number; last: number };
export type RaceRound = { start: number; end: number; prize_sol: number; prizes_sol: number[]; final: boolean; leaders: RaceLeader[] };
export type Winners = {
  at: number; rate: number; count: number; wallets: number; total_sol: number; exits: number; unparks: number; wins: Win[];
  race?: { rule: string; live: RaceRound | null; last: RaceRound | null; rolling: RaceLeader[] | null };
};
export async function fetchWinners(): Promise<Winners> {
  const r = await fetch("/api/winners");
  if (!r.ok) throw new Error(`winners ${r.status}`);
  return r.json();
}

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
