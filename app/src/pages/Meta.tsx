// /meta — what's spicy right now (Decide): one card per pick, real numbers only, one button each, share baked in.
// Picks come from src/meta.ts; the numbers come from the same loader the board uses for its rows. Nothing here is simulated.
import { Link, useNavigate } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { usePoll } from "../hooks";
import { loadMarketView, type MarketView } from "../lib/chain";
import { fetchViews } from "../lib/views";
import { META, resolveMetaPick, type MetaPick } from "../meta";
import { OraclePrice, Tug } from "../components/bits";
import { bust, Flex, marketShare, useRefWallet } from "../components/Flex";
import { CardShare } from "../components/Share";
import { Delta, Flash, Sparkline } from "../components/Pulse";
import type { ShareTarget } from "../components/ShareSheet";
import { useUnderlying } from "../hooks/underlying";
import { usePrices } from "../hooks/price";
import { shareUrl } from "../lib/ref";
import { ago, lev, usdPrice } from "../lib/format";

type Views = Record<string, MarketView | null>;
/** Every pinned market, once, with the board's loader. A bad or dead key only blanks its own card. */
async function loadPicks(): Promise<Views> {
  const keys = [...new Set(META.map((p) => p.market).filter(Boolean))];
  const snap = await fetchViews().catch(() => null);
  const views = await Promise.all(
    keys.map(async (k) => {
      const pick = META.find((p) => p.market === k);
      const hit = pick && snap ? resolveMetaPick(pick, snap) : null;
      if (hit) return hit;
      try {
        return await loadMarketView(new PublicKey(k));
      } catch {
        return null;
      }
    }),
  );
  const out: Views = {};
  keys.forEach((k, i) => (out[k] = views[i]));
  return out;
}

