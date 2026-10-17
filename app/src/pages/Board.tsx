// / — the board, laid out as a trading terminal (Operate + Compare): a strip for the house market and the site's live totals, then
// live traders | the hero chart | a ticket that opens the market and a box to spawn a new one, then every market in one ranked
// table (volume · newest · oldest · disparity, in ?sort=) with siblings on the same coin or oracle grouped together, never hidden.
// Everything on this page is polled from /api/markets, /api/feed, /api/winners, /api/leaders and /api/backed.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { RAISE_URL } from "../lib/backable";
import { Link, useNavigate } from "react-router-dom";
import { usePoll } from "../hooks";
import { listMarketKeys, loadMarketView, type MarketView } from "../lib/chain";
import { fetchViews } from "../lib/views";
import { loadBurnPot } from "../lib/burn";
import { useUnderlying } from "../hooks/underlying";
import { CoinStrip } from "../components/Coin";
import { Runners } from "../components/Runners";
import { Delta, Flash, Rolling, Sparkline } from "../components/Pulse";
import { ago, lev, short, usd, usdShort } from "../lib/format";
import { fetchActive, fetchFeed, fetchMarketStats, fetchWallets, fetchWinners, type Ev, type MarketStat } from "../lib/feed";
import { marketShare, useRefWallet } from "../components/Flex";
import { CardShare, Tweet } from "../components/Share";
import { PinButton } from "../components/PinButton";
import { usePins } from "../lib/pins";
import { CatEmpty, CatFilter, useCatRows } from "../components/CatFilter";
import { catOfView } from "../lib/category";
import { usePrices } from "../hooks/price";
import { HERO_MARKETS, MEME_MINT } from "../config";
import { age, disparity, disparityLabel, marketTag, relation, siblingGroups, sortMarkets, thinSide, useSort, type Sort } from "../lib/order";
import { eventRow, HouseRules, MarketBar, SortChips, TermChart, TraderList, type TRow } from "../components/Terminal";

async function loadBoard(): Promise<MarketView[]> {
  // one server snapshot for every tab (edge-cached), not 80 RPC calls per visitor; falls back to the chain if the server is down
  const views = await fetchViews().catch(async () => {
    const keys = await listMarketKeys();
    return (await Promise.all(keys.map((k) => loadMarketView(k).catch(() => null)))).filter((v): v is MarketView => !!v);
  });
  return views.sort((a, b) => Number(b.side[0].vault + b.side[1].vault - (a.side[0].vault + a.side[1].vault)));
}

const STABLES = new Set(["USDC", "USDT", "PYUSD", "TUSD", "USD1", "DAI", "FDUSD", "USDE", "USDS", "CASH", "USDH", "UXD"]);
type Theme = "all" | "coins" | "stable/stable" | "inverse SOL";
const THEMES: Theme[] = ["all", "coins", "stable/stable", "inverse SOL"];
const themeOf = (v: MarketView): Exclude<Theme, "all"> => {
  const stableBase = STABLES.has(v.ticker.toUpperCase());
  const q = v.oracle.quote;
  if (stableBase && (q === "USDC" || q === "USDT")) return "stable/stable";
  if (stableBase && q === "SOL") return "inverse SOL";
  return "coins";
};
const SIDE = ["UP", "DOWN"] as const;
const DAY = 86400;
const HOUR = 3600;

