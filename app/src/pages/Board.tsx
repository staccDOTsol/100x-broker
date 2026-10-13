// / — the board (Monitor + Decide): one hero chart, the live feed beside it, then every market as a moving card. Copy is minimal;
// the numbers do the talking. Everything on this page is polled from /api/markets, /api/feed, /api/winners and /api/backed.
import { useEffect, useMemo, useState } from "react";
import { RAISE_URL } from "../lib/backable";
import { Link, useNavigate } from "react-router-dom";
import { usePoll } from "../hooks";
import { listMarketKeys, loadMarketView, type MarketView } from "../lib/chain";
import { fetchViews } from "../lib/views";
import { loadBurnPot } from "../lib/burn";
import { OraclePrice, Tug } from "../components/bits";
import { useUnderlying } from "../hooks/underlying";
import { ActiveWallets, Feed, Wallets } from "../components/Live";
import { CoinStrip } from "../components/Coin";
import { Runners } from "../components/Runners";
import { Delta, Flash, Rolling, Sparkline } from "../components/Pulse";
import { ago, lev, short, usd, usdPrice } from "../lib/format";
import { fetchFeed, fetchWinners, type Ev } from "../lib/feed";
import { marketShare, useRefWallet } from "../components/Flex";
import { CardShare, Tweet } from "../components/Share";
import { usePrices } from "../hooks/price";
import { HERO_MARKETS, MEME_MINT } from "../config";

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