/** The list itself, for the flex chip: the generic site card with /meta as the link. */
function listShare(wallet: PublicKey | null): ShareTarget {
  return {
    title: "What's spicy — 100x.broker",
    text: "Markets the house is actually in, one button each. Not advice.",
    url: shareUrl("/meta", wallet),
    image: `/api/og?${bust()}`,
    filename: "spicy.png",
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The pick's headline cut to a ≤3-word label: first fragment before "·", minus a leading "$TICKER,". The full thesis rides as the tooltip. */
function label(p: MetaPick): string {
  const head = p.headline.split("·")[0].replace(new RegExp(`^\\$${escapeRe(p.ticker)}\\W*`, "i"), "").trim();
  const words = head.split(/\s+/).filter(Boolean);
  return words.slice(0, 3).join(" ") + (words.length > 3 ? "…" : "");
}

/** Where the one button goes. UP/DOWN preselect the side (?side=0|1); VAULT preselects Yield (?side=yield, which falls back to Long while the vault is being born). */
function actionPath(p: MetaPick): string | null {
  if (!p.market) return null;
  if (p.side === "UP") return `/m/${p.market}?side=0`;
  if (p.side === "DOWN") return `/m/${p.market}?side=1`;
  return `/m/${p.market}?side=yield`;
}

/** The tweet: real leverage when the view is here, the bare side otherwise. Never a made-up number. */
function shareText(p: MetaPick, v: MarketView | null | undefined): string {
  if (p.side === "VAULT") return `$${p.ticker} vault farms the chop on 100x.broker`;
  const i = p.side === "UP" ? 0 : 1;
  return v ? `$${p.ticker} ${p.side} pays ${lev(v.side[i].leverage)} right now on 100x.broker` : `$${p.ticker} ${p.side} on 100x.broker`;
}

export default function MetaPage() {
  const { data, error, loading } = usePoll(loadPicks, []);
  const refWallet = useRefWallet();
  return (
    <>
      <header className="spicy-head mc-head">
        <div className="meta">
          <Link to="/">Board</Link> / spicy
        </div>
        <h1 className="display">What's spicy.</h1>
        <p className="mc-line num">House is in. One button each.</p>
        <Flex target={listShare(refWallet)} label="flex the list" />
      </header>
      <ol className="cards mc-grid" aria-label="What's spicy right now">
        {META.map((p, i) => (
          <PickCard key={`${p.ticker}-${i}`} p={{ ...p, market: data?.[p.market]?.acct.key.toBase58() ?? p.market }} v={p.market ? data?.[p.market] : null} loading={loading && !data} />
        ))}
      </ol>
      {META.length === 0 && <p className="note">Nothing on the menu.</p>}
      {error && !data && <p className="err">Chain unreachable: {error}</p>}
      <details className="mc-fine">
        <summary className="meta">fine print</summary>
        <p className="meta num">house is in · not advice · parking-meter money</p>
      </details>
    </>
  );
}

/** One pick as an infographic: $TICKER, side badge with the live payout, a 3-word reason, price + spark + pots, one button, share. */
function PickCard({ p, v, loading }: { p: MetaPick; v: MarketView | null | undefined; loading: boolean }) {
  const nav = useNavigate();
  const under = useUnderlying(v?.underlyingMint);
  const refWallet = useRefWallet();
  const to = actionPath(p);
  const coming = !p.market;
  const unavailable = !coming && !loading && !v;
  const sideIdx: 0 | 1 | null = p.side === "UP" ? 0 : p.side === "DOWN" ? 1 : null;
  const cls = p.side === "UP" ? "up" : p.side === "DOWN" ? "down" : "vault";
  const payout = v && sideIdx !== null ? v.side[sideIdx].leverage : null;
  const twap = v ? (v.oracle.twap ?? v.oracle.lastTwap) : null;
  const go = () => to && nav(to);
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <li
      className={`card mc ${cls} ${coming ? "coming" : ""} ${v?.acct.settling ? "settling" : ""}`}
      tabIndex={to ? 0 : -1}
      role={to ? "link" : undefined}
      onClick={go}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go())}
      aria-label={`${p.ticker} ${p.side}`}
    >
      <div className="card-head">
        <span className="display card-ticker">
          {under?.image && <img className="tokimg" src={under.image} alt="" />}
          {v ? (
            <Link to={`/m/${p.market}`} className="rowlink" onClick={stop}>
              ${p.ticker}
            </Link>
          ) : (
            <>${p.ticker}</>
          )}
        </span>
        <span className="chip mc-tag" aria-label={`tag: ${p.tag}`}>
          {p.tag}
        </span>
        {coming && <span className="badge mc-badge">coming</span>}
        {unavailable && <span className="badge warn mc-badge">unavailable</span>}
        {v?.acct.settling && <span className="badge warn mc-badge">settling</span>}
      </div>
      <div className="mc-side-row">
        <span className={`mc-side ${cls}`}>
          {p.side}
          {payout !== null && (
            <>
              {" "}
              <Flash watch={payout} as="b">
                {lev(payout)}
              </Flash>
            </>
          )}
        </span>
        <span className="mc-label" title={unavailable ? "The previous program is closed. View its historical market; trading and withdrawals are unavailable." : p.thesis}>
          {label(p)}
        </span>
      </div>
      {v && twap !== null ? (
        <>
          <div className="card-px num">
            <Flash watch={twap} className={twap > v.oracle.lastTwap ? "up" : twap < v.oracle.lastTwap ? "down" : ""}>
              <OraclePrice x={twap} quote={v.oracle.quote} ticker={p.ticker} />
            </Flash>
            <Delta x={v.oracle.lastTwap > 0 ? twap / v.oracle.lastTwap - 1 : 0} dp={2} />
          </div>
          <Sparkline series={v.oracle.series} base={v.oracle.lastTwap} w={240} h={56} className="card-spark" label={`${p.ticker} oracle, last hour`} />
          <Tug up={v.side[0].vault} down={v.side[1].vault} levUp={v.side[0].leverage} levDown={v.side[1].leverage} />
          <Doors v={v} market={p.market} side={sideIdx} />
        </>
      ) : coming ? null : loading || v === undefined ? (
        <span className="skeleton card-skel mc-skel" aria-hidden />
      ) : (
        <p className="note mc-note">Chain unreachable.</p>
      )}
      <div className="mc-act">
        {to ? (
          <Link to={to} className={`btn big ${cls === "vault" ? "" : cls}`} onClick={stop}>
            {p.side === "VAULT" ? "Park SOL" : p.side}
            {payout !== null && (
              <Flash watch={payout} as="b">
                {lev(payout)}
              </Flash>
            )}
          </Link>
        ) : (
          <span className="btn big ghost" aria-disabled="true">
            coming
          </span>
        )}
        <CardShare text={shareText(p, v)} path={to ?? "/meta"} target={v ? marketShare(v, p.ticker, refWallet) : undefined} />
      </div>
    </li>
  );
}

/** Both doors with their live payout, the picked one underlined; the oracle's age as the only caption. */
function Doors({ v, market, side }: { v: MarketView; market: string; side: 0 | 1 | null }) {
  const px = usePrices();
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <div className="card-doors num">
      <Link to={`/m/${market}?side=0`} className={`up ${side === 0 ? "pick" : ""}`} onClick={stop} title={`UP curve ${usdPrice(px.priceUsd(v.side[0].curvePrice))}`}>
        UP <Flash watch={v.side[0].leverage} as="b">{lev(v.side[0].leverage)}</Flash>
      </Link>
      <span className="muted">{ago(v.oracle.updatedTs)}</span>
      <Link to={`/m/${market}?side=1`} className={`down ${side === 1 ? "pick" : ""}`} onClick={stop} title={`DOWN curve ${usdPrice(px.priceUsd(v.side[1].curvePrice))}`}>
        <Flash watch={v.side[1].leverage} as="b">{lev(v.side[1].leverage)}</Flash> DOWN
      </Link>
    </div>
  );
}
