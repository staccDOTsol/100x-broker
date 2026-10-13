// Live surfaces: the tape (board), the activity feed and the holder/wallet leaderboards.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { usePoll } from "../hooks";
import { usePrices } from "../hooks/price";
import { fetchActive, fetchFeed, fetchLeaders, fetchWallets, type Ev } from "../lib/feed";
import { ago, lev, short, usd } from "../lib/format";

const SIDE = ["UP", "DOWN"] as const;
const sideCls = (s: 0 | 1 | undefined) => (s === 0 ? "up" : s === 1 ? "down" : "");

/** One event as a sentence. `withTicker` for cross-market surfaces. */
function Line({ e, withTicker }: { e: Ev; withTicker: boolean }) {
  const px = usePrices();
  const q = e.quote ? px.quoteUsd(BigInt(e.quote)) : null;
  const paidUsd = e.paid ? px.quoteUsd(BigInt(e.paid.amount)) : null;
  const who = (
    <Link to={`/p/${e.actor}`} className="who num">
      {short(e.actor)}
    </Link>
  );
  const tick = withTicker && e.kind !== "burn" ? <Link to={`/m/${e.market}`} className="tick">${e.ticker}</Link> : null;
  const side = <b className={sideCls(e.side)}>{e.side !== undefined ? SIDE[e.side] : ""}</b>;
  const money = q !== null && q > 0 ? <b className="num">{usd(q)}</b> : null;
  const paid =
    e.paid && paidUsd ? (
      <span className="paid">
        <b className={sideCls(e.paid.from)}>{SIDE[e.paid.from]}</b> paid <b className={sideCls(e.paid.to)}>{SIDE[e.paid.to]}</b>{" "}
        <b className="num">{usd(paidUsd)}</b>
      </span>
    ) : null;
  switch (e.kind) {
    case "buy":
      return (
        <>
          {who} aped {side} {tick && <>on {tick}</>} {money && <>· {money}</>} {paid}
        </>
      );
    case "sell":
      return (
        <>
          {who} bailed on {side} {tick && <>on {tick}</>} {money && <>· {money}</>} {paid}
        </>
      );
    case "redeem":
      return (
        <>
          {who} cashed out {side} {tick && <>on {tick}</>} {money && <>for {money}</>} {paid}
        </>
      );
    case "settle":
      return (
        <>
          {side} got collected {tick && <>on {tick}</>} {money && <>· {money} → {SIDE[1 - (e.side ?? 0)]} pot</>} {paid}
        </>
      );
    case "claim":
      return (
        <>
          {money ?? "tips"} in tips swept into {tick ? <>{tick} </> : "the "}pots {paid}
        </>
      );
    case "rebalance":
      return (
        <>
          {tick && <>{tick}: </>}
          {paid}
        </>
      );
    case "listed":
      return (
        <>
          {who} cooked up {tick ?? <b>this market</b>} ±100×
        </>
      );
    case "burn":
      return (
        <>
          <b className="burnword">burned</b> {e.tokens?.toLocaleString("en-US", { maximumFractionDigits: 0 })} <b>$100XBRO</b>
          {money && <> · pot paid {money}</>}
        </>
      );
  }
}

const weight = (e: Ev, px: ReturnType<typeof usePrices>) => {
  const q = e.quote ? (px.quoteUsd(BigInt(e.quote)) ?? 0) : 0;
  const p = e.paid ? (px.quoteUsd(BigInt(e.paid.amount)) ?? 0) : 0;
  return Math.max(q, p);
};

