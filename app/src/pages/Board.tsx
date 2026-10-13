import { useEffect, useRef, useState } from "react";
import { RAISE_URL } from "../lib/backable";
import { Link, useNavigate } from "react-router-dom";
import { usePoll } from "../hooks";
import { listMarketKeys, loadMarketView, type MarketView } from "../lib/chain";
import { fetchViews } from "../lib/views";
import { loadBurnPot } from "../lib/burn";
import { OraclePrice, Tug } from "../components/bits";
import { useUnderlying } from "../hooks/underlying";
import { ActiveWallets, Feed, Tape, Wallets } from "../components/Live";
import { CoinStrip } from "../components/Coin";
import { ago, lev, price, pct, usd, usdPrice } from "../lib/format";
import { Flex, marketShare, useRefWallet } from "../components/Flex";
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

// Markets bucket by what they actually are: a coin vs SOL, a stable vs a stable (the wiggle), or a stable priced in SOL (SOL upside down).
const STABLES = new Set(["USDC", "USDT", "PYUSD", "TUSD", "USD1", "DAI", "FDUSD", "USDE", "USDS", "CASH", "USDH", "UXD"]);
type Theme = "all" | "coins" | "stable/stable" | "inverse SOL";
const THEMES: { id: Theme; hint: string }[] = [
  { id: "all", hint: "Every market. Pick a bucket to see what kind of game you're in." },
  { id: "coins", hint: "A coin against SOL at ±100×. UP = long the coin, DOWN = short it. A 1% move hands ~63% of the losing pot over." },
  { id: "stable/stable", hint: "The wiggle. A 1 bp TWAP tick moves ~1% of the losing pot; the smaller pot collects 54% of every fee. Yield seat, not a punt." },
  { id: "inverse SOL", hint: "A stable priced in SOL — SOL itself, upside down. UP = SOL dumps, DOWN = SOL pumps. Flip the price (⇄) to read it as SOL." },
];
const themeOf = (v: MarketView): Exclude<Theme, "all"> => {
  const stableBase = STABLES.has(v.ticker.toUpperCase());
  const q = v.oracle.quote;
  if (stableBase && (q === "USDC" || q === "USDT")) return "stable/stable";
  if (stableBase && q === "SOL") return "inverse SOL";
  return "coins";
};

