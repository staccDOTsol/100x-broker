// The trading-terminal pieces shared by the board, the market page and the leaderboard: the oracle chart (our wordmark behind
// the line, range chips, live trade chips floating on it), "your PnL", the house rules, wallet avatars and the market sort chips.
// Everything is drawn from polled data (/api/markets, /api/feed, /api/winners, /api/leaders); nothing is simulated.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import type { MarketView } from "../lib/chain";
import { fetchActive, fetchFeed, fetchWinners, type Ev, type MarketStat, type Win } from "../lib/feed";
import { age, relation, siblingGroups, siblingsOf, sortMarkets, SORTS, windowLabel, type Sort } from "../lib/order";
import { useUnderlying } from "../hooks/underlying";
import { usd, usdShort, lev, short } from "../lib/format";
import { usePoll } from "../hooks";
import { usePrices } from "../hooks/price";
import { OraclePrice, WalletButton } from "./bits";
import { Delta, Flash } from "./Pulse";

const SIDE = ["UP", "DOWN"] as const;
const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------- market header

const spanLabel = (secs: number) => (secs >= 5400 ? `${Math.round(secs / 3600)}h` : `${Math.max(1, Math.round(secs / 60))}m`);
/** The best payout on offer right now: the thin side's leverage (">10,000×" when a pot is empty, "—" when nobody's in). */
export const bestLev = (v: MarketView) => {
  const xs = v.side.map((s) => s.leverage).filter((x) => typeof x === "number" && !Number.isNaN(x));
  return xs.length ? Math.max(...xs) : NaN;
};

/**
 * The market strip: coin and its best payout, the mark (the TWAP the pots settle on), the move since the last settle, 24h volume
 * (api/leaders?markets=24), the oracle window's high and low, and when it was listed. `children` trails it (sibling pills, actions).
 */