export default function Board() {
  const { data, error, loading } = usePoll(loadBoard, []);
  const burn = usePoll(loadBurnPot, []);
  const feed = usePoll(() => fetchFeed(), [], 6_000);
  const [theme, setTheme] = useState<Theme>("all");
  const moves = useMemo(() => movesByMarket(feed.data), [feed.data]);
  const hero = HERO_MARKETS.map((k) => data?.find((v) => v.acct.key.toBase58() === k)).find((v): v is MarketView => !!v) ?? data?.[0];
  const cards = (data ?? [])
    .filter((v) => v !== hero && (theme === "all" || themeOf(v) === theme))
    .sort((a, b) => (moves.get(b.acct.key.toBase58()) ?? 0) - (moves.get(a.acct.key.toBase58()) ?? 0) || Number(b.side[0].vault + b.side[1].vault - (a.side[0].vault + a.side[1].vault)));
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
      <section className="board-head">
        <div className="board-pitch">
          <h1 className="display">
            Your next{" "}
            {bestLev !== null ? (
              <Flash watch={bestLev} as="span" className="num">
                {lev(bestLev)}
              </Flash>
            ) : (
              "100×"
            )}
            .
            <br />
            <span className="up">Up</span> or <span className="down">down</span>.
          </h1>
          <p className="pitch num">no liquidations · settles in SOL · pays every tick</p>
        </div>
        <Rail markets={data ?? []} burnPot={burn.data?.pot ?? null} feed={feed.data} />
      </section>

      <section className="board-main">
        {hero ? <Hero v={hero} house={hero.underlyingMint === MEME_MINT.toBase58()} moves={moves.get(hero.acct.key.toBase58()) ?? 0} /> : <div className="skeleton hero-skel" aria-hidden />}
        <aside className="live-aside" aria-label="Live activity">
          <h2 className="meta">
            <span className="live-dot" aria-hidden />
            Live · who's doing what
            <span className="right num">{feed.data ? `${feed.data.filter((e) => e.ts >= Date.now() / 1000 - HOUR).length}/h` : ""}</span>
          </h2>
          <Feed limit={16} />
        </aside>
      </section>

      <Runners />

      <div className="boards-head">
        <h2 className="display">Every board.</h2>
        <span className="muted">empty side pays most</span>
        <div className="themes" role="tablist" aria-label="Market buckets">
          {THEMES.map((t) => (
            <button key={t} role="tab" className="chip" aria-selected={theme === t} aria-pressed={theme === t} onClick={() => setTheme(t)}>
              {t} <span className="num">{count(t)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="cards">
        {loading && !data && [0, 1, 2, 3].map((i) => <span key={i} className="skeleton card-skel" aria-hidden />)}
        {cards.map((v) => (
          <Card key={v.acct.key.toBase58()} v={v} moves={moves.get(v.acct.key.toBase58()) ?? 0} />
        ))}
        {data && cards.length === 0 && (
          <p className="note">
            Nothing in this bucket. <Link to="/new">Cook one up</Link>.
          </p>
        )}
      </div>
      <div className="list-cta">
        <span className="num">any Raydium coin · paste CA · sign once</span>
        <Link className="btn ghost" to="/new">
          List a coin
        </Link>
      </div>

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
            <b>Fees</b> · 4% in/out → 60% pots, 30% burns $100XBRO, 10% burns BABY100X. <Link to="/yield">Vaults</Link> · <a href="/api">/api</a>.
          </p>
        </div>
      </details>
      <CoinStrip />

      {data && data.length > 0 && (
        <section className="live-grid">
          <div>
            <h2 className="meta">Biggest bags</h2>
            <Wallets />
          </div>
          <div>
            <h2 className="meta">Most volume · 24h</h2>
            <ActiveWallets hours={24} />
          </div>
        </section>
      )}
      {data && data.length === 0 && (
        <div className="empty">
          <div className="display">Nothing cooking yet.</div>
          <Link className="btn" to="/new">
            Cook the first one
          </Link>
        </div>
      )}
      {error && !data && <p className="err">Couldn't reach the chain: {error}</p>}
    </>
  );
}

/** Four live cells beside the headline: money on the table, SOL won today, the last pot-to-pot payout, the 0/20 tally. */
function Rail({ markets, burnPot, feed }: { markets: MarketView[]; burnPot: bigint | null; feed: Ev[] | undefined }) {
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
    <div className="rail" aria-label="Live totals">
      <div className="cell-wrap">
        <a className="cell" id="tvl" href="#tvl">
          <span className="meta">
            <i className="live" aria-hidden /> On the table
          </span>
          <strong className="display num">{tvl !== null ? <Rolling value={tvl} format={usd} /> : "—"}</strong>
          <span className="meta num">{markets.length} markets · both pots</span>
        </a>
        {tvl !== null && <Tweet text={`${usd(tvl)} on the table across ${markets.length} markets on 100x.broker`} path="/" />}
      </div>
      <div className="cell-wrap">
        <Link className="cell won" to="/winners">
          <span className="meta">Won · 24h</span>
          <strong className="display num up">{wins.data ? <Rolling value={won24} format={(n) => `+${n.toFixed(3)} SOL`} /> : "—"}</strong>
          <span className="meta num">
            {wins.data
              ? day.length
                ? `${day.length} wins · best ${short(best!.wallet)} +${best!.gain_sol.toFixed(3)}`
                : lastWin
                  ? `quiet · last ${ago(lastWin.ts)}`
                  : "first green exit leads"
              : "counting…"}
          </span>
        </Link>
        {wins.data && day.length > 0 && <Tweet text={`+${won24.toFixed(3)} SOL won in 24h on 100x.broker · ${day.length} wins`} path="/winners" />}
      </div>
      <div className="cell-wrap">
        <Link className="cell paid" to={paid ? `/m/${paid.market}` : "/"}>
          <span className="meta">
            <i className="live" aria-hidden /> Last payout
          </span>
          <strong className="display num">
            {paid && paidUsd !== null ? (
              <Flash watch={paid.sig}>
                <b className={paid.paid!.from === 0 ? "up" : "down"}>{SIDE[paid.paid!.from]}</b>
                <span className="arrow">→</span>
                <b className={paid.paid!.to === 0 ? "up" : "down"}>{SIDE[paid.paid!.to]}</b> {usd(paidUsd)}
              </Flash>
            ) : feed ? (
              "quiet"
            ) : (
              "…"
            )}
          </strong>
          <span className="meta num">{paid ? `$${paid.ticker} · ${ago(paid.ts)}` : "no payout yet"}</span>
        </Link>
        {paid && paidUsd !== null && (
          <Tweet text={`$${paid.ticker}: ${SIDE[paid.paid!.from]} just paid ${SIDE[paid.paid!.to]} ${usd(paidUsd)} on 100x.broker`} path={`/m/${paid.market}`} />
        )}
      </div>
      <div className="cell-wrap">
        <a className="cell backed" href={RAISE_URL} target="_blank" rel="noopener noreferrer">
          <span className="meta">0/20 · backed</span>
          <strong className="display num">{backed.data ? <Rolling value={backed.data.usd} format={usd} /> : "—"}</strong>
          <span className="meta num">{backed.data ? `${backed.data.backers} wallets · closes Oct 18` : "counting…"}</span>
        </a>
        {backed.data && <Tweet text={`${usd(backed.data.usd)} backed by ${backed.data.backers} wallets · 0/20 on 100x.broker`} path="/" />}
      </div>
    </div>
  );
}

/** The hero: one market as a chart card. Price, change, the oracle drawn big, the pots, and two doors. */
function Hero({ v, house, moves }: { v: MarketView; house: boolean; moves: number }) {
  const key = v.acct.key.toBase58();
  const under = useUnderlying(v.underlyingMint);
  const px = usePrices();
  const refWallet = useRefWallet();
  const ticker = under?.symbol ?? v.ticker;
  const twap = v.oracle.twap ?? v.oracle.lastTwap;
  const chg = v.oracle.lastTwap > 0 ? twap / v.oracle.lastTwap - 1 : 0;
  const dir = chg > 1e-9 ? "up" : chg < -1e-9 ? "down" : "";
  const empty: 0 | 1 | null = v.side[0].leverage > v.side[1].leverage && Number.isFinite(v.side[0].leverage) ? 0 : v.side[1].leverage > v.side[0].leverage && Number.isFinite(v.side[1].leverage) ? 1 : null;
  return (
    <section className={`hero-card ${house ? "house" : ""}`} aria-label={`${ticker} market`}>
      <div className="hc-head">
        <span className="meta hc-kicker">{house ? "The coin · 30% of every fee burns it" : "House special"} · Raydium TWAP · {Math.round(v.acct.windowSecs / 60)} min</span>
        <Link to={`/m/${key}`} className="display hc-ticker">
          {under?.image && <img className="tokimg hero-img" src={under.image} alt="" />}${ticker}
          <small className="hq">/ {v.oracle.quote}</small>
        </Link>
        <Flash watch={twap} className={`hc-px num ${dir}`}>
          <OraclePrice x={twap} quote={v.oracle.quote} ticker={ticker} />
        </Flash>
        <Delta x={chg} dp={3} className="badge-delta" />
        <CardShare
          text={`$${ticker} ${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(2)}% · UP pays ${lev(v.side[0].leverage)}, DOWN pays ${lev(v.side[1].leverage)}. No liquidations.`}
          path={`/m/${key}`}
          target={marketShare(v, ticker, refWallet)}
        />
        <span className="meta num hc-moves right">
          {moves ? <Flash watch={moves}>{moves} moves · 1h</Flash> : `observed ${ago(v.oracle.updatedTs)}`}
        </span>
      </div>
      <div className="hc-chart">
        <Sparkline series={v.oracle.series} base={v.oracle.lastTwap} w={600} h={220} className="big" label={`${ticker} oracle, last hour`} />
        <span className="meta hc-cap">
          — — where the pots last settled ·{" "}
          {v.pending ? (
            <>
              <b className={v.pending.payer === 0 ? "up" : "down"}>{SIDE[v.pending.payer]}</b> owes <b className="num">{usd(px.quoteUsd(v.pending.amount))}</b> on the next tick
            </>
          ) : (
            "square"
          )}
        </span>
      </div>
      <div className="hc-pots">
        <Tug up={v.side[0].vault} down={v.side[1].vault} levUp={v.side[0].leverage} levDown={v.side[1].leverage} size="lg" />
      </div>
      <div className="hc-doors">
        {([0, 1] as const).map((i) => (
          <Link key={i} to={`/m/${key}?side=${i}`} className={`door ${i === 0 ? "u" : "d"}`}>
            <span className="meta">{i === 0 ? "long it" : "short it"}</span>
            <span className="display">
              {i === 0 ? "Up" : "Down"} <Flash watch={v.side[i].leverage} as="b" className="num">{lev(v.side[i].leverage)}</Flash>
            </span>
            <span className="num">
              pays <Flash watch={v.side[i].leverage} as="b">{lev(v.side[i].leverage)}</Flash> if right · {usdPrice(px.priceUsd(v.side[i].curvePrice))}
            </span>
            {empty === i && <span className="sticker">empty side · the trade</span>}
          </Link>
        ))}
      </div>
    </section>
  );
}

/** One market as a card: ticker, price, change, sparkline, pots, both payouts. HOT when it's moving. */
function Card({ v, moves }: { v: MarketView; moves: number }) {
  const nav = useNavigate();
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
  return (
    <article
      className={`card ${hot ? "hot" : ""} ${dir}`}
      tabIndex={0}
      role="link"
      onClick={go}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go())}
      aria-label={`${ticker} market`}
    >
      <div className="card-head">
        <span className="display card-ticker">
          {under?.image && <img className="tokimg" src={under.image} alt="" />}${ticker}
        </span>
        <span className="muted hq">/ {v.oracle.quote}</span>
        {hot && <span className="hot-badge">HOT</span>}
        {owed !== null && !hot && <span className="owed">{SIDE[owed]} underwater</span>}
        <span className="right">
          <CardShare
            text={`$${ticker} ${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(2)}% · UP pays ${lev(v.side[0].leverage)}, DOWN pays ${lev(v.side[1].leverage)}. No liquidations.`}
            path={`/m/${key}`}
            target={marketShare(v, ticker, refWallet)}
          />
        </span>
      </div>
      <div className="card-px num">
        <Flash watch={twap} className={dir}>
          {px.oracleFmt(twap, v.oracle.quote, ticker)}
        </Flash>
        <Delta x={chg} dp={2} />
      </div>
      <Sparkline series={v.oracle.series} base={v.oracle.lastTwap} w={240} h={64} className="card-spark" />
      <div className="card-foot">
        <Tug up={v.side[0].vault} down={v.side[1].vault} levUp={v.side[0].leverage} levDown={v.side[1].leverage} />
        <div className="card-doors num">
          <Link to={`/m/${key}?side=0`} className="up" onClick={(e) => e.stopPropagation()}>
            UP <Flash watch={v.side[0].leverage} as="b">{lev(v.side[0].leverage)}</Flash>
          </Link>
          <span className="muted">{moves ? `${moves} moves · 1h` : ago(v.oracle.updatedTs)}</span>
          <Link to={`/m/${key}?side=1`} className="down" onClick={(e) => e.stopPropagation()}>
            <Flash watch={v.side[1].leverage} as="b">{lev(v.side[1].leverage)}</Flash> DOWN
          </Link>
        </div>
      </div>
    </article>
  );
}