export default function Board() {
  const { data, error, loading } = usePoll(loadBoard, []);
  const burn = usePoll(loadBurnPot, []);
  const [theme, setTheme] = useState<Theme>("all");
  const shown = (data ?? []).filter((v) => theme === "all" || themeOf(v) === theme);
  const count = (t: Theme) => (t === "all" ? (data?.length ?? 0) : (data ?? []).filter((v) => themeOf(v) === t).length);
  const heroes = HERO_MARKETS.map((k) => data?.find((v) => v.acct.key.toBase58() === k)).filter((v): v is MarketView => !!v);
  return (
    <>
      <Tape />
      <section className="board-head">
        <div>
          <h1 className="display">
            Your next 100×. <span className="up">Up</span> or <span className="down">down</span>.
          </h1>
          <p className="pitch">
            <b>You long it? Long it. Short? Short it. Don't want to be long or short but think it's gonna be a wild ride?</b>{" "}
            <Link to="/yield">Park it.</Link> Hyperliquid on Solana, for every coin, without liquidations: pick a coin, pick <b className="up">up</b> or{" "}
            <b className="down">down</b>, put in SOL. Every time the price moves, the side that's wrong pays the side that's right, at 100×. Nobody gets
            liquidated. Leave whenever.
          </p>
          <p className="meta pitch-sub">
            any coin with a Raydium pool, listed by anyone in one tx · no funding, no margin calls · 4% in, 4% out · <Link to="/yield">park instead and keep the fees</Link> ·
            every share button carries your link and pays you on every buy it brings
          </p>
        </div>
        <Link className="btn" to="/new">
          Cook up a market
        </Link>
      </section>

      {heroes.length > 0 && (
        <div className={`heroes n${Math.min(heroes.length, 2)}`}>
          <Tvl markets={data ?? []} burnPot={burn.data?.pot ?? null} />
          <Backed />
          {heroes.slice(0, 2).map((v, i) => (
            <Hero key={v.acct.key.toBase58()} v={v} big={i === 0 && heroes.length > 1} house={v.underlyingMint === MEME_MINT.toBase58()} />
          ))}
        </div>
      )}
      <ol className="howto" aria-label="How it works">
        <li>
          <b>1 · pick</b>
          <span>
            a coin below, then <span className="up">UP</span> (long) or <span className="down">DOWN</span> (short).
          </span>
        </li>
        <li>
          <b>2 · buy</b>
          <span>type SOL, hit Buy. Your tokens are your slice of that side's pot. Don't want to connect your main wallet? Use the burner — top-right.</span>
        </li>
        <li>
          <b>3 · leave whenever</b>
          <span>
            sell back or cash out at the pot. Not a degen? <Link to="/yield">Park SOL in a vault</Link> and just keep the fees.
          </span>
        </li>
      </ol>
      <details className="fine" id="fine">
        <summary className="meta">the math, worked examples, and why it can't liquidate you →</summary>
      <section className="notperps" id="not-perps">
        <div className="np-head">
          <span className="meta">Read this once</span>
          <h2 className="display">±100× here is not 100× on a perp.</h2>
          <p className="np-lead">
            New here? <b className="up">UP</b> is a long. <b className="down">DOWN</b> is a short. The 100× is how hard every tick hits: a 1% move
            hands ~63% of the losing pot to the winner. What's in it for you: a long that pays far more than holding when you're right, a short on
            coins you can't short anywhere else, and no liquidation either way. Pick a coin, pick a side, ape SOL — that's the whole interface.
          </p>
        </div>
        <ol className="np-list">
          <li>
            <b>It can never liquidate</b> because the position isn't a loan. There's no borrowed money and no margin; both
            sides pre-fund a pot, and every move transfers a <i>fraction</i> of the loser's pot to the winner:{" "}
            <span className="num">1 − 1.0001<sup>−100·|Δtick|</sup></span>. That fraction is below 100% for any finite move — a 1% move
            takes ~63% of the losing pot, a 5% move ~99%, a 100% move still leaves something. Nobody ever owes more than
            they put in, so there's nothing to liquidate, no margin call, no funding, no insurance fund, no "price hit X and
            I'm out". You lose by decay, not by a line.
          </li>
          <li>
            <b>Your payout isn't 100× either, and it isn't fixed:</b> it's{" "}
            <span className="num">100 × (their pot ÷ your pot)</span>. Leverage here is a property of the crowd, not your
            account. If $90 is UP and $10 is DOWN, DOWN makes 900× on the next tick and UP makes 11× — same move, same
            mechanism. Perps give you a fixed multiple and take your whole stack when you're wrong; this gives you a variable
            multiple, biggest exactly when you're alone, and never your whole stack. Which is also why{" "}
            <b>the empty side is the trade.</b>
          </li>
        </ol>
      </section>
      <section className="howto" id="how">
        <div className="np-head">
          <span className="meta">Noob-proof · worked examples</span>
          <h2 className="display">What it does to $100.</h2>
        </div>
        <div className="how-grid">
          <article>
            <h3 className="display">1 · The long</h3>
            <p>
              You ape <b>$100 into $PUMP UP</b>. Say the pots are $1,000 UP vs $1,000 DOWN, so you own 10% of UP. PUMP climbs 1% vs SOL. DOWN
              hands 63% of its pot — $630 — to UP. UP is now $1,630 and your 10% is <b className="up">$163</b>. Holding PUMP would have made you $1.
            </p>
            <p className="meta">
              Another 1%: DOWN pays 63% of what it has left ($233). It can never pay 100%, so nobody is ever liquidated — not you, not them.
            </p>
          </article>
          <article>
            <h3 className="display">2 · The short</h3>
            <p>
              Same market, you take <b>$100 of $PUMP DOWN</b>. PUMP dumps 1%: UP pays 63% of its pot to DOWN. You can't short most of these coins
              anywhere else; here it's one button, and the most you can lose is the $100.
            </p>
          </article>
          <article>
            <h3 className="display">3 · The empty side</h3>
            <p>
              Pots are $900 UP vs $100 DOWN. A 1% dump moves $567 from UP to DOWN — DOWN holders 6.7× in one tick. A 1% pump moves $63 to UP — UP
              holders +7%. Same move, wildly different payout: <b>payout = 100 × (their pot ÷ your pot)</b>. The lonely side is the trade.
            </p>
          </article>
          <article>
            <h3 className="display">4 · How, in 20 seconds</h3>
            <p>
              Connect → pick a coin below → <b className="up">UP</b> (long) or <b className="down">DOWN</b> (short) → type SOL → Ape. Out:{" "}
              <b>Exit</b> sells back into the curve, <b>Cash out at pot</b> takes your slice of your side's pot minus 4%. One of those always works. <b>0/20:</b> 0% of your stake, 20% of your <i>gain</i> goes into the STACCIndex raise in your name, same tx. You get the $STACCS.
              Not a degen? <Link to="/yield">Park SOL in a vault</Link>: we LP + hedge, your receipt token just gets heavier.
            </p>
            <p className="meta">
              Fees: 4% in, 4% out. 60% goes back into the pots, 30% buys <Link to={`/m/${HERO_MARKETS[0] ?? ""}#burn`}>$100XBRO and burns it</Link> (yes,
              deflationary), 10% buys BABY100X and burns it.
            </p>
          </article>
        </div>
      </section>
      </details>
      <CoinStrip />
      {heroes.length === 0 && HERO_MARKETS.length > 0 && loading && <div className="skeleton hero-skel" aria-hidden />}

      <div className="themes" role="tablist" aria-label="Market buckets">
        {THEMES.map((t) => (
          <button key={t.id} role="tab" className="chip" aria-selected={theme === t.id} aria-pressed={theme === t.id} onClick={() => setTheme(t.id)}>
            {t.id} <span className="num">{count(t.id)}</span>
          </button>
        ))}
        <span className="hint">{THEMES.find((t) => t.id === theme)!.hint}</span>
      </div>
      <table className="tape">
        <thead>
          <tr>
            <th className="meta">Coin</th>
            <th className="meta r hide-sm">Oracle</th>
            <th className="meta r">UP</th>
            <th className="meta r">DOWN</th>
            <th className="meta hide-sm">Pots · payout if right</th>
            <th className="meta r hide-md">In the hole</th>
          </tr>
        </thead>
        <tbody>
          {loading && !data &&
            [0, 1, 2].map((i) => (
              <tr key={i} aria-hidden>
                <td>
                  <span className="skeleton" style={{ width: 120, height: 24 }} />
                </td>
                <td className="r hide-sm">
                  <span className="skeleton" style={{ width: 80, marginLeft: "auto" }} />
                </td>
                <td className="r">
                  <span className="skeleton" style={{ width: 70, marginLeft: "auto" }} />
                </td>
                <td className="r">
                  <span className="skeleton" style={{ width: 70, marginLeft: "auto" }} />
                </td>
                <td className="hide-sm tug-cell">
                  <span className="skeleton" style={{ width: "100%", height: 10 }} />
                </td>
                <td className="hide-md" />
              </tr>
            ))}
          {shown.map((v) => (
            <Row key={v.acct.key.toBase58()} v={v} />
          ))}
          {data && shown.length === 0 && (
            <tr>
              <td colSpan={6} className="note">
                Nothing in this bucket yet. <Link to="/new">Cook one up</Link> — any coin with a Raydium CLMM pool qualifies.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {data && data.length > 0 && (
        <section className="live-grid">
          <div>
            <h2 className="meta">
              <span className="live-dot" aria-hidden />
              Live · who's doing what
            </h2>
            <Feed limit={14} />
          </div>
          <div>
            <h2 className="meta">Biggest bags</h2>
            <Wallets />
            <h2 className="meta">Most volume · 24 h</h2>
            <ActiveWallets hours={24} />
          </div>
        </section>
      )}
      {data && data.length > 0 && (
        <div className="list-cta">
          <span>
            Any coin with a Raydium CLMM pool can get a pair. Paste the CA, we find the oracle, you sign once. Yes, even that one.
          </span>
          <Link className="btn ghost" to="/new">
            Cook up another
          </Link>
        </div>
      )}
      {data && data.length === 0 && (
        <div className="empty">
          <div className="display">Nothing cooking yet.</div>
          <p>Any coin with a Raydium CLMM pool can get a ±100× pair. Two curves, one hook, nobody's permission.</p>
          <Link className="btn" to="/new">
            Cook the first one
          </Link>
        </div>
      )}
      {error && !data && <p className="err">Couldn't reach the chain: {error}</p>}
    </>
  );
}

function Row({ v }: { v: MarketView }) {
  const nav = useNavigate();
  const under = useUnderlying(v.underlyingMint);
  const refWallet = useRefWallet();
  const px = usePrices();
  const owedSide = v.side[0].owed > 1e-6 ? 0 : v.side[1].owed > 1e-6 ? 1 : null;
  const go = () => nav(`/m/${v.acct.key.toBase58()}`);
  return (
    <tr
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go())}
      aria-label={`${under?.symbol ?? v.ticker} market`}
    >
      <td className="name-cell">
        <Link className="name rowlink" to={`/m/${v.acct.key.toBase58()}`} onClick={(e) => e.stopPropagation()}>
          {under?.image && <img className="tokimg" src={under.image} alt="" />}
          {under?.symbol ?? v.ticker} <span className="muted quote">/ {v.oracle.quote}</span>
        </Link>
        <div className="sub">
          {v.side[0].symbol} / {v.side[1].symbol} <Flex target={marketShare(v, under?.symbol ?? v.ticker, refWallet)} />
        </div>
      </td>
      <td className="r num hide-sm"><OraclePrice x={v.oracle.twap ?? v.oracle.lastTwap} quote={v.oracle.quote} ticker={under?.symbol ?? v.ticker} /></td>
      <td className="r num up px-up">
        <Link to={`/m/${v.acct.key.toBase58()}?side=0`} className="cell-link" onClick={(e) => e.stopPropagation()}>
          {usdPrice(px.priceUsd(v.side[0].curvePrice))}
        </Link>
      </td>
      <td className="r num down px-down">
        <Link to={`/m/${v.acct.key.toBase58()}?side=1`} className="cell-link" onClick={(e) => e.stopPropagation()}>
          {usdPrice(px.priceUsd(v.side[1].curvePrice))}
        </Link>
      </td>
      <td className="tug-cell">
        <Tug up={v.side[0].vault} down={v.side[1].vault} levUp={v.side[0].leverage} levDown={v.side[1].leverage} />
      </td>
      <td className="r hide-md">
        {owedSide !== null ? (
          <Link to={`/m/${v.acct.key.toBase58()}#keep`} className="owed" onClick={(e) => e.stopPropagation()}>
            {owedSide === 0 ? "UP" : "DOWN"} −{pct(v.side[owedSide].owed)}
          </Link>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  );
}

/** The house market, always on top: one underlying, two doors. */
/** Everything the protocol is holding right now: both pots + both curves of every market, plus the burn pot. */
function Tvl({ markets, burnPot }: { markets: MarketView[]; burnPot: bigint | null }) {
  const px = usePrices();
  const pots = markets.reduce((n, v) => n + v.side[0].vault + v.side[1].vault, 0n);
  const curves = markets.reduce((n, v) => n + v.side[0].reserve + v.side[1].reserve, 0n);
  const total = pots + curves + (burnPot ?? 0n);
  const ready = markets.length > 0 && px.quoteUsd(total) !== null;
  return (
    <a className="tvl" id="tvl" href="#tvl" aria-live="polite" aria-label="Total value locked">
      <span className="meta">
        <i className="live" aria-hidden /> TVL · money on the table
      </span>
      <strong className="display num">{ready ? <Rolling value={px.quoteUsd(total)!} /> : "—"}</strong>
      <span className="meta num">
        {markets.length} markets · pots {usd(px.quoteUsd(pots))} · curves {usd(px.quoteUsd(curves))}
        {burnPot !== null && <> · burn pot {usd(px.quoteUsd(burnPot))}</>}
      </span>
    </a>
  );
}

/** The 0/20 tally: USDC that 100x.broker exits have committed to the STACCIndex raise, in the exiting wallets' own names. */
function Backed() {
  const b = usePoll(async () => (await (await fetch("/api/backed")).json()) as { usd: number; txs: number; backers: number }, []);
  return (
    <a className="tvl backed" href={RAISE_URL} target="_blank" rel="noopener noreferrer" aria-live="polite" aria-label="Backed into STACCIndex by the 0/20 rule">
      <span className="meta">
        <i className="live" aria-hidden /> 0/20 · backed into STACCIndex
      </span>
      <strong className="display num">{b.data ? <Rolling value={b.data.usd} /> : "—"}</strong>
      <span className="meta num">{b.data ? <>{b.data.backers} wallets · {b.data.txs} exits · 20% of gains, in their own names · raise closes Oct 18</> : "counting…"}</span>
    </a>
  );
}

/** Counts from the last shown value to the new one; jumps straight there under reduced motion. */
function Rolling({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef<number | null>(null);
  useEffect(() => {
    const start = from.current ?? value;
    from.current = value;
    if (start === value || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 800);
      setShown(start + (value - start) * (1 - (1 - k) ** 3));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{usd(shown)}</>;
}

function Hero({ v, big = false, house = false }: { v: MarketView; big?: boolean; house?: boolean }) {
  const key = v.acct.key.toBase58();
  const under = useUnderlying(v.underlyingMint);
  const px = usePrices();
  const refWallet = useRefWallet();
  const dir = v.oracle.twap !== null ? Math.sign(v.oracle.twap - v.oracle.lastTwap) : 0;
  return (
    <section className={`hero ${big ? "big" : "side"} ${house ? "house" : ""}`} aria-label={`${v.ticker} market`}>
      <div className="hero-id">
        <span className="meta">
          {house ? "The coin · 30% of every fee burns it" : "House special"} · Raydium TWAP · {Math.round(v.acct.windowSecs / 60)} min
        </span>
        <Link to={`/m/${key}`} className="display hero-ticker">
          {under?.image && <img className="tokimg hero-img" src={under.image} alt="" />}${under?.symbol ?? v.ticker}
          <small className="hq">/ {v.oracle.quote}</small>
        </Link>
        <Flex target={marketShare(v, under?.symbol ?? v.ticker, refWallet)} className="chip flex-chip hero-flex" label="flex this" />
        <div className="hero-px num">
          <span className={dir > 0 ? "up" : dir < 0 ? "down" : ""}><OraclePrice x={v.oracle.twap ?? v.oracle.lastTwap} quote={v.oracle.quote} ticker={under?.symbol ?? v.ticker} /></span>{" "}
          <span className="muted">
            {price(v.oracle.twap ?? v.oracle.lastTwap)} {v.oracle.quote} · observed {ago(v.oracle.updatedTs)}
          </span>
        </div>
        <Tug up={v.side[0].vault} down={v.side[1].vault} levUp={v.side[0].leverage} levDown={v.side[1].leverage} size="lg" />
      </div>
      <div className="hero-doors">
        {([0, 1] as const).map((i) => (
          <Link key={i} to={`/m/${key}?side=${i}`} className={`door ${i === 0 ? "u" : "d"}`}>
            <span className="meta">{v.side[i].symbol}</span>
            <span className="display">
              {i === 0 ? "Up" : "Down"} 100×<small className="ls">{i === 0 ? "long" : "short"}</small>
            </span>
            <span className="num">
              {usdPrice(px.priceUsd(v.side[i].curvePrice))} · <b>{lev(v.side[i].leverage)}</b> payout
            </span>
            {v.side[i].owed > 1e-6 && <span className="owed">in the hole −{pct(v.side[i].owed)}</span>}
            {v.side[i].leverage > v.side[1 - i].leverage && Number.isFinite(v.side[i].leverage) && (
              <span className="sticker">empty side · pays {lev(v.side[i].leverage)}</span>
            )}
          </Link>
        ))}
      </div>
    </section>
  );
}
