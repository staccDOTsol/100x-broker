// /meta — what's spicy right now (Decide): one list, one thesis per row, one button to press.
// Rows come from src/meta.ts; the numbers come from the same loader the board uses for its rows.
import { Link } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { usePoll } from "../hooks";
import { loadMarketView, type MarketView } from "../lib/chain";
import { fetchViews } from "../lib/views";
import { META, type MetaPick } from "../meta";
import { OraclePrice, Tug } from "../components/bits";
import { bust, Flex, marketShare, useRefWallet } from "../components/Flex";
import type { ShareTarget } from "../components/ShareSheet";
import { useUnderlying } from "../hooks/underlying";
import { usePrices } from "../hooks/price";
import { shareUrl } from "../lib/ref";
import { ago, lev, usdPrice } from "../lib/format";

type Views = Record<string, MarketView | null>;
/** Every pinned market, once, with the board's loader. A bad or dead key only blanks its own row. */
async function loadPicks(): Promise<Views> {
  const keys = [...new Set(META.map((p) => p.market).filter(Boolean))];
  const snap = await fetchViews().catch(() => null);
  const views = await Promise.all(
    keys.map(async (k) => {
      const hit = snap?.find((v) => v.acct.key.toBase58() === k);
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
    text: "Markets the house is actually in, one button each. Long it, short it, or park in the vault and farm the chop. Not advice.",
    url: shareUrl("/meta", wallet),
    image: `/api/og?${bust()}`,
    filename: "spicy.png",
  };
}

type Action = { to: string; label: string; sub: string; cls: string };
/** UP/DOWN preselect the side on the market page (?side=0|1); VAULT goes to the vault, or to the market's vault panel while it's being born. */
function actionFor(p: MetaPick): Action | null {
  if (!p.market) return null;
  if (p.side === "UP") return { to: `/m/${p.market}?side=0`, label: "UP 100×", sub: "long", cls: "up" };
  if (p.side === "DOWN") return { to: `/m/${p.market}?side=1`, label: "DOWN 100×", sub: "short", cls: "down" };
  return p.vault
    ? { to: `/yield/${p.vault}`, label: "Park SOL", sub: "delta-neutral vault", cls: "" }
    : { to: `/m/${p.market}#dn`, label: "vault spinning up", sub: "see the market's vault panel", cls: "ghost" };
}

export default function MetaPage() {
  const { data, error, loading } = usePoll(loadPicks, []);
  const refWallet = useRefWallet();
  return (
    <>
      <header className="spicy-head">
        <div className="meta">
          <Link to="/">Board</Link> / spicy
        </div>
        <h1 className="display">What's spicy</h1>
        <p className="lede">
          You long oil? <b className="up">Long it.</b> Short? <b className="down">Short it.</b> Don't want to be long or short but think it's gonna be a wild ride?{" "}
          <Link to="/yield">/yield</Link>.
        </p>
        <p className="fine">Markets the house is actually in. Not advice. Parking-meter money.</p>
        <Flex target={listShare(refWallet)} label="flex the list" />
      </header>
      <ol className="spicy-list" aria-label="What's spicy right now">
        {META.map((p, i) => (
          <Pick key={`${p.ticker}-${i}`} p={p} v={p.market ? data?.[p.market] : null} loading={loading && !data} />
        ))}
      </ol>
      {META.length === 0 && <p className="note">Nothing spicy on the menu. Add a row to src/meta.ts.</p>}
      {error && !data && <p className="err">Couldn't reach the chain: {error}</p>}
    </>
  );
}

/** One pick: tag, $TICKER + headline, the thesis, the live numbers, and exactly one button. */
function Pick({ p, v, loading }: { p: MetaPick; v: MarketView | null | undefined; loading: boolean }) {
  const under = useUnderlying(v?.underlyingMint);
  const refWallet = useRefWallet();
  const act = actionFor(p);
  const coming = !p.market;
  const sideIdx: 0 | 1 | null = p.side === "UP" ? 0 : p.side === "DOWN" ? 1 : null;
  return (
    <li className={`spicy-row ${coming ? "coming" : ""}`}>
      <div className="spicy-copy">
        <div className="spicy-tags">
          <span className="chip" aria-label={`tag: ${p.tag}`}>
            {p.tag}
          </span>
          {coming && <span className="badge">coming</span>}
          {v?.acct.settling && <span className="badge warn">settling</span>}
          {v && <Flex target={marketShare(v, p.ticker, refWallet)} />}
        </div>
        <h2 className="display">
          {under?.image && <img className="tokimg" src={under.image} alt="" />}
          {v ? (
            <Link to={`/m/${p.market}`} className="rowlink">
              ${p.ticker}
            </Link>
          ) : (
            <>${p.ticker}</>
          )}{" "}
          <span className="spicy-headline">{p.headline}</span>
        </h2>
        <p className="spicy-thesis">{p.thesis}</p>
        {v ? (
          <Live v={v} market={p.market} ticker={p.ticker} side={sideIdx} />
        ) : coming ? null : loading || v === undefined ? (
          <span className="skeleton" style={{ height: 52, maxWidth: 560 }} aria-hidden />
        ) : (
          <p className="note">Can't read this market right now. The button still works.</p>
        )}
      </div>
      <div className="spicy-act">
        {act ? (
          <Link to={act.to} className={`btn big ${act.cls}`}>
            {act.label}
            <small>{act.sub}</small>
          </Link>
        ) : (
          <span className="btn big ghost" aria-disabled="true">
            coming
            <small>not live yet</small>
          </span>
        )}
        {v && sideIdx !== null && (
          <span className="meta num">
            pays <b className={sideIdx === 0 ? "up" : "down"}>{lev(v.side[sideIdx].leverage)}</b> if right · right now
          </span>
        )}
        {v && p.side === "VAULT" && (
          <span className="meta num">
            DOWN pays <b className="down">{lev(v.side[1].leverage)}</b> · the hedge's side
          </span>
        )}
      </div>
    </li>
  );
}

/** Oracle, both curve prices, both pots with their payout: what the board row shows, in one column. */
function Live({ v, market, ticker, side }: { v: MarketView; market: string; ticker: string; side: 0 | 1 | null }) {
  const px = usePrices();
  return (
    <div className="spicy-live">
      <div className="spicy-px num">
        <OraclePrice x={v.oracle.twap ?? v.oracle.lastTwap} quote={v.oracle.quote} ticker={ticker} />
        <span className="muted"> · {Math.round(v.acct.windowSecs / 60)} min TWAP · observed {ago(v.oracle.updatedTs)}</span>
      </div>
      <div className="spicy-sides num">
        <Link to={`/m/${market}?side=0`} className={`cell-link up ${side === 0 ? "pick" : ""}`}>
          UP {usdPrice(px.priceUsd(v.side[0].curvePrice))}
        </Link>
        <Link to={`/m/${market}?side=1`} className={`cell-link down ${side === 1 ? "pick" : ""}`}>
          DOWN {usdPrice(px.priceUsd(v.side[1].curvePrice))}
        </Link>
      </div>
      <Tug up={v.side[0].vault} down={v.side[1].vault} levUp={v.side[0].leverage} levDown={v.side[1].leverage} />
    </div>
  );
}
