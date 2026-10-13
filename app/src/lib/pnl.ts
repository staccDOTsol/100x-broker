// Cost basis and P&L for a wallet's sides, from its own feed (buys / sells / cash-outs), plus simple and compounded annualisation.
// Units: r-fstacc (the stake-pool token the pots and curves settle in), UI amounts; the pages turn them into USD with px.priceUsd.
import type { Ev } from "./feed";

export type Basis = { inQ: number; outQ: number; tokIn: number; tokOut: number; first: number; last: number; n: number };

/** Per `${market}:${side}`: what this wallet paid in, took out, and how many tokens moved each way. */
export function basisByPosition(evs: Ev[], actor: string): Map<string, Basis> {
  const m = new Map<string, Basis>();
  for (const e of evs) {
    if (e.actor !== actor || e.side === undefined) continue;
    if (e.kind !== "buy" && e.kind !== "sell" && e.kind !== "redeem") continue;
    const k = `${e.market}:${e.side}`;
    const b = m.get(k) ?? { inQ: 0, outQ: 0, tokIn: 0, tokOut: 0, first: e.ts, last: e.ts, n: 0 };
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
    m.set(k, b);
  }
  return m;
}

export type Pnl = {
  cost: number; // total paid in
  realized: number; // taken out minus the cost of what was sold
  unrealized: number; // what's held now minus what it cost
  ret: number; // (realized + unrealized) / cost
  days: number; // since the first buy
  apr: number | null; // simple annualised return
  apy: number | null; // compounded annualised return
};

const YEAR = 365.25;

/** Simple and compounded annualisation of a return earned over `days`. Under an hour it is noise, so null. */
export function annualize(ret: number, days: number): { apr: number | null; apy: number | null } {
  if (!(days >= 1 / 24)) return { apr: null, apy: null };
  const apr = ret * (YEAR / days);
  const apy = 1 + ret <= 0 ? -1 : Math.pow(1 + ret, YEAR / days) - 1;
  return { apr, apy };
}

/** Average cost basis: realized on what was sold, unrealized on what is still held (valued at `value`). */
export function positionPnl(b: Basis | undefined, heldTokens: number, value: number, now: number): Pnl | null {
  if (!b || b.inQ <= 0 || b.tokIn <= 0) return null;
  const cpt = b.inQ / b.tokIn;
  const soldCost = Math.min(b.inQ, cpt * b.tokOut);
  const realized = b.outQ - soldCost;
  const heldCost = Math.max(0, Math.min(b.inQ - soldCost, cpt * heldTokens));
  const unrealized = value - heldCost;
  const ret = (realized + unrealized) / b.inQ;
  const days = Math.max(0, (now - b.first) / 86400);
  return { cost: b.inQ, realized, unrealized, ret, days, ...annualize(ret, days) };
}

/** The bag as one position: sums, and a cost-weighted holding period. */
export function aggregatePnl(items: (Pnl | null | undefined)[]): Pnl | null {
  const xs = items.filter((x): x is Pnl => !!x);
  if (!xs.length) return null;
  const cost = xs.reduce((s, x) => s + x.cost, 0);
  if (cost <= 0) return null;
  const realized = xs.reduce((s, x) => s + x.realized, 0);
  const unrealized = xs.reduce((s, x) => s + x.unrealized, 0);
  const days = xs.reduce((s, x) => s + x.days * x.cost, 0) / cost;
  const ret = (realized + unrealized) / cost;
  return { cost, realized, unrealized, ret, days, ...annualize(ret, days) };
}

/** "+12.3%", "−4.1%", ">9,999%" — annualised numbers explode on young positions, so they are capped, not hidden. */
export function fmtAnnual(x: number | null): string {
  if (x === null || Number.isNaN(x)) return "—";
  if (x > 99.99) return ">9,999%";
  if (x < -99.99) return "<−9,999%"; // a simple annualisation can run far past −100%; the compounded one bottoms out at −100%
  const pct = Math.abs(x * 100);
  const digits = pct >= 100 ? 0 : pct >= 10 ? 1 : 2;
  return `${x < 0 ? "−" : "+"}${pct.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })}%`;
}

export function fmtAge(days: number): string {
  if (days < 1 / 24) return `${Math.max(1, Math.round(days * 1440))} min`;
  if (days < 1) return `${Math.round(days * 24)} h`;
  if (days < 60) return `${days.toFixed(days < 10 ? 1 : 0)} d`;
  return `${(days / 30.44).toFixed(1)} mo`;
}
