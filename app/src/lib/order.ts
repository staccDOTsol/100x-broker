// Market ordering and siblings, shared by the board and the market switcher. Anyone can list a market, and several markets can
// sit on one coin (another oracle pool, venue, quote or TWAP window): those are siblings, shown together, never deduped away.
// The sort lives in the URL (?sort=volume|oldest|newest|disparity) so a shared link opens on the same order.
import type { MarketView } from "./chain";
import type { MarketStat } from "./feed";
import { VENUE_LABEL } from "./venues";
import { useQuery } from "./url";
import { MEME_MINT } from "../config";

export type Sort = "volume" | "oldest" | "newest" | "disparity";
export const SORTS: { id: Sort; label: string; hint: string }[] = [
  { id: "volume", label: "Volume", hint: "Most SOL traded in the last 24h first" },
  { id: "newest", label: "Newest", hint: "Most recently listed first" },
  { id: "oldest", label: "Oldest", hint: "First listed first" },
  { id: "disparity", label: "Disparity", hint: "Most lopsided pots first: the thin side pays the most" },
];
const parseSort = (s: string | null): Sort => (SORTS.some((x) => x.id === s) ? (s as Sort) : "volume");

/** The board's order, read from and written to ?sort=. Volume when the URL says nothing. */
export function useSort(): [Sort, (s: Sort) => void] {
  const q = useQuery();
  return [parseSort(q.get("sort")), (s: Sort) => q.set({ sort: s })];
}

const pots = (v: MarketView) => v.side[0].vault + v.side[1].vault;
/** A market on the house coin ($100XBRO, the one 30% of every fee burns): pinned above every sort, for everyone. */
export const isHouse = (v: MarketView) => v.underlyingMint === MEME_MINT.toBase58();
/** House markets first, everything else in the order given (stable). */
const houseFirst = (rows: MarketView[]) => [...rows.filter(isHouse), ...rows.filter((v) => !isHouse(v))];
const byPots = (a: MarketView, b: MarketView) => (pots(b) > pots(a) ? 1 : pots(b) < pots(a) ? -1 : 0);

/** Thick pot ÷ thin pot (≥ 1). Infinity when one side is empty and the other is not; 0 when both pots are empty. */
export function disparity(v: MarketView): number {
  const [u, d] = [Number(v.side[0].vault), Number(v.side[1].vault)];
  if (u <= 0 && d <= 0) return 0;
  if (u <= 0 || d <= 0) return Infinity;
  return Math.max(u, d) / Math.min(u, d);
}
/** The thin side (0 UP, 1 DOWN), the one that pays most; null when the pots are even or both empty. */
export function thinSide(v: MarketView): 0 | 1 | null {
  const [u, d] = [v.side[0].vault, v.side[1].vault];
  if (u === d) return null;
  return u < d ? 0 : 1;
}
/** "4.2 : 1", "one-sided", "even" or "empty". */
export function disparityLabel(v: MarketView): string {
  const x = disparity(v);
  if (x === 0) return "empty";
  if (!Number.isFinite(x)) return "one-sided";
  if (x < 1.05) return "even";
  return `${x >= 100 ? Math.round(x).toLocaleString() : x.toFixed(x < 10 ? 1 : 0)} : 1`;
}

const vol = (s: MarketStat | undefined) => (s?.vol ? BigInt(s.vol) : -1n);

/**
 * Markets in the chosen order. `stats` (api/leaders?markets=24) carries volume and listing time; without it, volume / oldest / newest
 * can't be known, so those fall back to the biggest pots first and `ok` is false (the caller says so instead of pretending).
 */
