// /me and /p/:wallet — one wallet's whole book across every market, and every action that makes sense from here.
import { track } from "@vercel/analytics";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { usePoll, useSend } from "../hooks";
import { usePrices } from "../hooks/price";
import { useUnderlying } from "../hooks/underlying";
import { buildSettleTx, toV0, type MarketView } from "../lib/chain";
import { loadPortfolio, MEME_DECIMALS, positionValue, type Position } from "../lib/portfolio";
import { fetchFeed } from "../lib/feed";
import { aggregatePnl, basisByPosition, fmtAge, fmtAnnual, positionPnl, type Basis, type Pnl } from "../lib/pnl";
import { exitIxs, planExit, redeemIxs } from "../lib/exit";
import { backIxs, exitGain, MIN_SHARE_LAMPORTS, raiseOpen, shareLamports } from "../lib/backable";
import { poolState, tokensForLamports, withdrawCapacity, withdrawOut, withdrawSolIx } from "../lib/zap";
import { claimFeesIx, cu } from "../lib/hooked";
import { shareUrl } from "../lib/ref";
import { setHash } from "../lib/url";
import type { ShareTarget } from "../components/ShareSheet";
import { Feed } from "../components/Live";
import { WalletButton } from "../components/bits";
import { useToasts } from "../components/Toasts";
import { CardShare } from "../components/Share";
import { Delta, Flash, Rolling, Sparkline } from "../components/Pulse";
import { ago, amount as fmtAmount, lev, pct, short, usd, usdPrice } from "../lib/format";
import { Flex, bust, siteShare } from "../components/Flex";
import { HERO_MARKET, MEME_SYMBOL, PUMP_URL, RFSTACC } from "../config";

const SIDE = ["UP", "DOWN"] as const;
const cls = (s: 0 | 1) => (s === 0 ? "up" : "down");
/** "+$12.34" / "−$5.00" from a USD number. */
const signed = (u: number) => `${u < 0 ? "−" : "+"}${usd(Math.abs(u))}`;

export default function PortfolioPage() {
  const { wallet } = useParams();
  const { publicKey } = useWallet();
  const owner = useMemo(() => {
    if (wallet) {
      try {
        return new PublicKey(wallet);
      } catch {
        return null;
      }
    }
    return publicKey ?? null;
  }, [wallet, publicKey?.toBase58()]);
  if (wallet && !owner)
    return (
      <div className="empty">
        <div className="display">Not a wallet.</div>
        <Link className="btn ghost" to="/">
          Board →
        </Link>
      </div>
    );
  if (!owner)
    return (
      <div className="empty">
        <div className="display">Your bag.</div>
        <WalletButton />
      </div>
    );
  return <Bag owner={owner} mine={!!publicKey && owner.equals(publicKey)} />;
}

