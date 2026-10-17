import { minNextBid, payoff, phase, stateTag, TEAMS, type WarGame } from "./war.js";

export type WarAsset = { mint: string | null; symbol: string; decimals: number; usd: number | null; image: string | null };
export type WarAmount = { raw: string; units: number; usd: number | null };

/** The same public game view for HTTP snapshots and decoded WebSocket updates. */
export function toWarView(g: WarGame, a: WarAsset, now = Math.floor(Date.now() / 1000)) {
  const units = (raw: bigint) => Number(raw) / 10 ** a.decimals;
  const amt = (raw: bigint) => ({ raw: raw.toString(), units: units(raw), usd: a.usd === null ? null : units(raw) * a.usd });
  const ph = phase(g, now);
  return {
    id: g.id, key: g.key.toBase58(), phase: ph, now, tag: stateTag(g),
    asset: a,
    pot: amt(g.pot), lastBid: amt(g.lastBid), minNext: amt(minNextBid(g)), minBid: amt(g.minBid),
    winnerTakes: amt((g.pot * BigInt(g.pct.winner)) / 10_000n), referrerTakes: amt((g.pot * BigInt(g.pct.referrer)) / 10_000n),
    payoffs: [0, 1, 2].map((t) => { const p = payoff(g, minNextBid(g), t); return { team: TEAMS[t], win: amt(p.win), multiple: p.multiple }; }),
    payoff: (() => { const p = payoff(g, minNextBid(g), 1); return { win: amt(p.win), multiple: p.multiple }; })(),
    deadline: g.deadline, secondsLeft: g.deadline ? Math.max(0, g.deadline - now) : null,
    roundSecs: g.roundSecs, antiSnipeSecs: g.antiSnipeSecs, antiSnipeExtendSecs: g.antiSnipeExtendSecs,
    pct: g.pct, bids: g.totalBids, keys: g.totalKeys,
    leader: g.totalBids ? g.lastBidder.toBase58() : null, leaderReferrer: g.lastReferrer?.toBase58() ?? null,
    lastTeam: g.totalBids ? TEAMS[g.lastTeam] ?? null : null,
    teams: { Bull: g.teamBids[0], Snek: g.teamBids[1], Bear: g.teamBids[2] },
    creator: g.creator.toBase58(), dev: g.dev.toBase58(), over: g.over,
  };
}

export type WarView = ReturnType<typeof toWarView>;
export type WarClientView = WarView & {
  me?: { keys: number; owed: WarAmount; tokenBalance: WarAmount | null; solBalance: number } | null;
  thread?: string | null;
  featured?: number;
};