export function sortMarkets(views: MarketView[], stats: Map<string, MarketStat> | null | undefined, sort: Sort): { rows: MarketView[]; ok: boolean } {
  const st = (v: MarketView) => stats?.get(v.acct.key.toBase58());
  const rows = [...views];
  if (sort === "disparity") {
    rows.sort((a, b) => {
      const x = disparity(a), y = disparity(b);
      return x === y ? byPots(a, b) : y > x ? 1 : -1;
    });
    return { rows: houseFirst(rows), ok: true };
  }
  if (!stats) return { rows: houseFirst(rows.sort(byPots)), ok: false };
  if (sort === "volume") rows.sort((a, b) => (vol(st(b)) > vol(st(a)) ? 1 : vol(st(b)) < vol(st(a)) ? -1 : byPots(a, b)));
  else {
    // a null birth means "older than the server scans": the oldest of all
    const born = (v: MarketView) => st(v)?.born ?? 0;
    rows.sort((a, b) => (sort === "oldest" ? born(a) - born(b) : born(b) - born(a)) || byPots(a, b));
  }
  return { rows: houseFirst(rows), ok: true };
}

export type Group = { lead: MarketView; siblings: MarketView[] };
const pool = (v: MarketView) => v.acct.oraclePool.toBase58();
/**
 * Markets grouped with their siblings (same coin, or the same oracle pool: SOL/USDC and USDC/SOL read one pool), in the order
 * given: a group sits where its best-ranked member sits, and the members keep their order inside it.
 */
export function siblingGroups(sorted: MarketView[]): Group[] {
  // union-find over "same coin" and "same pool"
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    const p = parent.get(k) ?? k;
    if (p === k) return k;
    const r = find(p);
    parent.set(k, r);
    return r;
  };
  const join = (a: string, b: string) => {
    const x = find(a), y = find(b);
    if (x !== y) parent.set(y, x);
  };
  for (const v of sorted) join(`c:${v.underlyingMint}`, `p:${pool(v)}`);
  const by = new Map<string, Group>();
  const out: Group[] = [];
  for (const v of sorted) {
    const root = find(`c:${v.underlyingMint}`);
    const g = by.get(root);
    if (g) g.siblings.push(v);
    else {
      const n = { lead: v, siblings: [] };
      by.set(root, n);
      out.push(n);
    }
  }
  return out;
}
/** How `v` relates to `lead`: the same coin (another pool, quote or window), or the same oracle pool read from the other side. */
export const relation = (v: MarketView, lead: MarketView) =>
  v.underlyingMint === lead.underlyingMint ? "same coin" : pool(v) === pool(lead) ? "same oracle pool" : "via a sibling";

/** Every other market on the same coin or reading the same oracle pool. */
export const siblingsOf = (v: MarketView, all: MarketView[]) =>
  all.filter((o) => o !== v && o.acct.key.toBase58() !== v.acct.key.toBase58() && (o.underlyingMint === v.underlyingMint || o.acct.oraclePool.equals(v.acct.oraclePool)));

/** The TWAP window as people say it: "2-obs" for window 1 (two observations), else minutes. */
export const windowLabel = (secs: number) => (secs <= 1 ? "2-obs TWAP" : secs < 120 ? `${secs}s TWAP` : `${Math.round(secs / 60)}-min TWAP`);
/** What tells this market apart from its siblings: venue · quote · window (and the pool when two share all three). */
export function marketTag(v: MarketView, all: MarketView[] = []): string {
  const base = `${VENUE_LABEL[v.oracle.venue] ?? v.oracle.venue} · /${v.oracle.quote} · ${windowLabel(v.acct.windowSecs)}`;
  const twin = all.some((o) => o !== v && o.underlyingMint === v.underlyingMint && o.oracle.venue === v.oracle.venue && o.oracle.quote === v.oracle.quote && o.acct.windowSecs === v.acct.windowSecs);
  return twin ? `${base} · pool ${v.acct.oraclePool.toBase58().slice(0, 4)}…` : base;
}

/** "3m", "5h", "2d" since a unix time. */
export function age(born: number | null | undefined, now = Date.now() / 1000): string {
  if (born === null || born === undefined) return "—";
  const s = Math.max(0, now - born);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