/** Moves per market in the last hour, from the global feed (the last 60 events across every market). */
function movesByMarket(evs: Ev[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  const since = Date.now() / 1000 - HOUR;
  for (const e of evs ?? []) if (e.ts >= since && e.kind !== "burn") m.set(e.market, (m.get(e.market) ?? 0) + 1);
  return m;
}

// ---- hero fallback: when the house chart is flat, show whichever live market moved most over its loaded window ----
const finitePrices = (v: MarketView) => v.oracle.series.map((p) => p.price).filter((p) => Number.isFinite(p) && p > 0);
/** last/first − 1 of the oracle series the board already holds; 0 without two usable points. */
function seriesMove(v: MarketView): number {
  const ps = finitePrices(v);
  return ps.length >= 2 ? ps[ps.length - 1] / ps[0] - 1 : 0;
}
/** Flat = fewer than 8 points, or a max/min spread under 0.2%: nothing to look at. */
function flatSeries(v: MarketView): boolean {
  const ps = finitePrices(v);
  return ps.length < 8 || Math.max(...ps) / Math.min(...ps) - 1 < 0.002;
}
/** The market with the biggest |move| (ties: bigger pots); null when nothing moved at all, so the house chart stays. */
function biggestMover(all: MarketView[], not: MarketView | undefined): { v: MarketView; move: number } | null {
  const pot = (v: MarketView) => v.side[0].vault + v.side[1].vault;
  let best: { v: MarketView; move: number } | null = null;
  for (const v of all) {
    if (v === not) continue;
    const move = seriesMove(v);
    if (!best || Math.abs(move) > Math.abs(best.move) || (Math.abs(move) === Math.abs(best.move) && pot(v) > pot(best.v))) best = { v, move };
  }
  return best && Math.abs(best.move) > 0 ? best : null;
}

export default function Board() {
  const { data, error, loading } = usePoll(loadBoard, []);
  const burn = usePoll(loadBurnPot, []);
  const feed = usePoll(() => fetchFeed(), [], 6_000);
  const wins = usePoll(fetchWinners, [], 20_000);
  const stats = usePoll(() => fetchMarketStats(24), [], 30_000);
  const [theme, setTheme] = useState<Theme>("all");
  const [pinsOnly, setPinsOnly] = useState(false);
  const [sort, setSort] = useSort();
  const pins = usePins();
  const moves = useMemo(() => movesByMarket(feed.data), [feed.data]);
  const house = HERO_MARKETS.map((k) => data?.find((v) => v.acct.key.toBase58() === k)).find((v): v is MarketView => !!v) ?? data?.[0];
  // a flat $100XBRO chart hands the hero to the biggest mover on the board; it comes back the moment $100XBRO moves again
  const mover = useMemo(() => (house && data && flatSeries(house) ? biggestMover(data, house) : null), [data, house]);
  const hero = mover?.v ?? house;
  // the table lists every market, the hero's too; "♥ Pinned" narrows it to the pinned ones
  const bucket = useMemo(() => (data ?? []).filter((v) => (!pinsOnly || pins.isPinned(v)) && (theme === "all" || themeOf(v) === theme)), [data, theme, pinsOnly, pins]);
  // Memes · Majors · Stonks on top of the bucket; counts are what this bucket holds
  const { cat, setCat, counts, filtered } = useCatRows(bucket, catOfView);
  // the chosen order, siblings pulled up under their best-ranked member, pinned groups first (the ♥ promise: "keep it at the top")
  const statsState = stats.data ? "ok" : stats.loading ? "loading" : "error";
  const sorted = useMemo(() => sortMarkets(filtered, stats.data, sort), [filtered, stats.data, sort]);
  const groups = useMemo(() => {
    const gs = siblingGroups(sorted.rows);
    const pinned = (g: (typeof gs)[number]) => [g.lead, ...g.siblings].some((v) => pins.isPinned(v));
    return [...gs.filter(pinned), ...gs.filter((g) => !pinned(g))];
  }, [sorted.rows, pins]);
  const pinnedCount = (data ?? []).filter((v) => pins.isPinned(v)).length;
  const count = (t: Theme) => (t === "all" ? (data?.length ?? 0) : (data ?? []).filter((v) => themeOf(v) === t).length);
  // the best payout anywhere on the board right now — real, from the pots
  const bestLev = useMemo(() => {
    let best: number | null = null;
    for (const v of data ?? []) for (const s of v.side) if (Number.isFinite(s.leverage) && s.leverage > 0 && (best === null || s.leverage > best)) best = s.leverage;
    return best;
  }, [data]);
  useEffect(() => {
    if (bestLev !== null) document.title = `100x.broker — your next ${lev(bestLev)}, up or down`;
  }, [bestLev]);
  return (
    <>
      <h1 className="sr-only">Your next {bestLev !== null ? lev(bestLev) : "100×"}. Up or down.</h1>
      <section className="tstrip" aria-label="House market and live totals">
        {hero ? <HeroBar v={hero} stat={stats.data?.get(hero.acct.key.toBase58())} mover={mover?.move ?? null} /> : <span className="skeleton" style={{ height: 48, flex: 1 }} />}
        <Totals markets={data ?? []} burnPot={burn.data?.pot ?? null} feed={feed.data} />
      </section>

      <section className="tgrid board-tgrid">
        <LiveTraders feed={feed.data} feedLoading={feed.loading} feedError={feed.error} />
        <div className="tcard tchart-card">
          {hero ? <HeroChart v={hero} feed={feed.data} wins={wins.data?.wins} moves={moves.get(hero.acct.key.toBase58()) ?? 0} /> : <span className="skeleton" style={{ height: 420 }} />}
        </div>
        <div className="tcol">
          {hero ? <HeroTicket v={hero} /> : <span className="skeleton" style={{ height: 320 }} />}
          <SpawnCard />
          <HouseRules />
        </div>
      </section>

      <section className="tmarkets" aria-label="Every market">
        <header className="tmarkets-head">
          <div>
            <h2>Markets</h2>
            <p className="muted">Anyone can list any coin. The same coin twice is a sibling, not a dupe: another pool, quote or TWAP window. The thin side pays most.</p>
          </div>
          <SortChips sort={sort} onChange={setSort} stats={statsState} />
        </header>
        <div className="tmarkets-filters">
          <CatFilter cat={cat} onChange={setCat} counts={counts} />
          {(pinnedCount > 0 || pinsOnly) && (
            <button type="button" className="chip pin-chip" aria-pressed={pinsOnly} onClick={() => setPinsOnly((p) => !p)} title="Only the markets you pinned (♥ on a row)">
              ♥ Pinned <span className="num">{pinnedCount}</span>
            </button>
          )}
          <div className="themes" role="tablist" aria-label="Market buckets">
            {THEMES.map((t) => (
              <button key={t} role="tab" className="chip" aria-selected={theme === t} aria-pressed={theme === t} onClick={() => setTheme(t)}>
                {t} <span className="num">{count(t)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="mtable" role="table" aria-label="Markets" aria-busy={loading && !data}>
          <div className="mrow mhead" role="row">
            <span role="columnheader">Market</span>
            <span role="columnheader" className="r">
              Mark
            </span>
            <span role="columnheader" className="r">
              Since settle
            </span>
            <span role="columnheader" className="hide-md">
              Oracle
            </span>
            <span role="columnheader">Pots</span>
            <span role="columnheader" className="r">
              UP pays
            </span>
            <span role="columnheader" className="r">
              DOWN pays
            </span>
            <SortHead id="disparity" sort={sort} onSort={setSort}>
              Disparity
            </SortHead>
            <SortHead id="volume" sort={sort} onSort={setSort}>
              24h vol
            </SortHead>
            <SortHead id={sort === "oldest" ? "newest" : "oldest"} on={sort === "oldest" || sort === "newest"} sort={sort} onSort={setSort}>
              Listed {sort === "oldest" ? "↑" : sort === "newest" ? "↓" : ""}
            </SortHead>
            <span role="columnheader" aria-label="Pin and share" />
          </div>
          {loading && !data && [0, 1, 2, 3].map((i) => <span key={i} className="skeleton mrow-skel" aria-hidden />)}
          {groups.map((g) =>
            [g.lead, ...g.siblings].map((v, i) => (
              <MarketRow
                key={v.acct.key.toBase58()}
                v={v}
                all={data ?? []}
                lead={i ? g.lead : null}
                sibs={i ? 0 : g.siblings.length}
                stat={stats.data?.get(v.acct.key.toBase58())}
                moves={moves.get(v.acct.key.toBase58()) ?? 0}
              />
            )),
          )}
          {data && groups.length === 0 && (
            <div className="mtable-empty">
              {pinsOnly ? (
                <p className="note">Nothing pinned here. Tap the ♡ on any market to keep it at the top.</p>
              ) : cat ? (
                <CatEmpty cat={cat} />
              ) : (
                <p className="note">
                  Nothing in this bucket. <Link to="/new">Cook one up</Link>.
                </p>
              )}
            </div>
          )}
          {error && !data && <p className="err mtable-empty">Couldn't reach the chain: {error}</p>}
        </div>
        <div className="list-cta">
          <span className="num">any coin with a pool · paste CA · sign once</span>
          <Link className="btn signal" to="/new">
            + New market
          </Link>
        </div>
      </section>

      <Runners />

      <details className="fine math" id="fine">
        <summary className="meta">the math →</summary>
        <div className="math-grid">
          <p>
            <b>Per tick</b> · loser pays <span className="num">1 − 1.0001<sup>−100·|Δtick|</sup></span> of its pot. 1% ≈ 63%, 5% ≈ 99%, never 100%.
          </p>
          <p>
            <b>Payout</b> · <span className="num">100 × their pot ÷ yours</span>. Empty side pays most.
          </p>
          <p>
            <b>Out</b> · sell to curve or cash out the pot, −4%. 20% of <i>gain</i> backs the{" "}
            <a href={RAISE_URL} target="_blank" rel="noopener noreferrer">
              raise
            </a>
            .
          </p>
          <p>
            <b>Fees</b> · 4% in/out → 60% pots, 30% burns $100XBRO, 10% burns BABY100X. <a href="/api">/api</a>.
          </p>
        </div>
      </details>
      <CoinStrip />
      {data && data.length === 0 && (
        <div className="empty">
          <div className="display">Nothing cooking yet.</div>
          <Link className="btn signal" to="/new">
            Cook the first one
          </Link>
        </div>
      )}
    </>
  );
}

/** A column header that sorts the table (the same ?sort= as the chips). */
function SortHead({ id, sort, onSort, on, children }: { id: Sort; sort: Sort; onSort: (s: Sort) => void; on?: boolean; children: React.ReactNode }) {
  const active = on ?? sort === id;
  return (
    <span role="columnheader" className="r" aria-sort={active ? (sort === "oldest" ? "ascending" : "descending") : "none"}>
      <button type="button" className={`sorth ${active ? "on" : ""}`} onClick={() => onSort(id)}>
        {children}
      </button>
    </span>
  );
}

/** The house market as the strip's lead: coin, best payout, mark, move, volume, range, age. */
function HeroBar({ v, stat, mover }: { v: MarketView; stat?: MarketStat; mover: number | null }) {
  const under = useUnderlying(v.underlyingMint);
  const ticker = under?.symbol ?? v.ticker;
  return (
    <MarketBar v={v} ticker={ticker} image={under?.image} stat={stat} to={`/m/${v.acct.key.toBase58()}`}>
      {mover !== null && v.underlyingMint !== MEME_MINT.toBase58() && (
        <span className="chip mover-chip" title="$100XBRO's chart is flat, so the biggest mover on the board takes the hero slot until it moves">
          biggest mover · {mover >= 0 ? "+" : "−"}
          {Math.abs(mover * 100).toFixed(2)}%
        </span>
      )}
    </MarketBar>
  );
}

/** The site's live totals, inline: money on the table, SOL won today, the last pot-to-pot payout, the 0/20 tally. */
function Totals({ markets, burnPot, feed }: { markets: MarketView[]; burnPot: bigint | null; feed: Ev[] | undefined }) {
  const px = usePrices();
  const pots = markets.reduce((n, v) => n + v.side[0].vault + v.side[1].vault, 0n);
  const curves = markets.reduce((n, v) => n + v.side[0].reserve + v.side[1].reserve, 0n);
  const tvl = markets.length > 0 ? px.quoteUsd(pots + curves + (burnPot ?? 0n)) : null;
  const wins = usePoll(fetchWinners, [], 30_000);
  const backed = usePoll(async () => (await (await fetch("/api/backed")).json()) as { usd: number; txs: number; backers: number }, [], 60_000);
  const paid = (feed ?? []).find((e) => e.paid);
  const paidUsd = paid?.paid ? px.quoteUsd(BigInt(paid.paid.amount)) : null;
  const now = Math.floor(Date.now() / 1000);
  const day = (wins.data?.wins ?? []).filter((w) => w.ts >= now - DAY);
  const won24 = day.reduce((a, w) => a + w.gain_sol, 0);
  const best = day.reduce<(typeof day)[number] | null>((b, w) => (!b || w.gain_sol > b.gain_sol ? w : b), null);
  const lastWin = wins.data?.wins[0];
  return (
    <div className="totals" aria-label="Live totals">
      <div className="mbar-cell">
        <span className="meta">
          On the table {tvl !== null && <Tweet text={`${usd(tvl)} on the table across ${markets.length} markets on 100x.broker`} path="/" />}
        </span>
        <b className="num">{tvl !== null ? <Rolling value={tvl} format={usdShort} /> : "—"}</b>
        <span className="sub num">{markets.length} markets</span>
      </div>
      <Link className="mbar-cell" to="/winners">
        <span className="meta">Won · 24h</span>
        <b className="num up">{wins.data ? <Rolling value={won24} format={(n) => `+${n.toFixed(3)} SOL`} /> : "—"}</b>
        <span className="sub num">
          {wins.data ? (day.length ? `${day.length} wins · best ${short(best!.wallet)}` : lastWin ? `quiet · last ${ago(lastWin.ts)}` : "first green exit leads") : "counting…"}
        </span>
      </Link>
      <Link className="mbar-cell" to={paid ? `/m/${paid.market}` : "/"}>
        <span className="meta">Last payout</span>
        <b className="num">
          {paid && paidUsd !== null ? (
            <Flash watch={paid.sig}>
              <span className={paid.paid!.from === 0 ? "up" : "down"}>{SIDE[paid.paid!.from]}</span>→<span className={paid.paid!.to === 0 ? "up" : "down"}>{SIDE[paid.paid!.to]}</span> {usdShort(paidUsd)}
            </Flash>
          ) : feed ? (
            "quiet"
          ) : (
            "…"
          )}
        </b>
        <span className="sub num">{paid ? `$${paid.ticker} · ${ago(paid.ts)}` : "no payout yet"}</span>
      </Link>
      <a className="mbar-cell" href={RAISE_URL} target="_blank" rel="noopener noreferrer">
        <span className="meta">0/20 · backed</span>
        <b className="num">{backed.data ? <Rolling value={backed.data.usd} format={usdShort} /> : "—"}</b>
        <span className="sub num">{backed.data ? `${backed.data.backers} wallets · closes Oct 18` : "counting…"}</span>
      </a>
    </div>
  );
}

type LiveTab = "live" | "bags" | "volume";
/** The left rail: what's happening across the board (live moves), the biggest bags, and who moved the most SOL today. */
function LiveTraders({ feed, feedLoading, feedError }: { feed: Ev[] | undefined; feedLoading: boolean; feedError: string | null }) {
  const [tab, setTab] = useState<LiveTab>("live");
  const px = usePrices();
  const bags = usePoll(() => (tab === "bags" ? fetchWallets() : Promise.resolve(null)), [tab], 30_000);
  const active = usePoll(() => (tab === "volume" ? fetchActive(24) : Promise.resolve(null)), [tab], 60_000);
  let rows: TRow[] | undefined;
  let busy = false;
  let err: string | null = null;
  if (tab === "live") {
    rows = feed?.map((e) => eventRow(e, px.quoteUsd, true)).filter((r): r is TRow => !!r).slice(0, 24);
    busy = feedLoading;
    err = feedError;
  } else if (tab === "bags") {
    rows = bags.data?.slice(0, 20).map((w) => ({
      id: w.owner,
      wallet: w.owner,
      title: short(w.owner),
      sub: w.biggest ? `${SIDE[w.biggest.side]} · $${w.biggest.ticker}` : `${w.positions} positions`,
      tone: w.biggest ? (w.biggest.side === 0 ? "up" : "down") : "",
      value: usd(w.valueUsd),
      valueSub: `${w.positions} pos`,
      to: `/p/${w.owner}`,
    }));
    busy = bags.loading;
    err = bags.error;
  } else {
    rows = active.data?.map((a) => {
      const volSol = px.quoteSol(BigInt(a.in) + BigInt(a.out));
      const net = px.quoteSol(BigInt(a.net));
      return {
        id: a.owner,
        wallet: a.owner,
        title: short(a.owner),
        sub: a.top ? `${a.trades} trades · ${SIDE[a.top.side]} $${a.top.ticker}` : `${a.trades} trades`,
        tone: (net ?? 0) > 0 ? "up" : (net ?? 0) < 0 ? "down" : "",
        value: volSol !== null ? `${volSol.toFixed(2)} SOL` : "—",
        valueSub: net !== null ? `net ${net >= 0 ? "+" : "−"}${Math.abs(net).toFixed(3)}` : undefined,
        to: `/p/${a.owner}`,
      } satisfies TRow;
    });
    busy = active.loading;
    err = active.error;
  }
  return (
    <TraderList<LiveTab>
      tabs={[
        { id: "live", label: "Live" },
        { id: "bags", label: "Biggest bags" },
        { id: "volume", label: "Volume 24h" },
      ]}
      tab={tab}
      onTab={setTab}
      rows={rows}
      loading={busy}
      error={err}
      ranked={tab !== "live"}
      empty={tab === "live" ? "Crickets. First move gets the cheapest side." : tab === "bags" ? "No bags yet. Yours could be first." : "Nobody traded in 24h. Be the first degen."}
      footer={
        <Link to="/winners" className="more">
          Leaderboard →
        </Link>
      }
    />
  );
}

/** The hero market's chart: the oracle line with our wordmark behind it and every trade on it floating up as it lands. */
function HeroChart({ v, feed, wins, moves }: { v: MarketView; feed: Ev[] | undefined; wins: import("../lib/feed").Win[] | undefined; moves: number }) {
  const under = useUnderlying(v.underlyingMint);
  const px = usePrices();
  const ticker = under?.symbol ?? v.ticker;
  const refWallet = useRefWallet();
  const twap = v.oracle.twap ?? v.oracle.lastTwap;
  const chg = v.oracle.lastTwap > 0 ? twap / v.oracle.lastTwap - 1 : 0;
  const key = v.acct.key.toBase58();
  return (
    <>
      <TermChart v={v} ticker={ticker} fmt={(p) => px.oracleFmt(p, v.oracle.quote, ticker)} events={feed} wins={wins} />
      <div className="tchart-foot">
        <span className="meta">
          {v.pending ? (
            <>
              <b className={v.pending.payer === 0 ? "up" : "down"}>{SIDE[v.pending.payer]}</b> owes <b className="num">{usd(px.quoteUsd(v.pending.amount))}</b> on the next tick
            </>
          ) : (
            "pots square"
          )}
          {" · "}
          {moves ? <Flash watch={moves}>{moves} moves · 1h</Flash> : `observed ${ago(v.oracle.updatedTs)}`}
        </span>
        <span className="tchart-share">
          <PinButton v={v} ticker={ticker} />
          <CardShare
            text={`$${ticker} ${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(2)}% · UP pays ${lev(v.side[0].leverage)}, DOWN pays ${lev(v.side[1].leverage)}. No liquidations.`}
            path={`/m/${key}`}
            target={marketShare(v, ticker, refWallet)}
          />
        </span>
      </div>
    </>
  );
}

/** The ticket slot on the board: leverage right now on both sides, and the two doors into the market's real ticket. */
function HeroTicket({ v }: { v: MarketView }) {
  const under = useUnderlying(v.underlyingMint);
  const px = usePrices();
  const ticker = under?.symbol ?? v.ticker;
  const key = v.acct.key.toBase58();
  const twap = v.oracle.twap ?? v.oracle.lastTwap;
  const total = v.side[0].vault + v.side[1].vault;
  const upShare = total > 0n ? Number(v.side[0].vault) / Number(total) : 0.5;
  const thin = thinSide(v);
  return (
    <section className="tcard tticket" aria-label={`Trade $${ticker}`}>
      <header>
        <h2>${ticker}</h2>
        <span className="num">{px.oracleFmt(twap, v.oracle.quote, ticker)}</span>
      </header>
      <div className="levnow">
        <span className="meta">Leverage right now</span>
        <div className="levnow-sides">
          {([0, 1] as const).map((i) => (
            <Link key={i} to={`/m/${key}?side=${i}`} className={`levnow-side ${i === 0 ? "up" : "down"} ${thin === i ? "thin" : ""}`}>
              <span className="meta">{SIDE[i]}</span>
              <Flash watch={v.side[i].leverage} as="b" className="num">
                {lev(v.side[i].leverage)}
              </Flash>
              <span className="sub num">{usd(px.quoteUsd(v.side[i].vault))} pot</span>
            </Link>
          ))}
        </div>
        <div className="levnow-bar" role="img" aria-label={total > 0n ? `UP pot ${Math.round(upShare * 100)}%, DOWN ${100 - Math.round(upShare * 100)}%` : "Both pots empty"}>
          {total > 0n ? (
            <>
              <i className="u" style={{ flexGrow: Math.max(upShare, 0.01) }} />
              <i className="d" style={{ flexGrow: Math.max(1 - upShare, 0.01) }} />
            </>
          ) : (
            <i className="n" />
          )}
        </div>
        <span className="sub">{total > 0n ? `${disparityLabel(v)} · the thin side pays 100 × their pot ÷ yours` : "Both pots empty: the first buy on either side sets the odds."}</span>
      </div>
      <div className="big-sides">
        <Link className="bigside up" to={`/m/${key}?side=0`}>
          UP <span className="num">{lev(v.side[0].leverage)}</span>
        </Link>
        <Link className="bigside down" to={`/m/${key}?side=1`}>
          DOWN <span className="num">{lev(v.side[1].leverage)}</span>
        </Link>
      </div>
      <p className="fineprint">Opens the full ticket. SOL stakes to r-freestacc and buys your side in one transaction. 4% in, 4% out, no liquidations.</p>
      <dl className="est">
        <div>
          <dt>Oracle</dt>
          <dd>{marketTag(v)}</dd>
        </div>
        {([0, 1] as const).map((i) => (
          <div key={i}>
            <dt>{SIDE[i]} owes</dt>
            <dd className={v.side[i].owed > 0.1 ? "warn-ink" : ""}>{v.side[i].owed > 1e-6 ? `${(v.side[i].owed * 100).toFixed(1)}% of curve` : "nothing"}</dd>
          </div>
        ))}
        <div>
          <dt>Payout token</dt>
          <dd>SOL</dd>
        </div>
      </dl>
    </section>
  );
}

/** Spawning is the point: paste any coin's mint and list a market on it. Siblings welcome. */
function SpawnCard() {
  const nav = useNavigate();
  const [ca, setCa] = useState("");
  const ok = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca.trim());
  const go = (e: FormEvent) => {
    e.preventDefault();
    nav(ok ? `/new?mint=${ca.trim()}` : "/new");
  };
  return (
    <form className="tcard spawn-card" onSubmit={go} aria-label="List a new market">
      <h2>Spawn a market</h2>
      <p className="muted">Any coin with a pool. Already listed? List it again on another pool, quote or window: siblings sit side by side.</p>
      <div className="spawn-row">
        <input value={ca} onChange={(e) => setCa(e.target.value)} placeholder="Paste a mint address" aria-label="Coin mint address" spellCheck={false} autoComplete="off" aria-invalid={ca !== "" && !ok} />
        <button className="btn signal" type="submit">
          {ok ? "List it" : "Browse"}
        </button>
      </div>
      {ca !== "" && !ok && <span className="err">That isn't a mint address.</span>}
    </form>
  );
}

/** One market as a table row. Siblings render right under their group's lead with what tells them apart. */
function MarketRow({ v, all, lead, sibs, stat, moves }: { v: MarketView; all: MarketView[]; lead: MarketView | null; sibs: number; stat?: MarketStat; moves: number }) {
  const nav = useNavigate();
  const pinned = usePins().isPinned(v);
  const under = useUnderlying(v.underlyingMint);
  const px = usePrices();
  const refWallet = useRefWallet();
  const key = v.acct.key.toBase58();
  const ticker = under?.symbol ?? v.ticker;
  const twap = v.oracle.twap ?? v.oracle.lastTwap;
  const chg = v.oracle.lastTwap > 0 ? twap / v.oracle.lastTwap - 1 : 0;
  const dir = chg > 1e-9 ? "up" : chg < -1e-9 ? "down" : "";
  const hot = moves >= 3;
  const go = () => nav(`/m/${key}`);
  const owed = v.side[0].owed > 1e-6 ? 0 : v.side[1].owed > 1e-6 ? 1 : null;
  const total = v.side[0].vault + v.side[1].vault;
  const upShare = total > 0n ? Number(v.side[0].vault) / Number(total) : 0.5;
  const thin = thinSide(v);
  const d = disparity(v);
  return (
    <div
      role="row"
      className={`mrow ${lead ? "sib" : ""} ${sibs ? "has-sibs" : ""} ${hot ? "hot" : ""} ${pinned ? "pinned" : ""}`}
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go())}
      aria-label={`${ticker} market${lead ? `, sibling of ${lead.ticker}` : ""}`}
    >
      <span role="cell" className="c-mkt">
        {lead && (
          <span className="sib-mark" aria-hidden>
            ↳
          </span>
        )}
        {under?.image ? <img className="tokimg" src={under.image} alt="" /> : <span className="tokimg ph" aria-hidden />}
        <span className="c-mkt-id">
          <span className="c-mkt-top">
            <b>${ticker}</b>
            <span className="muted">/{v.oracle.quote}</span>
            {hot && <span className="hot-badge">HOT</span>}
            {lead ? <span className="chip sib-chip">sibling · {relation(v, lead)}</span> : sibs > 0 && <span className="chip sib-chip">+{sibs} sibling{sibs > 1 ? "s" : ""}</span>}
            {owed !== null && <span className="owed">{SIDE[owed]} owes</span>}
          </span>
          <span className="c-mkt-tag meta">{marketTag(v, all)}</span>
        </span>
      </span>
      <span role="cell" className="c-px r num">
        <Flash watch={twap} className={dir}>
          {px.oracleFmt(twap, v.oracle.quote, ticker)}
        </Flash>
      </span>
      <span role="cell" className="c-chg r">
        <Delta x={chg} dp={2} />
      </span>
      <span role="cell" className="c-spark hide-md">
        <Sparkline series={v.oracle.series} base={v.oracle.lastTwap} w={120} h={30} />
      </span>
      <span role="cell" className="c-pots">
        <span className="potbar" aria-hidden>
          {total > 0n ? (
            <>
              <i className="u" style={{ flexGrow: Math.max(upShare, 0.01) }} />
              <i className="d" style={{ flexGrow: Math.max(1 - upShare, 0.01) }} />
            </>
          ) : (
            <i className="n" />
          )}
        </span>
        <span className="potnums num">
          <span className="up">{usdShort(px.quoteUsd(v.side[0].vault))}</span>
          <span className="down">{usdShort(px.quoteUsd(v.side[1].vault))}</span>
        </span>
      </span>
      <span role="cell" className="c-up r">
        <Link to={`/m/${key}?side=0`} className={`pay up ${thin === 0 ? "thin" : ""}`} onClick={(e) => e.stopPropagation()}>
          <Flash watch={v.side[0].leverage} as="b" className="num">
            {lev(v.side[0].leverage)}
          </Flash>
        </Link>
      </span>
      <span role="cell" className="c-down r">
        <Link to={`/m/${key}?side=1`} className={`pay down ${thin === 1 ? "thin" : ""}`} onClick={(e) => e.stopPropagation()}>
          <Flash watch={v.side[1].leverage} as="b" className="num">
            {lev(v.side[1].leverage)}
          </Flash>
        </Link>
      </span>
      <span role="cell" className={`c-disp r num ${d === 0 ? "muted" : ""}`} title="Thick pot ÷ thin pot: how lopsided the book is">
        {thin !== null && d > 0 && <i className={`thin-dot ${thin === 0 ? "up" : "down"}`} aria-hidden />}
        {disparityLabel(v)}
      </span>
      <span role="cell" className="c-vol r num">
        {stat ? (stat.vol !== null ? usdShort(px.quoteUsd(BigInt(stat.vol))) : "—") : "—"}
        {stat && stat.trades > 0 && <span className="sub">{stat.trades} trades</span>}
      </span>
      <span role="cell" className="c-age r num">
        {stat ? age(stat.born) : "—"}
      </span>
      <span role="cell" className="c-act">
        <PinButton v={v} ticker={ticker} />
        <CardShare
          text={`$${ticker} ${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(2)}% · UP pays ${lev(v.side[0].leverage)}, DOWN pays ${lev(v.side[1].leverage)}. No liquidations.`}
          path={`/m/${key}`}
          target={marketShare(v, ticker, refWallet)}
        />
      </span>
    </div>
  );
}