export function MarketBar({
  v,
  ticker,
  image,
  stat,
  to,
  children,
}: {
  v: MarketView;
  ticker: string;
  image?: string | null;
  stat?: MarketStat | null;
  to?: string;
  children?: ReactNode;
}) {
  const px = usePrices();
  const twap = v.oracle.twap ?? v.oracle.lastTwap;
  const chg = v.oracle.lastTwap > 0 ? twap / v.oracle.lastTwap - 1 : 0;
  const dir = chg > 1e-9 ? "up" : chg < -1e-9 ? "down" : "";
  const ps = v.oracle.series.filter((p) => Number.isFinite(p.price) && p.price > 0);
  const span = ps.length >= 2 ? ps[ps.length - 1].ts - ps[0].ts : 0;
  const hi = ps.length ? Math.max(...ps.map((p) => p.price)) : null;
  const lo = ps.length ? Math.min(...ps.map((p) => p.price)) : null;
  const fmt = (x: number) => px.oracleFmt(x, v.oracle.quote, ticker);
  const id = (
    <>
      {image ? <img className="tokimg" src={image} alt="" /> : <span className="tokimg ph" aria-hidden />}
      <b className="mbar-tick">${ticker}</b>
      <span className="muted">/{v.oracle.quote}</span>
      <span className="lev-pill num" title="The best payout on this market right now: the thin side's leverage">
        {lev(bestLev(v))}
      </span>
    </>
  );
  return (
    <div className="mbar">
      {to ? (
        <Link to={to} className="mbar-id">
          {id}
        </Link>
      ) : (
        <div className="mbar-id">{id}</div>
      )}
      <div className="mbar-cells">
        <div className="mbar-cell">
          <span className="meta" title="The TWAP the pots settle on, not spot: nobody can flash-move it">
            Mark
          </span>
          <Flash watch={twap} className={`num mark ${dir}`}>
            <OraclePrice x={twap} quote={v.oracle.quote} ticker={ticker} />
          </Flash>
        </div>
        <div className="mbar-cell">
          <span className="meta">Since settle</span>
          <Delta x={chg} dp={3} />
        </div>
        <div className="mbar-cell">
          <span className="meta">24h vol</span>
          <b className="num">{stat?.vol ? usdShort(px.quoteUsd(BigInt(stat.vol))) : "—"}</b>
        </div>
        <div className="mbar-cell hide-sm">
          <span className="meta">{span ? `${spanLabel(span)} high` : "High"}</span>
          <b className="num">{hi !== null ? fmt(hi) : "—"}</b>
        </div>
        <div className="mbar-cell hide-sm">
          <span className="meta">{span ? `${spanLabel(span)} low` : "Low"}</span>
          <b className="num">{lo !== null ? fmt(lo) : "—"}</b>
        </div>
        <div className="mbar-cell hide-sm">
          <span className="meta">Listed</span>
          <b className="num">{stat ? (stat.born ? `${age(stat.born)} ago` : "long ago") : "—"}</b>
        </div>
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- chart

type Pt = { ts: number; price: number };
const RANGES: { id: string; label: string; secs: number }[] = [
  { id: "5m", label: "5m", secs: 300 },
  { id: "15m", label: "15m", secs: 900 },
  { id: "1h", label: "1h", secs: 3600 },
  { id: "4h", label: "4h", secs: 14_400 },
  { id: "all", label: "All", secs: Infinity },
];
const hhmm = (ts: number, secs: boolean) =>
  new Date(ts * 1000).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", ...(secs ? { second: "2-digit" } : {}) });

/** A floating chip on the chart: one trade, payout or win that landed while you were watching. */
type Chip = { id: string; tone: "up" | "down" | "signal"; kind: "trade" | "paid" | "win"; arrow: string; head: string; money: string; tail?: string };

/**
 * The oracle line, big: price axis on the right, the last settle dashed, a crosshair on hover, our wordmark faint behind the line,
 * and every new trade / pot payout / win on this market floating up from the bottom-left as it lands.
 */
export function TermChart({
  v,
  ticker,
  fmt,
  events,
  wins,
  watermark = "100x",
}: {
  v: MarketView;
  ticker: string;
  fmt: (p: number) => string;
  events?: Ev[];
  wins?: Win[];
  watermark?: string;
}) {
  const all = useMemo(() => v.oracle.series.filter((p) => Number.isFinite(p.price) && p.price > 0), [v.oracle.series]);
  const span = all.length >= 2 ? all[all.length - 1].ts - all[0].ts : 0;
  const ranges = RANGES.filter((r) => r.secs === Infinity || r.secs < span * 0.9);
  const [rid, setRid] = useState("all");
  const range = ranges.find((r) => r.id === rid) ?? ranges[ranges.length - 1];
  const last = all[all.length - 1];
  const pts = useMemo(() => (last && range.secs !== Infinity ? all.filter((p) => p.ts >= last.ts - range.secs) : all), [all, last, range.secs]);
  const chips = useLiveChips(v, events, wins);
  return (
    <section className="tchart" aria-label={`${ticker} oracle chart`}>
      <div className="tchart-bar">
        <div className="seg-mini" role="tablist" aria-label="Chart range">
          {ranges.map((r) => (
            <button key={r.id} role="tab" aria-selected={r.id === range.id} onClick={() => setRid(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
        <span className="meta tchart-cap">
          oracle · {all.length} obs · <i className="sw-dash" aria-hidden /> last settle
        </span>
      </div>
      <div className="tchart-body">
        <div className="wm" aria-hidden>
          {watermark}
        </div>
        <Plot pts={pts} twap={v.oracle.twap} ref0={v.oracle.lastTwap} fmt={fmt} />
        <ol className="tchips" aria-live="polite" aria-label="Live trades on this market">
          {chips.map((c) => (
            <li key={c.id} className={`tchip ${c.tone} ${c.kind}`}>
              {c.kind !== "trade" && <span className="burst" aria-hidden />}
              <span className="arrow" aria-hidden>
                {c.arrow}
              </span>
              <b>{c.head}</b>
              <span className="num">{c.money}</span>
              {c.tail && <span className="tail num">{c.tail}</span>}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Plot({ pts, twap, ref0, fmt }: { pts: Pt[]; twap: number | null; ref0: number; fmt: (p: number) => string }) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (pts.length < 2)
    return (
      <div className="plot plot-empty">
        <p className="note">Waiting for the oracle's second observation.</p>
      </div>
    );
  const W = 1000;
  const H = 400;
  const now = twap ?? pts[pts.length - 1].price;
  const prices = pts.map((p) => p.price).concat(now, ref0);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  if (hi - lo <= Math.abs(hi) * 1e-9) {
    const mid = hi || 1;
    lo = mid * 0.998;
    hi = mid * 1.002;
  }
  const padY = (hi - lo) * 0.12;
  lo -= padY;
  hi += padY;
  const t0 = pts[0].ts;
  const t1 = pts[pts.length - 1].ts;
  const fx = (ts: number) => ((ts - t0) / Math.max(1, t1 - t0)) * W;
  const fy = (p: number) => H - ((p - lo) / (hi - lo)) * H;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${fx(p.ts).toFixed(1)},${fy(p.price).toFixed(1)}`).join("");
  const dir = now > ref0 * (1 + 1e-9) ? "up" : now < ref0 * (1 - 1e-9) ? "down" : "flat";
  const yt = [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) * (i + 0.5)) / 5);
  const xt = [0.08, 0.3, 0.52, 0.74, 0.96].map((f) => t0 + (t1 - t0) * f);
  const withSecs = t1 - t0 < 1200;
  const hp = hover !== null ? pts[hover] : null;
  const onMove = (e: React.PointerEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const ts = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].ts - ts) < Math.abs(pts[best].ts - ts)) best = i;
    setHover(best);
  };
  return (
    <div className={`plot ${dir}`}>
      <div className="plot-area" ref={box} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Oracle price, ${fmt(now)} now`}>
          <defs>
            <linearGradient id="tchart-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.2" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          {yt.map((p) => (
            <line key={p} className="grid" x1={0} x2={W} y1={fy(p)} y2={fy(p)} />
          ))}
          <line className="ref" x1={0} x2={W} y1={fy(ref0)} y2={fy(ref0)} />
          <path className="area" d={`${d}L${W},${H}L0,${H}Z`} fill="url(#tchart-fill)" />
          <path className="line" d={d} />
          {hp && <line className="cross" x1={fx(hp.ts)} x2={fx(hp.ts)} y1={0} y2={H} />}
        </svg>
        <span className="dot" style={{ left: "100%", top: `${(fy(pts[pts.length - 1].price) / H) * 100}%` }} aria-hidden />
        {hp && (
          <span className="hover-tag num" style={{ left: `${(fx(hp.ts) / W) * 100}%`, top: `${(fy(hp.price) / H) * 100}%` }}>
            {fmt(hp.price)} · {hhmm(hp.ts, true)}
          </span>
        )}
      </div>
      <div className="y-axis num" aria-hidden>
        {yt.map((p) => (
          <span key={p} style={{ top: `${(fy(p) / H) * 100}%` }}>
            {fmt(p)}
          </span>
        ))}
        <span className={`now-tag ${dir}`} style={{ top: `${Math.min(97, Math.max(3, (fy(now) / H) * 100))}%` }}>
          {fmt(now)}
        </span>
      </div>
      <div className="x-axis num" aria-hidden>
        {xt.map((t) => (
          <span key={t} style={{ left: `${((t - t0) / Math.max(1, t1 - t0)) * 100}%` }}>
            {hhmm(t, withSecs)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** New trades, pot payouts and wins on this market since the page opened, as short-lived chips (never the backlog on load). */
function useLiveChips(v: MarketView, events: Ev[] | undefined, wins: Win[] | undefined): Chip[] {
  const px = usePrices();
  const key = v.acct.key.toBase58();
  const seenEv = useRef<Set<string> | null>(null);
  const seenWin = useRef<Set<string> | null>(null);
  const [chips, setChips] = useState<Chip[]>([]);
  const add = (c: Chip) => {
    setChips((xs) => [...xs.filter((x) => x.id !== c.id), c].slice(-4));
    setTimeout(() => setChips((xs) => xs.filter((x) => x.id !== c.id)), reduced() ? 4000 : 6500);
  };
  useEffect(() => {
    seenEv.current = null;
    seenWin.current = null;
    setChips([]);
  }, [key]);
  useEffect(() => {
    if (!events) return;
    const mine = events.filter((e) => e.market === key);
    if (!seenEv.current) {
      seenEv.current = new Set(mine.map((e) => e.sig));
      return;
    }
    for (const e of [...mine].reverse()) {
      if (seenEv.current.has(e.sig)) continue;
      seenEv.current.add(e.sig);
      const q = e.quote ? px.quoteUsd(BigInt(e.quote)) : null;
      const money = q !== null ? usd(q) : "";
      if (e.paid) {
        const amt = px.quoteUsd(BigInt(e.paid.amount));
        add({ id: `${e.sig}:p`, tone: e.paid.to === 0 ? "up" : "down", kind: "paid", arrow: "⇢", head: `${SIDE[e.paid.from]} paid ${SIDE[e.paid.to]}`, money: amt !== null ? usd(amt) : "" });
      }
      if (e.side === undefined) continue;
      const tone = e.side === 0 ? "up" : "down";
      if (e.kind === "buy") add({ id: e.sig, tone, kind: "trade", arrow: e.side === 0 ? "↗" : "↘", head: SIDE[e.side], money, tail: lev(v.side[e.side].leverage) });
      else if (e.kind === "sell") add({ id: e.sig, tone, kind: "trade", arrow: "↩", head: `${SIDE[e.side]} out`, money });
      else if (e.kind === "redeem") add({ id: e.sig, tone, kind: "trade", arrow: "↩", head: `${SIDE[e.side]} cashed out`, money });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, key]);
  useEffect(() => {
    if (!wins) return;
    const mine = wins.filter((w) => w.market === key);
    if (!seenWin.current) {
      seenWin.current = new Set(mine.map((w) => w.sig));
      return;
    }
    for (const w of mine) {
      if (seenWin.current.has(w.sig)) continue;
      seenWin.current.add(w.sig);
      const m = w.cost_sol >= 0.005 ? `${(w.ret + 1).toFixed(w.ret >= 9 ? 0 : 1)}×` : undefined;
      add({ id: `${w.sig}:w`, tone: "signal", kind: "win", arrow: "★", head: `${short(w.wallet)} won`, money: `+${w.gain_sol.toFixed(3)} SOL`, tail: m });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wins, key]);
  return chips;
}

// ---------------------------------------------------------------- people

/** A wallet's colour: two hues hashed from the address, the same everywhere on the site. */
export function Avatar({ wallet, size = 28 }: { wallet: string; size?: number }) {
  let h = 0;
  for (let i = 0; i < wallet.length; i++) h = (h * 31 + wallet.charCodeAt(i)) >>> 0;
  const a = h % 360;
  const b = (a + 40 + ((h >> 9) % 80)) % 360;
  return (
    <span
      className="avatar"
      aria-hidden
      style={{ width: size, height: size, background: `linear-gradient(135deg, oklch(0.78 0.14 ${a}), oklch(0.6 0.16 ${b}))` }}
    />
  );
}

// ---------------------------------------------------------------- your PnL

export type Period = "24h" | "7d" | "30d" | "all";
export const PERIOD_SECS: Record<Period, number> = { "24h": 86_400, "7d": 604_800, "30d": 2_592_000, all: Infinity };
export const PERIOD_LABEL: Record<Period, string> = { "24h": "24H", "7d": "7D", "30d": "30D", all: "All time" };

/**
 * Realized P&L from a wallet's own moves, average cost per position (the same rule as lib/pnl.ts): every sell or cash-out inside
 * the window realizes proceeds minus the cost of the tokens it moved. Amounts are r-fstacc (multiply by the stake rate for SOL).
 */
export function realizedFrom(evs: Ev[], me: string, since: number) {
  const pos = new Map<string, { q: number; t: number }>();
  let net = 0;
  let vol = 0;
  let closed = 0;
  let won = 0;
  const series: Pt[] = [];
  for (const e of [...evs].sort((a, b) => a.ts - b.ts)) {
    if (e.actor !== me || e.side === undefined) continue;
    if (e.kind !== "buy" && e.kind !== "sell" && e.kind !== "redeem") continue;
    const q = Number(e.quote ?? 0) / 1e9;
    const t = e.tokens ?? 0;
    const k = `${e.market}:${e.side}`;
    const p = pos.get(k) ?? { q: 0, t: 0 };
    const inWin = e.ts >= since;
    if (e.kind === "buy") {
      p.q += q;
      p.t += t;
    } else {
      const cost = p.t > 0 ? Math.min(p.q, (p.q / p.t) * t) : 0;
      p.q -= cost;
      p.t = Math.max(0, p.t - t);
      if (inWin) {
        const r = q - cost;
        net += r;
        closed++;
        if (r > 0) won++;
        series.push({ ts: e.ts, price: net });
      }
    }
    pos.set(k, p);
    if (inWin) vol += q;
  }
  return { net, vol, closed, won, series };
}

/** The connected wallet's realized P&L over 24H / 7D / All time: the big number, its rank, a curve and three tiles. */
export function PnlCard({ initial = "all", periods = ["24h", "7d", "all"] }: { initial?: Period; periods?: Period[] }) {
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const px = usePrices();
  const [period, setPeriod] = useState<Period>(initial);
  const winners = usePoll(fetchWinners, [], 60_000);
  const feed = usePoll(() => (me ? fetchFeed(undefined, me, 200) : Promise.resolve(null)), [me], 30_000);
  const hours = period === "24h" ? 24 : period === "7d" ? 168 : null;
  const active = usePoll(() => (hours ? fetchActive(hours) : Promise.resolve(null)), [hours], 60_000);
  const now = Math.floor(Date.now() / 1000);
  const since = PERIOD_SECS[period] === Infinity ? 0 : now - PERIOD_SECS[period];
  const rate = px.rate ?? 1;
  const r = useMemo(() => (me && feed.data ? realizedFrom(feed.data, me, since) : null), [feed.data, me, since]);
  const board = winners.data?.boards?.[period];
  const pnlRank = me && board ? board.findIndex((b) => b.wallet === me) : -1;
  const volRank = me && active.data ? active.data.findIndex((a) => a.owner === me) : -1;
  // ONE source per card, never mixed: the leaderboard's row when this wallet is on it (net since launch, every market including the
  // ones before the 2026-10-16 relaunch, plus vault unparks and referral fees), else this wallet's own feed on today's markets
  const row = pnlRank >= 0 && board ? board[pnlRank] : null;
  const wins = row && winners.data ? winners.data.wins.filter((w) => w.wallet === me && w.ts >= since).length : 0;
  const net = row ? row.net_sol : r ? r.net * rate : null;
  const tabs = (
    <div className="seg-mini" role="tablist" aria-label="PnL window">
      {periods.map((p) => (
        <button key={p} role="tab" aria-selected={p === period} onClick={() => setPeriod(p)}>
          {PERIOD_LABEL[p]}
        </button>
      ))}
    </div>
  );
  let body: ReactNode;
  if (!me)
    body = (
      <div className="pnl-empty">
        <p>Connect a wallet to see your realized PnL, rank and win rate.</p>
        <WalletButton solo />
      </div>
    );
  else if (feed.loading && !feed.data) body = <span className="skeleton" style={{ height: 132 }} />;
  else if (!r)
    body = <p className="note err">{feed.error ? "Your history didn't load. Retrying…" : "Nothing to show."}</p>;
  else if (r.closed === 0 && !row)
    body = (
      <div className="pnl-empty">
        <b>No closed trades {period === "all" ? "yet" : `in the last ${PERIOD_LABEL[period]}`}</b>
        <p>Your realized PnL shows here once you sell or cash out a side.</p>
        <Link className="btn small signal" to="/">
          Start trading
        </Link>
      </div>
    );
  else
    body = (
      <>
        <div className={`pnl-big num ${net !== null && net < 0 ? "down" : "up"}`}>
          {net === null ? "—" : `${net >= 0 ? "+" : "−"}${Math.abs(net).toFixed(4)} SOL`}
        </div>
        <div className="meta pnl-sub">
          Realized PnL · {PERIOD_LABEL[period].toLowerCase()}
          {net !== null && px.solUsd ? ` · ≈ ${net < 0 ? "−" : ""}${usd(Math.abs(net) * px.solUsd)}` : ""}
          {row ? " · leaderboard, all markets since launch" : " · this wallet's trades"}
        </div>
        {(pnlRank >= 0 || volRank >= 0) && (
          <Link className="rank-chip" to={`/winners?period=${period}`}>
            {pnlRank >= 0 ? `#${pnlRank + 1} PnL` : "unranked PnL"}
            {volRank >= 0 ? ` · #${volRank + 1} volume` : ""} ›
          </Link>
        )}
        {!row && r.series.length >= 2 && <MiniCurve pts={[{ ts: r.series[0].ts - 1, price: 0 }, ...r.series]} />}
        {row ? (
          <div className="tiles">
            <div>
              <span className="meta">Won · lost</span>
              <b className="num">
                <span className="up">+{row.won_sol.toFixed(2)}</span> <span className="down">−{row.lost_sol.toFixed(2)}</span>
              </b>
            </div>
            <div>
              <span className="meta">Closed trades</span>
              <b className="num">{row.trades}</b>
            </div>
            <div>
              <span className="meta">Win rate</span>
              <b className="num">{row.trades ? `${Math.round(Math.min(1, wins / row.trades) * 100)}%` : "—"}</b>
            </div>
          </div>
        ) : (
          <div className="tiles">
            <div>
              <span className="meta">Volume</span>
              <b className="num">{(r.vol * rate).toFixed(3)} SOL</b>
            </div>
            <div>
              <span className="meta">Closed trades</span>
              <b className="num">{r.closed}</b>
            </div>
            <div>
              <span className="meta">Win rate</span>
              <b className="num">{r.closed ? `${Math.round((r.won / r.closed) * 100)}%` : "—"}</b>
            </div>
          </div>
        )}
      </>
    );
  return (
    <section className="tcard pnl-card" aria-label="Your PnL">
      <header>
        <h2>Your PnL</h2>
        {tabs}
      </header>
      {body}
    </section>
  );
}

/** Cumulative realized P&L, filled to zero; red when it ends below where it started. */
function MiniCurve({ pts }: { pts: Pt[] }) {
  const W = 300;
  const H = 56;
  const ys = pts.map((p) => p.price).concat(0);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const span = hi - lo || 1;
  const t0 = pts[0].ts;
  const t1 = pts[pts.length - 1].ts;
  const fx = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const fy = (p: number) => H - 3 - ((p - lo) / span) * (H - 6);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${fx(p.ts).toFixed(1)},${fy(p.price).toFixed(1)}`).join("");
  const down = pts[pts.length - 1].price < 0;
  return (
    <svg className={`mini-curve ${down ? "down" : "up"}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Realized PnL over the window">
      <path d={`${d}L${W},${fy(0)}L0,${fy(0)}Z`} className="area" />
      <line x1={0} x2={W} y1={fy(0)} y2={fy(0)} className="zero" />
      <path d={d} className="line" />
    </svg>
  );
}

// ---------------------------------------------------------------- rules

/** The house rules, in four lines. Our version of the "trade against the house" callout: here the other side is the crowd. */
export function HouseRules({ ticker, rulesHref = "/#fine" }: { ticker?: string; rulesHref?: string }) {
  return (
    <aside className="tcard house-rules" aria-label="House rules">
      <h2>
        <span aria-hidden>⚡</span> House rules
      </h2>
      <p>
        <b className="up">UP</b> if {ticker ? `$${ticker}` : "the coin"} pumps, <b className="down">DOWN</b> if it dumps. Every tick the wrong side's pot pays the
        right one (a 1% move ≈ 63% of it). No liquidations: leave any time at the curve or the pot, minus 4%.
      </p>
      <p className="warn-line">The thin side pays the most, and it can be emptied just as fast. A side that owes is settled into the other pot on the next trade.</p>
      {rulesHref.startsWith("#") ? (
        <a href={rulesHref} className="more">
          Read the full rules →
        </a>
      ) : (
        <Link to={rulesHref} className="more">
          Read the math →
        </Link>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------- ordering

/** Volume · Newest · Oldest · Disparity. `stats` says whether the server's volume/age numbers are in; without them the order is by pots. */
export function SortChips({ sort, onChange, stats = "ok", label = "Sort markets" }: { sort: Sort; onChange: (s: Sort) => void; stats?: "ok" | "loading" | "error"; label?: string }) {
  return (
    <div className="sort-chips" role="radiogroup" aria-label={label}>
      <span className="meta">Sort</span>
      {SORTS.map((s) => (
        <button key={s.id} type="button" role="radio" aria-checked={s.id === sort} className="chip" title={s.hint} onClick={() => onChange(s.id)}>
          {s.label}
        </button>
      ))}
      {stats !== "ok" && sort !== "disparity" && (
        <span className="meta sort-note" role="note">
          {stats === "loading" ? "loading volume & age · by pots for now" : "volume & age unavailable · ordered by pots"}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- trader list (left rail)

export type TRow = { id: string; wallet?: string; title: ReactNode; sub?: ReactNode; value: ReactNode; valueSub?: ReactNode; tone?: "up" | "down" | ""; to?: string };

/** A ranked, scrolling list of wallets or moves under a row of tabs; every row opens its wallet (or its market). */
export function TraderList<T extends string>({
  tabs,
  tab,
  onTab,
  rows,
  loading,
  error,
  empty,
  ranked = true,
  footer,
}: {
  tabs: { id: T; label: string }[];
  tab: T;
  onTab: (t: T) => void;
  rows: TRow[] | undefined;
  loading: boolean;
  error?: string | null;
  empty: ReactNode;
  ranked?: boolean;
  footer?: ReactNode;
}) {
  return (
    <section className="tcard tlist" aria-label="Traders">
      <div className="seg-mini" role="tablist" aria-label="List">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === tab} onClick={() => onTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {loading && !rows ? (
        <div className="tlist-rows">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className="skeleton" style={{ height: 40 }} />
          ))}
        </div>
      ) : !rows?.length ? (
        <div className="tlist-empty">{error ? <span className="err">Didn't load: {error}</span> : empty}</div>
      ) : (
        <ol className="tlist-rows">
          {rows.map((r, i) => {
            const inner = (
              <>
                {ranked && <span className="rk num">{i + 1}</span>}
                {r.wallet ? <Avatar wallet={r.wallet} size={26} /> : <span className={`ev-dot ${r.tone ?? ""}`} aria-hidden />}
                <span className="who">
                  <b className="num">{r.title}</b>
                  {r.sub && <span className={`sub ${r.tone ?? ""}`}>{r.sub}</span>}
                </span>
                <span className="val">
                  <b className={`num ${r.tone ?? ""}`}>{r.value}</b>
                  {r.valueSub && <span className="sub num">{r.valueSub}</span>}
                </span>
              </>
            );
            return <li key={r.id}>{r.to ? <Link to={r.to}>{inner}</Link> : <div>{inner}</div>}</li>;
          })}
        </ol>
      )}
      {footer && <div className="tlist-foot">{footer}</div>}
    </section>
  );
}

/** One feed event as a list row: who, what, how much, when. */
export function eventRow(e: Ev, quoteUsd: (raw: bigint) => number | null, withTicker: boolean): TRow | null {
  const q = e.quote ? quoteUsd(BigInt(e.quote)) : null;
  const paid = e.paid ? quoteUsd(BigInt(e.paid.amount)) : null;
  const side = e.side !== undefined ? SIDE[e.side] : "";
  const tone = e.side === 0 ? "up" : e.side === 1 ? "down" : "";
  const where = withTicker ? ` · $${e.ticker}` : "";
  const ago = (ts: number) => {
    const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  };
  const base = { id: e.sig, wallet: e.actor, title: short(e.actor), valueSub: ago(e.ts), to: withTicker ? `/m/${e.market}` : `/p/${e.actor}` };
  switch (e.kind) {
    case "buy":
      return { ...base, sub: `aped ${side}${where}`, value: q !== null ? usd(q) : "—", tone };
    case "sell":
      return { ...base, sub: `sold ${side}${where}`, value: q !== null ? usd(q) : "—", tone };
    case "redeem":
      return { ...base, sub: `cashed out ${side}${where}`, value: q !== null ? usd(q) : "—", tone };
    case "listed":
      return { ...base, sub: `listed a market${where}`, value: "new", tone: "" };
    case "settle":
    case "rebalance":
      return e.paid ? { ...base, wallet: undefined, title: `${SIDE[e.paid.from]} → ${SIDE[e.paid.to]}`, sub: `pot payout${where}`, value: paid !== null ? usd(paid) : "—", tone: e.paid.to === 0 ? "up" : "down" } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- market switcher (header pills + the "All markets" sheet)

/** One market as a pill: coin, quote, move since settle. Siblings say how they relate. */
function Pill({ v, on, note, search }: { v: MarketView; on: boolean; note?: string; search: string }) {
  const under = useUnderlying(v.underlyingMint);
  const ticker = under?.symbol ?? v.ticker;
  const twap = v.oracle.twap ?? v.oracle.lastTwap;
  const chg = v.oracle.lastTwap > 0 ? twap / v.oracle.lastTwap - 1 : 0;
  return (
    <Link to={`/m/${v.acct.key.toBase58()}${search}`} className={`mpill ${on ? "on" : ""} ${note ? "sib" : ""}`} aria-current={on ? "page" : undefined} title={note ? `Sibling: ${note}` : undefined}>
      {under?.image ? <img className="tokimg" src={under.image} alt="" /> : <span className="tokimg ph" aria-hidden />}
      <b>${ticker}</b>
      <span className="muted">/{v.oracle.quote}</span>
      {note && <span className="mpill-note">{note}</span>}
      <Delta x={chg} dp={2} />
    </Link>
  );
}

/**
 * The header's market pills: this market's siblings first (same coin or same oracle pool, labelled), then the rest in the board's
 * order (?sort=), then "All markets" for the full sorted, grouped list.
 */
export function MarketPills({ current, all, stats, statsState, sort, onSort }: { current: MarketView; all: MarketView[]; stats: Map<string, MarketStat> | null | undefined; statsState: "ok" | "loading" | "error"; sort: Sort; onSort: (s: Sort) => void }) {
  const key = current.acct.key.toBase58();
  const sibs = siblingsOf(current, all);
  const sibKeys = new Set(sibs.map((s) => s.acct.key.toBase58()));
  const rest = sortMarkets(
    all.filter((o) => o.acct.key.toBase58() !== key && !sibKeys.has(o.acct.key.toBase58())),
    stats,
    sort,
  ).rows.slice(0, 6);
  // the order travels with you from market to market
  const search = sort === "volume" ? "" : `?sort=${sort}`;
  return (
    <div className="mpills">
      {sibs.map((s) => (
        <Pill key={s.acct.key.toBase58()} v={s} on={false} note={relation(s, current)} search={search} />
      ))}
      {sibs.length > 0 && rest.length > 0 && <span className="mpills-sep" aria-hidden />}
      {rest.map((o) => (
        <Pill key={o.acct.key.toBase58()} v={o} on={false} search={search} />
      ))}
      <AllMarkets current={current} all={all} stats={stats} statsState={statsState} sort={sort} onSort={onSort} />
    </div>
  );
}

/** Every market in one sheet: search, the four sorts, siblings grouped under their lead, and a door to list a new one. */
export function AllMarkets({ current, all, stats, statsState, sort, onSort }: { current: MarketView | null; all: MarketView[]; stats: Map<string, MarketStat> | null | undefined; statsState: "ok" | "loading" | "error"; sort: Sort; onSort: (s: Sort) => void }) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const out = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", esc);
    document.addEventListener("mousedown", out);
    return () => {
      document.removeEventListener("keydown", esc);
      document.removeEventListener("mousedown", out);
    };
  }, [open]);
  const needle = find.trim().toLowerCase();
  const groups = siblingGroups(sortMarkets(all, stats, sort).rows).filter(
    (g) => !needle || [g.lead, ...g.siblings].some((v) => `${v.ticker} ${v.oracle.quote} ${v.underlyingMint} ${v.acct.key.toBase58()}`.toLowerCase().includes(needle)),
  );
  return (
    <div className="allm" ref={box}>
      <button type="button" className="allm-btn" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)}>
        All markets <span className="num">{all.length}</span> ▾
      </button>
      {open && (
        <div className="allm-sheet" role="dialog" aria-label="All markets">
          <div className="allm-top">
            <input autoFocus value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search coin, quote or address" aria-label="Search markets" />
            <Link to="/new" className="btn signal small">
              + New market
            </Link>
          </div>
          <SortChips sort={sort} onChange={onSort} stats={statsState} />
          <ol className="allm-list">
            {groups.map((g) =>
              [g.lead, ...g.siblings].map((v, i) => (
                <SheetRow key={v.acct.key.toBase58()} v={v} lead={i ? g.lead : null} on={!!current && v.acct.key.equals(current.acct.key)} stat={stats?.get(v.acct.key.toBase58())} search={sort === "volume" ? "" : `?sort=${sort}`} />
              )),
            )}
            {!groups.length && <li className="allm-empty">No market matches “{find}”. <Link to="/new">List it →</Link></li>}
          </ol>
        </div>
      )}
    </div>
  );
}

function SheetRow({ v, lead, on, stat, search }: { v: MarketView; lead: MarketView | null; on: boolean; stat?: MarketStat; search: string }) {
  const under = useUnderlying(v.underlyingMint);
  const px = usePrices();
  const ticker = under?.symbol ?? v.ticker;
  const twap = v.oracle.twap ?? v.oracle.lastTwap;
  const chg = v.oracle.lastTwap > 0 ? twap / v.oracle.lastTwap - 1 : 0;
  return (
    <li className={`${lead ? "sib" : ""} ${on ? "on" : ""}`}>
      <Link to={`/m/${v.acct.key.toBase58()}${search}`} aria-current={on ? "page" : undefined}>
        <span className="allm-id">
          {lead && <span className="sib-mark">↳</span>}
          {under?.image ? <img className="tokimg" src={under.image} alt="" /> : <span className="tokimg ph" aria-hidden />}
          <span>
            <b>${ticker}</b> <span className="muted">/{v.oracle.quote}</span>
            <span className="meta allm-tag">{lead ? `sibling · ${relation(v, lead)} · ` : ""}{windowLabel(v.acct.windowSecs)}</span>
          </span>
        </span>
        <span className="num allm-px">{px.oracleFmt(twap, v.oracle.quote, ticker)}</span>
        <Delta x={chg} dp={2} />
        <span className="num allm-lev">
          <span className="up">{lev(v.side[0].leverage)}</span> / <span className="down">{lev(v.side[1].leverage)}</span>
        </span>
        <span className="num allm-vol">{stat?.vol ? usdShort(px.quoteUsd(BigInt(stat.vol))) : "—"}</span>
        <span className="num allm-age">{stat ? age(stat.born) : "—"}</span>
      </Link>
    </li>
  );
}
