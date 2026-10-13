// Server copy of the bag page's cost-basis math (app/src/lib/pnl.ts), for the share cards. Units: r-fstacc UI amounts.
import type { Ev } from "./feed.js";

export type Basis = { inQ: number; outQ: number; tokIn: number; tokOut: number; first: number; last: number; n: number };

export function basisFor(evs: Ev[], actor: string, market: string, side: 0 | 1): Basis | null {
  let b: Basis | null = null;
  for (const e of evs) {
    if (e.actor !== actor || e.market !== market || e.side !== side) continue;
    if (e.kind !== "buy" && e.kind !== "sell" && e.kind !== "redeem") continue;
    b ??= { inQ: 0, outQ: 0, tokIn: 0, tokOut: 0, first: e.ts, last: e.ts, n: 0 };
    const q = Number(e.quote ?? 0) / 1e9;
    const t = e.tokens ?? 0;
    if (e.kind === "buy") {
      b.inQ += q;
      b.tokIn += t;
    } else {
      b.outQ += q;
      b.tokOut += t;
    }
    b.first = Math.min(b.first, e.ts);
    b.last = Math.max(b.last, e.ts);
    b.n++;
  }
  return b;
}

export type Pnl = { cost: number; realized: number; unrealized: number; ret: number; days: number; apr: number | null; apy: number | null };
const YEAR = 365.25;

export function positionPnl(b: Basis | null, heldTokens: number, value: number, now: number): Pnl | null {
  if (!b || b.inQ <= 0 || b.tokIn <= 0) return null;
  const cpt = b.inQ / b.tokIn;
  const soldCost = Math.min(b.inQ, cpt * b.tokOut);
  const realized = b.outQ - soldCost;
  const heldCost = Math.max(0, Math.min(b.inQ - soldCost, cpt * heldTokens));
  const unrealized = value - heldCost;
  const ret = (realized + unrealized) / b.inQ;
  const days = Math.max(0, (now - b.first) / 86400);
  const ok = days >= 1 / 24;
  const apr = ok ? ret * (YEAR / days) : null;
  const apy = ok ? (1 + ret <= 0 ? -1 : Math.pow(1 + ret, YEAR / days) - 1) : null;
  return { cost: b.inQ, realized, unrealized, ret, days, apr, apy };
}

export function fmtPct(x: number | null): string {
  if (x === null || Number.isNaN(x)) return "—";
  if (x > 99.99) return ">9,999%";
  if (x < -99.99) return "<−9,999%";
  const pct = Math.abs(x * 100);
  const digits = pct >= 100 ? 0 : pct >= 10 ? 1 : 2;
  return `${x < 0 ? "−" : "+"}${pct.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })}%`;
}

export function fmtAge(days: number): string {
  if (days < 1 / 24) return `${Math.max(1, Math.round(days * 1440))} min`;
  if (days < 1) return `${Math.round(days * 24)} h`;
  if (days < 60) return `${days.toFixed(days < 10 ? 1 : 0)} d`;
  return `${(days / 30.44).toFixed(1)} mo`;
}