export function Feed({ market, limit = 30, actor }: { market?: string; limit?: number; actor?: string }) {
  const { data, loading, error } = usePoll(() => fetchFeed(market, actor), [market, actor]);
  const px = usePrices();
  const seen = useRef<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!data) return;
    const first = seen.current.size === 0;
    const now = new Set<string>();
    for (const e of data) {
      if (!seen.current.has(e.sig)) {
        seen.current.add(e.sig);
        if (!first) now.add(e.sig);
      }
    }
    if (now.size) {
      setFresh(now);
      const t = setTimeout(() => setFresh(new Set()), 4000);
      return () => clearTimeout(t);
    }
  }, [data]);
  if (loading && !data)
    return (
      <div className="feed">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="skeleton" style={{ height: 18, width: `${70 - i * 10}%` }} />
        ))}
      </div>
    );
  const rows = actor ? (data ?? []).filter((e) => e.actor === actor) : (data ?? []);
  if (!rows.length)
    return (
      <p className="note">
        {error ? "Feed's taking a breather." : actor ? "No moves on record. Spectating is free; it also pays nothing." : "Crickets. First move gets the cheapest side."}
      </p>
    );
  const big = Math.max(1, ...rows.map((e) => weight(e, px)));
  return (
    <ol className="feed" aria-live="polite">
      {rows.slice(0, limit).map((e) => {
        const w = weight(e, px);
        return (
          <li key={e.sig} className={`ev ev-${e.kind} ${fresh.has(e.sig) ? "fresh" : ""} ${w / big > 0.5 ? "loud" : ""}`}>
            <a className="when meta" href={`https://solscan.io/tx/${e.sig}`} target="_blank" rel="noreferrer">
              {ago(e.ts)}
            </a>
            <span className="what">
              <Line e={e} withTicker={!market} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Horizontal tape of the latest moves across every market. */
export function Tape() {
  const { data } = usePoll(() => fetchFeed(), []);
  if (!data?.length) return null;
  const items = data.slice(0, 20);
  const row = (k: string) => (
    <span className="tape-row" key={k} aria-hidden={k === "b"}>
      {items.map((e) => (
        <Link key={k + e.sig} to={e.kind === "burn" ? "/#coin" : `/m/${e.market}${e.side !== undefined ? `?side=${e.side}` : ""}`} className={`tape-item ev-${e.kind}`}>
          <Line e={e} withTicker />
          <span className="meta"> · {ago(e.ts)}</span>
        </Link>
      ))}
    </span>
  );
  return (
    <div className="tape" role="marquee" aria-label="Latest activity">
      <div className="tape-track">
        {row("a")}
        {row("b")}
      </div>
    </div>
  );
}

export function Leaders({ market }: { market: string }) {
  const { data, loading } = usePoll(() => fetchLeaders(market), [market]);
  if (loading && !data) return <span className="skeleton" style={{ height: 120 }} />;
  if (!data) return <p className="note">Leaderboard unavailable.</p>;
  const cols = ([0, 1] as const).map((side) => {
    const rows = data.sides[side];
    const top = Math.max(1, ...rows.map((r) => r.valueUsd ?? 0));
    return (
      <div className="lb-col" key={side}>
        <div className="meta">
          <b className={sideCls(side)}>{SIDE[side]}</b> · biggest bags · {lev(data.leverage[side])} payout
        </div>
        {rows.length === 0 ? (
          <p className="note">Nobody's {SIDE[side]} yet. {lev(data.leverage[side])} payout sitting here, unclaimed.</p>
        ) : (
          <ol className="lb">
            {rows.slice(0, 6).map((r, i) => (
              <li key={r.owner}>
                <span className="rank num">{i + 1}</span>
                <Link to={`/p/${r.owner}`} className="who num">
                  {short(r.owner)}
                </Link>
                <span className={`bar ${sideCls(side)}`} style={{ width: `${Math.max(4, ((r.valueUsd ?? 0) / top) * 100)}%` }} />
                <span className="val num">{usd(r.valueUsd)}</span>
                <span className="meta num">{(r.share * 100).toFixed(1)}%</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  });
  return <div className="lb-grid">{cols}</div>;
}

type WalletRow = { owner: string; weight: number; val: ReactNode; meta: ReactNode };
/** Ranked wallets: rank · address → bag page · bar by weight · mono value · meta line. Bags and activity both render through here. */
function WalletList({ rows, loading, empty }: { rows: WalletRow[] | undefined; loading: boolean; empty: string }) {
  if (loading && !rows) return <span className="skeleton" style={{ height: 160 }} />;
  if (!rows?.length) return <p className="note">{empty}</p>;
  const top = Math.max(1, ...rows.map((r) => r.weight));
  return (
    <ol className="lb wallets">
      {rows.slice(0, 10).map((r, i) => (
        <li key={r.owner}>
          <span className="rank num">{i + 1}</span>
          <Link to={`/p/${r.owner}`} className="who num">
            {short(r.owner)}
          </Link>
          <span className="bar" style={{ width: `${Math.max(4, (r.weight / top) * 100)}%` }} />
          <span className="val num">{r.val}</span>
          <span className="meta">{r.meta}</span>
        </li>
      ))}
    </ol>
  );
}
const mostly = (t: { ticker: string; side: 0 | 1 } | null) =>
  t ? (
    <>
      mostly {t.ticker} <b className={sideCls(t.side)}>{SIDE[t.side]}</b>
    </>
  ) : null;

export function Wallets() {
  const { data, loading } = usePoll(fetchWallets, []);
  const rows = data?.map((w) => ({
    owner: w.owner,
    weight: w.valueUsd,
    val: usd(w.valueUsd),
    meta: (
      <>
        {w.positions} bag{w.positions === 1 ? "" : "s"} · {mostly(w.biggest)}
      </>
    ),
  }));
  return <WalletList rows={rows} loading={loading} empty="No bags yet. Yours could be first." />;
}

/** Who traded most in the window. Closed positions count here; the bags list only sees what is still held. */
export function ActiveWallets({ hours = 24 }: { hours?: number }) {
  const { data, loading } = usePoll(() => fetchActive(hours), [hours]);
  const px = usePrices();
  const sol = (raw: string) => {
    const v = px.quoteSol(BigInt(raw));
    return v === null ? "—" : v.toFixed(3);
  };
  const rows = data?.map((w) => {
    const net = px.quoteSol(BigInt(w.net));
    return {
      owner: w.owner,
      weight: Number(BigInt(w.in) + BigInt(w.out)) / 1e9, // bar = volume moved, same thing the rank is
      val: (
        <>
          {sol((BigInt(w.in) + BigInt(w.out)).toString())} SOL moved
        </>
      ),
      meta: (
        <>
          {sol(w.in)} in → {sol(w.out)} out · net <b className={net === null ? "" : net >= 0 ? "up" : "down"}>{net === null ? "—" : `${net >= 0 ? "+" : "−"}${Math.abs(net).toFixed(3)}`}</b> · {w.trades} trade
          {w.trades === 1 ? "" : "s"} · {mostly(w.top)}
        </>
      ),
    };
  });
  return <WalletList rows={rows} loading={loading} empty="Nobody yet. Be the first degen." />;
}