function Bag({ owner, mine }: { owner: PublicKey; mine: boolean }) {
  const o = owner.toBase58();
  const book = usePoll(() => loadPortfolio(owner), [o]);
  const pool = usePoll(poolState, []).data ?? null;
  const px = usePrices();
  const send = useSend();
  const toasts = useToasts();
  const { publicKey } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const b = book.data;

  const run = async (id: string, label: string, build: Parameters<typeof send>[1]) => {
    setBusy(id);
    const sig = await send(label, build);
    if (sig) book.refresh();
    setBusy(null);
    return sig;
  };
  // SOL out only while the stake pool's reserve covers it; otherwise the proceeds wait in the wallet as loose change
  const solPool = (minQuote: bigint) => (pool && withdrawOut(pool, minQuote) <= withdrawCapacity(pool) ? pool : null);
  // the 0/20 rule: a fifth of any realized gain on this exit, swapped to USDC and committed to the STACCIndex raise in this wallet's name
  const withShare = async (p: Position, ixs: Parameters<typeof toV0>[0], proceeds: bigint, pl: typeof pool, payer: PublicKey) => {
    if (!pl || !raiseOpen()) {
      track("backable_skip", { why: !raiseOpen() ? "closed" : "no_sol_out" });
      return toV0(ixs, payer);
    }
    try {
      const lam = shareLamports(exitGain(basis?.get(p.key), Number(p.amt) / 10 ** p.v.side[p.side].decimals, proceeds), pl);
      if (lam < MIN_SHARE_LAMPORTS) {
        track("backable_skip", { why: "no_gain", lam: Number(lam) });
        return toV0(ixs, payer);
      }
      const back = await backIxs(payer, lam);
      const tx = await toV0([cu(1_000_000), ...ixs.slice(1), ...back.ixs], payer, back.tables);
      // a route that would not fit on the wire must never take the exit down with it
      if (tx.serialize().length > 1232) {
        track("backable_skip", { why: "too_big", bytes: tx.serialize().length });
        return toV0(ixs, payer);
      }
      track("backable_fund", { usdc: Number(back.usdc) / 1e6 });
      return tx;
    } catch (e) {
      track("backable_skip", { why: "error", msg: String((e as Error)?.message ?? e).slice(0, 80) });
      console.warn("0/20 skipped", e);
      return toV0(ixs, payer);
    }
  };
  const exit = (p: Position) =>
    run(`x${p.key}`, `Exit ${SIDE[p.side]}`, async (payer) => {
      const plan = await planExit(p.v, p.side, p.amt);
      const pl = solPool(plan.sellMin + plan.redeemMin);
      if (!pl) toasts.push({ s: "ok", title: "Heads up", body: "SOL reserve is thin right now, so this lands as loose change. Sweep it in a bit." });
      return withShare(p, await exitIxs(p.v, p.side, plan, payer, pl), plan.sellMin + plan.redeemMin, pl, payer);
    });
  const cashOut = (p: Position) =>
    run(`c${p.key}`, `Cash out ${SIDE[p.side]}`, async (payer) => {
      const { min } = redeemIxs(p.v, p.side, p.amt, payer, null);
      const pl = solPool(min);
      return withShare(p, redeemIxs(p.v, p.side, p.amt, payer, pl).ixs, min, pl, payer);
    });
  const exitAll = async () => {
    setArmed(false);
    for (const p of vals.map((x) => x.p)) if (!(await exit(p))) break;
  };
  const sweepChange = () =>
    run("change", "Sweep loose change", async (payer) => {
      if (!pool || !b) throw new Error("stake pool unavailable");
      const cap = withdrawCapacity(pool);
      let amt = b.quote;
      if (withdrawOut(pool, amt) > cap) amt = tokensForLamports(pool, (cap * 99n) / 100n);
      if (amt <= 0n) throw new Error("SOL reserve is thin, try again later");
      return toV0([cu(100_000), withdrawSolIx(pool, payer, getAssociatedTokenAddressSync(RFSTACC, payer), amt)], payer);
    });
  const collect = (v: MarketView, side: 0 | 1) =>
    run(`s${v.acct.key.toBase58()}${side}`, "Make them pay", async (p) => (await buildSettleTx(v, side, p)).tx);
  const sweepTips = (v: MarketView) =>
    run(`t${v.acct.key.toBase58()}`, "Sweep tips", async (p) => toV0([cu(400_000), claimFeesIx(v.keys, 0), claimFeesIx(v.keys, 1)], p));

  // cost basis from this wallet's own buys / sells / cash-outs (same feed as "Your moves")
  const moves = usePoll(() => fetchFeed(undefined, o, 200), [o]);
  const basis = useMemo(() => (moves.data ? basisByPosition(moves.data, o) : null), [moves.data, o]);
  const vals = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    return (b?.positions ?? [])
      .map((p) => {
        const pv = positionValue(p);
        const pnl = basis ? positionPnl(basis.get(`${p.v.acct.key.toBase58()}:${p.side}`), pv.units, pv.best, now) : undefined;
        return { p, ...pv, pnl };
      })
      .sort((a, c) => c.best - a.best);
  }, [b, basis]);
  const agg = useMemo(() => (basis ? aggregatePnl(vals.map((x) => x.pnl)) : null), [vals, basis]);
  const n = vals.length;
  const markets = new Set(vals.map((x) => x.p.v.acct.key.toBase58())).size;
  const curveTotal = vals.reduce((s, x) => s + x.curve, 0);
  const potTotal = vals.reduce((s, x) => s + x.pot, 0);
  const worth = px.priceUsd(vals.reduce((s, x) => s + x.best, 0));
  // the biggest payout multiple anywhere in this bag, straight from the live sides
  const topLev = vals.reduce((m, x) => Math.max(m, x.p.v.side[x.p.side].leverage), 0);
  const unrealUsd = agg ? px.priceUsd(agg.unrealized) : null;
  const realUsd = agg ? px.priceUsd(agg.realized) : null;

  // chores that put money on this wallet's side of the table
  const chores = useMemo(() => {
    const out: { id: string; v: MarketView; kind: "settle" | "tips" | "waiting"; side: 0 | 1; amount: number }[] = [];
    const seen = new Set<string>();
    for (const { p } of vals) {
      const v = p.v;
      const k = v.acct.key.toBase58();
      const other = (1 - p.side) as 0 | 1;
      const os = v.side[other];
      if (os.owed > 1e-6 && !v.acct.settling && !seen.has(`${k}${other}`)) {
        seen.add(`${k}${other}`);
        // an empty curve can't pay yet: it collects the moment anyone buys that side
        out.push({ id: `s${k}${other}`, v, kind: os.atFloor ? "waiting" : "settle", side: other, amount: os.owed });
      }
      const tips = v.side[0].unclaimed + v.side[1].unclaimed;
      if (tips >= 500_000n && !seen.has(`t${k}`)) {
        seen.add(`t${k}`);
        out.push({ id: `t${k}`, v, kind: "tips", side: p.side, amount: Number(tips) / 1e9 });
      }
    }
    return out;
  }, [vals]);

  const sides = `${n} side${n === 1 ? "" : "s"}`;
  const bagShare: ShareTarget = {
    title: mine ? `My bag · ${sides}` : `${short(o)}'s bag · ${sides}`,
    text: mine
      ? `My bag on 100x.broker: ${sides}, ${usd(worth)} on the table${n ? `, pays up to ${lev(topLev)}` : ""}. Up or down, no liquidations, somebody's paying me.`
      : `${short(o)} is running ${sides} on 100x.broker${n ? `, paying up to ${lev(topLev)}` : ""}. Somebody's paying them.`,
    url: shareUrl(`/p/${o}`, publicKey),
    image: `/api/og?owner=${o}&${bust()}`,
    filename: `${short(o)}-bag.png`,
  };
  const bagTweet = mine
    ? `${sides} · ${usd(worth)} on the table${n ? ` · pays up to ${lev(topLev)}` : ""} · no liquidations`
    : `${short(o)}: ${sides} · ${usd(worth)} on the table${n ? ` · pays up to ${lev(topLev)}` : ""}`;
  const positionShare = (p: Position, value: number, pnl?: Pnl | null): ShareTarget => {
    const key = p.v.acct.key.toBase58();
    const usdS = (q: number) => {
      const u = px.priceUsd(q);
      return u === null ? "—" : `${u < 0 ? "−" : "+"}${usd(Math.abs(u))}`;
    };
    const lv = lev(p.v.side[p.side].leverage);
    const result = pnl ? ` ${fmtAnnual(pnl.ret)} in ${fmtAge(pnl.days)} (realized ${usdS(pnl.realized)}, unrealized ${usdS(pnl.unrealized)}).` : "";
    return {
      title: `${SIDE[p.side]} ${lv} on $${p.v.ticker}`,
      text: `${mine ? "I'm" : `${short(o)} is`} ${SIDE[p.side]} on $${p.v.ticker}.${result} ${lv} payout if it ${p.side === 0 ? "pumps" : "dumps"}, ${usd(px.priceUsd(value))} on the line, zero chance of liquidation.`,
      url: shareUrl(`/m/${key}?side=${p.side}`, publicKey),
      image: `/api/og?m=${key}&side=${p.side}&owner=${o}&${bust()}`,
      filename: `${p.v.ticker}-${SIDE[p.side]}.png`,
    };
  };
  const copy = (url: string, title: string, body: string) => {
    navigator.clipboard?.writeText(url);
    toasts.push({ s: "ok", title, body });
  };

  return (
    <>
      <header className="bag-head">
        <div className="bag-id">
          <div className="meta">
            <Link to="/">Board</Link> / bag
          </div>
          <h1 className="display">{mine ? "Your bag." : `${short(o)}'s bag.`}</h1>
          <div className="addr">{o}</div>
        </div>
        <div className="bag-actions">
          <button className="btn ghost" onClick={() => copy(bagShare.url, "Link copied", publicKey ? "Your wallet rides along as the referrer." : "Deep link to this bag.")}>
            Copy link
          </button>
          {mine && (
            <button className="btn ghost" onClick={() => copy(shareUrl("/", publicKey), "Referral link copied", "Anyone who zaps in through it credits you.")}>
              Referral link
            </button>
          )}
          {mine && n > 1 && (armed ? (
            <button className="btn down" onClick={exitAll} disabled={!!busy}>
              Sure? Exit all {n}
            </button>
          ) : (
            <button className="btn ghost" onClick={() => setArmed(true)} disabled={!!busy}>
              Exit everything
            </button>
          ))}
        </div>
      </header>

      <div className="bag-stats" aria-live="polite">
        <div className="panel stat-card">
          <span className="meta">On the table</span>
          <Flash watch={worth} className="display num">
            {!b ? <span className="skeleton" style={{ width: 120, height: 28 }} /> : worth === null ? "—" : <Rolling value={worth} format={usd} />}
          </Flash>
          <span className="meta num">
            curve {usd(px.priceUsd(curveTotal))} · pot {usd(px.priceUsd(potTotal))}
          </span>
          <CardShare text={bagTweet} path={`/p/${o}`} target={bagShare} />
        </div>
        <div className="panel stat-card">
          <span className="meta">Unrealized</span>
          <Flash watch={unrealUsd} className={`display num ${unrealUsd === null ? "" : unrealUsd >= 0 ? "up" : "down"}`}>
            {basis === null ? "…" : unrealUsd === null ? "—" : <Rolling value={unrealUsd} format={signed} />}
          </Flash>
          <span className="meta num">{agg ? `${fmtAnnual(agg.ret)} · ${fmtAge(agg.days)}` : "no buys on record"}</span>
        </div>
        <div className="panel stat-card">
          <span className="meta">Realized</span>
          <Flash watch={realUsd} className={`display num ${realUsd === null ? "" : realUsd >= 0 ? "up" : "down"}`}>
            {basis === null ? "…" : realUsd === null ? "—" : <Rolling value={realUsd} format={signed} />}
          </Flash>
          <span className="meta num">{agg ? `${fmtAnnual(agg.apr)} simple · ${fmtAnnual(agg.apy)} compounded` : "—"}</span>
        </div>
        <div className="panel stat-card">
          <span className="meta">Sides open</span>
          <Flash watch={n} className="display num">
            {b ? n : "…"}
          </Flash>
          <span className="meta num">
            {markets} market{markets === 1 ? "" : "s"}
            {n > 0 && ` · pays up to ${lev(topLev)}`}
          </span>
        </div>
      </div>

      <section className="panel bag-positions" id="positions">
        <h2 className="meta">
          <Anchor id="positions" />
          {mine ? "Your sides" : "Their sides"}
        </h2>
        {!b ? (
          <span className="skeleton" style={{ height: 120 }} />
        ) : n === 0 ? (
          <div className="empty bag-empty">
            <div className="display">Empty bag.</div>
            <Link className="btn" to="/">
              Pick a side →
            </Link>
          </div>
        ) : (
          <ol className="cards pos-cards">
            {vals.map(({ p, units, curve, pot, best, via, pnl }) => (
              <PosCard
                key={p.key}
                p={p}
                units={units}
                curve={curve}
                pot={pot}
                best={best}
                via={via}
                pnl={pnl}
                entry={basis?.get(`${p.v.acct.key.toBase58()}:${p.side}`)}
                mine={mine}
                owner={o}
                busy={busy}
                target={positionShare(p, best, pnl)}
                onExit={() => exit(p)}
                onCash={() => cashOut(p)}
              />
            ))}
          </ol>
        )}
      </section>
      <div className="mkt-grid bag-grid">
        <div className="col">
          <section className="panel" id="moves">
            <h2 className="meta">
              <Anchor id="moves" />
              {mine ? "Your moves" : "Their moves"}
            </h2>
            <Feed actor={o} limit={25} />
          </section>
        </div>
        <div className="col">
          {mine && chores.length > 0 && (
            <section className="panel" id="chores">
              <h2 className="meta">
                <Anchor id="chores" />
                Owed to you
              </h2>
              {chores.map((c) => (
                <div className="panel-row" key={c.id}>
                  {c.kind === "settle" || c.kind === "waiting" ? (
                    <span className="num">
                      ${c.v.ticker} · <b className={cls(c.side)}>{SIDE[c.side]}</b> owes <b>{pct(c.amount, 1)}</b>
                    </span>
                  ) : (
                    <span className="num">
                      ${c.v.ticker} · <b>{usd(px.priceUsd(c.amount))}</b> tips
                    </span>
                  )}
                  {c.kind === "waiting" ? (
                    <span className="chip" title={`Pays the second anyone buys ${SIDE[c.side]}`}>
                      empty curve
                    </span>
                  ) : (
                    <button
                      className={`btn small ${c.kind === "tips" ? "ghost" : ""}`}
                      disabled={!!busy}
                      data-loading={busy === c.id}
                      onClick={() => (c.kind === "settle" ? collect(c.v, c.side) : sweepTips(c.v))}
                    >
                      {c.kind === "settle" ? "Make them pay" : "Sweep tips"}
                    </button>
                  )}
                </div>
              ))}
            </section>
          )}
          {mine && <ReferralPanel owner={o} />}
          <section className="panel" id="powder">
            <h2 className="meta">
              <Anchor id="powder" />
              Dry powder
            </h2>
            <div className="panel-row">
              <span className="muted">SOL</span>
              <Flash watch={b ? Number(b.sol) : null} className="num">
                {b ? `${fmtAmount(b.sol, 9, 4)} · ${usd(px.lamportsUsd(b.sol))}` : "—"}
              </Flash>
            </div>
            <div className="panel-row">
              <span className="muted">Loose change</span>
              <span className="num">
                {!b ? "—" : b.quote > 0n ? usd(px.quoteUsd(b.quote)) : "none"}
                {mine && b && b.quote > 0n && (
                  <>
                    {" "}
                    <button className="chip" disabled={!pool || !!busy} data-loading={busy === "change"} onClick={sweepChange}>
                      sweep to SOL
                    </button>
                  </>
                )}
              </span>
            </div>
            <details className="bag-why">
              <summary className="meta">loose change?</summary>
              <p className="note">Rounding crumbs from every trade. Yours; sweeping turns them back into SOL.</p>
            </details>
          </section>
          <section className="panel" id="coin">
            <h2 className="meta">
              <Anchor id="coin" />${MEME_SYMBOL}
            </h2>
            <div className="panel-row">
              <span className="muted">Held</span>
              <Flash watch={b ? Number(b.meme) : null} className="num">
                {b ? fmtAmount(b.meme, MEME_DECIMALS, 0) : "—"}
              </Flash>
            </div>
            <div className="panel-row">
              <details className="bag-why">
                <summary className="meta">burn bounty?</summary>
                <p className="note">30% of every fee buys this and burns it. Burning yours pays you from that pot, +3%.</p>
              </details>
              <span className="bag-links">
                {HERO_MARKET && (
                  <Link className="btn ghost small" to={`/m/${HERO_MARKET}#burn`}>
                    Burn
                  </Link>
                )}
                <a className="btn ghost small" href={PUMP_URL} target="_blank" rel="noreferrer">
                  Buy
                </a>
              </span>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function PosCard({
  p, units, curve, pot, best, via, pnl, entry, mine, owner, busy, target, onExit, onCash,
}: {
  p: Position; units: number; curve: number; pot: number; best: number; via: "curve" | "pot"; pnl: Pnl | null | undefined; entry: Basis | undefined;
  mine: boolean; owner: string; busy: string | null; target: ShareTarget; onExit: () => void; onCash: () => void;
}) {
  const under = useUnderlying(p.v.underlyingMint);
  const px = usePrices();
  const s = p.v.side[p.side];
  const key = p.v.acct.key.toBase58();
  const ticker = under?.symbol ?? p.v.ticker;
  const value = px.priceUsd(best);
  const other = px.priceUsd(via === "curve" ? pot : curve);
  // per-token entry (what this wallet paid, from its own buys) vs what a token fetches now, both in USD
  const entryPx = entry && entry.tokIn > 0 ? px.priceUsd(entry.inQ / entry.tokIn) : null;
  const nowPx = units > 0 ? px.priceUsd(best / units) : null;
  const tone = pnl ? (pnl.unrealized >= 0 ? "up" : "down") : "";
  const tweet = `${mine ? "I'm" : `${short(owner)} is`} ${SIDE[p.side]} on $${ticker} · pays ${lev(s.leverage)} · ${usd(value)} on the line`;
  return (
    <li className={`card pos-card ${cls(p.side)}`}>
      <div className="card-head">
        <Link to={`/m/${key}?side=${p.side}&tab=sell`} className="card-ticker">
          {under?.image && <img className="tokimg" src={under.image} alt="" />}${ticker}
        </Link>
        <Flash watch={s.leverage} className={`side-badge ${cls(p.side)}`}>
          {SIDE[p.side]} · pays {lev(s.leverage)}
        </Flash>
      </div>
      <div className="card-px">
        <Flash watch={value} className={`num ${tone}`} as="b">
          {usd(value)}
        </Flash>
        {pnl ? <Delta x={pnl.ret} /> : pnl === undefined ? <span className="delta flat">…</span> : null}
        <span className="meta num">at {via}</span>
      </div>
      <Sparkline series={p.v.oracle.series} base={p.v.oracle.lastTwap} w={240} h={48} className="card-spark pos-spark" label={`${ticker} oracle, last hour`} />
      <div className="pos-facts num">
        <span>
          <span className="meta">entry</span>
          <b>{entryPx === null ? "—" : usdPrice(entryPx)}</b>
        </span>
        <span>
          <span className="meta">now</span>
          <Flash watch={nowPx} className={tone} as="b">
            {nowPx === null ? "—" : usdPrice(nowPx)}
          </Flash>
        </span>
        <span>
          <span className="meta">held</span>
          <b>
            {fmtAmount(p.amt, s.decimals, 2)} <span className="meta">{s.symbol}</span>
          </b>
        </span>
        <span>
          <span className="meta">other door</span>
          <b>{usd(other)}</b>
        </span>
        {pnl && (
          <>
            <span>
              <span className="meta">realized</span>
              <b className={pnl.realized >= 0 ? "up" : "down"}>{signed(px.priceUsd(pnl.realized) ?? 0)}</b>
            </span>
            <span>
              <span className="meta">unrealized</span>
              <Flash watch={pnl.unrealized} className={pnl.unrealized >= 0 ? "up" : "down"} as="b">
                {signed(px.priceUsd(pnl.unrealized) ?? 0)}
              </Flash>
            </span>
            <span>
              <span className="meta">held for</span>
              <b>{fmtAge(pnl.days)}</b>
            </span>
            <span>
              <span className="meta">per year</span>
              <b className={(pnl.apr ?? 0) >= 0 ? "up" : "down"}>{fmtAnnual(pnl.apr)}</b>
            </span>
          </>
        )}
      </div>
      {(s.owed > 1e-6 || s.atFloor) && (
        <div className="pos-flags">
          {s.owed > 1e-6 && <span className="chip down">curve owes {pct(s.owed, 1)}</span>}
          {s.atFloor && <span className="chip">curve at floor</span>}
        </div>
      )}
      <div className="card-foot pos-foot">
        <span className="pos-actions">
          {mine && (
            <button className="btn small" disabled={!!busy} data-loading={busy === `x${p.key}`} onClick={onExit}>
              Exit
            </button>
          )}
          {mine && (
            <button className="btn ghost small" disabled={!!busy} data-loading={busy === `c${p.key}`} onClick={onCash}>
              Cash out
            </button>
          )}
        </span>
        <CardShare text={tweet} path={`/m/${key}?side=${p.side}`} target={target} />
      </div>
    </li>
  );
}

/** Clicking a panel title puts that panel in the URL (and the clipboard link). */
function Anchor({ id }: { id: string }) {
  return (
    <a
      href={`#${id}`}
      className="anchor"
      aria-label={`Link to ${id}`}
      onClick={(e) => {
        e.preventDefault();
        setHash(id);
        document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
      }}
    >
      #
    </a>
  );
}

type RefStats = { referrals: number; deposits: string; earned: string; scanned: number; recent: { sig: string; ts: number; funder: string; lamports: string; fee: string }[] };

/** Your link, how the fee share works, and what it has paid so far (read from the chain by /api/ref). */
function ReferralPanel({ owner }: { owner: string }) {
  const { publicKey } = useWallet();
  const px = usePrices();
  const link = shareUrl("/", publicKey);
  const [copied, setCopied] = useState(false);
  const stats = usePoll<RefStats>(async () => {
    const r = await fetch(`/api/ref?w=${owner}`);
    if (!r.ok) throw new Error("referral stats unavailable");
    return r.json();
  }, [owner]);
  const d = stats.data;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <section className="panel ref-panel" id="referrals">
      <h2 className="meta">
        <Anchor id="referrals" />
        Your link
      </h2>
      <div className="ref-link">
        <span className="ref-url num">{link.replace("https://", "")}</span>
        <button className="btn small" onClick={copy}>
          {copied ? "copied ✓" : "Copy"}
        </button>
        <Flex target={siteShare(publicKey)} className="btn ghost small" label="Flex" />
      </div>
      <div className="vc-nums ref-nums">
        <div className="vc-num">
          <span className="meta">wallets referred</span>
          <Flash watch={d?.referrals ?? null} className="display" as="strong">
            {d ? d.referrals : stats.error ? "—" : "…"}
          </Flash>
        </div>
        <div className="vc-num">
          <span className="meta">SOL in</span>
          <Flash watch={d?.deposits ?? null} className="display" as="strong">
            {d ? fmtAmount(BigInt(d.deposits), 9, 2) : "…"}
          </Flash>
          <span className="meta num">{d ? usd(px.lamportsUsd(BigInt(d.deposits))) : ""}</span>
        </div>
        <div className="vc-num">
          <span className="meta">you earned</span>
          <Flash watch={d?.earned ?? null} className="display up" as="strong">
            {d ? usd(px.quoteUsd(BigInt(d.earned))) : "…"}
          </Flash>
          <span className="meta num">{d ? `${fmtAmount(BigInt(d.earned), 9, 6)} r-fstacc` : ""}</span>
        </div>
      </div>
      {d && d.recent.length > 0 && (
        <ul className="ref-recent meta num">
          {d.recent.slice(0, 8).map((h) => (
            <li key={h.sig}>
              <Link to={`/p/${h.funder}`}>{short(h.funder)}</Link> · {fmtAmount(BigInt(h.lamports), 9, 3)} SOL in → {usd(px.quoteUsd(BigInt(h.fee)))} to you · {ago(h.ts)}
            </li>
          ))}
        </ul>
      )}
      {d && d.referrals === 0 && <p className="note">Nobody yet. Flex a market.</p>}
      {stats.error && !d && <p className="err">Referral history unavailable.</p>}
      <details className="bag-why">
        <summary className="meta">how it pays</summary>
        <p className="note">
          Every share button bakes this link in. Buyers who arrive through it enter via the r-fstacc stake pool, which pays <b>half of its 0.1% deposit fee to you</b>,
          on-chain, on every buy they ever make. Lands as loose change; sweeps to SOL whenever you like.
        </p>
      </details>
    </section>
  );
}
