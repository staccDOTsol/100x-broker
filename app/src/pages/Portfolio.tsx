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
import { aggregatePnl, basisByPosition, fmtAge, fmtAnnual, positionPnl, type Pnl } from "../lib/pnl";
import { exitIxs, planExit, redeemIxs } from "../lib/exit";
import { backIxs, exitGain, MIN_SHARE_LAMPORTS, raiseOpen, shareLamports } from "../lib/backable";
import { poolState, tokensForLamports, withdrawCapacity, withdrawOut, withdrawSolIx } from "../lib/zap";
import { claimFeesIx, cu } from "../lib/hooked";
import { shareUrl } from "../lib/ref";
import { setHash } from "../lib/url";
import { ShareSheet, type ShareTarget } from "../components/ShareSheet";
import { Feed } from "../components/Live";
import { WalletButton } from "../components/bits";
import { useToasts } from "../components/Toasts";
import { ago, amount as fmtAmount, lev, pct, short, usd } from "../lib/format";
import { Flex, bust, siteShare } from "../components/Flex";
import { HERO_MARKET, MEME_SYMBOL, PUMP_URL, RFSTACC } from "../config";

const SIDE = ["UP", "DOWN"] as const;
const cls = (s: 0 | 1) => (s === 0 ? "up" : "down");

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
        <div className="display">That isn't a wallet.</div>
        <p>Not even a burner.</p>
        <Link className="btn ghost" to="/">
          Back to the board
        </Link>
      </div>
    );
  if (!owner)
    return (
      <div className="empty">
        <div className="display">Your bag.</div>
        <p>Connect and we'll show every side you're on, what it's worth at the curve and at the pot, and the way out.</p>
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
  const [share, setShare] = useState<ShareTarget | null>(null);
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
  const usdSigned = (q: number) => {
    const u = px.priceUsd(q);
    return u === null ? "—" : `${u < 0 ? "−" : "+"}${usd(Math.abs(u))}`;
  };
  const n = vals.length;
  const markets = new Set(vals.map((x) => x.p.v.acct.key.toBase58())).size;
  const curveTotal = vals.reduce((s, x) => s + x.curve, 0);
  const potTotal = vals.reduce((s, x) => s + x.pot, 0);
  const worth = px.priceUsd(vals.reduce((s, x) => s + x.best, 0));

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

  const bagShare: ShareTarget = {
    title: mine ? "My 100× bag" : `${short(o)}'s 100× bag`,
    text: mine
      ? `My ±100× bag on 100x.broker: ${n} side${n === 1 ? "" : "s"}, ${usd(worth)} on the table. Up or down, no liquidations, somebody's paying me.`
      : `${short(o)} is running ${n} side${n === 1 ? "" : "s"} at ±100× on 100x.broker. Somebody's paying them.`,
    url: shareUrl(`/p/${o}`, publicKey),
    image: `/api/og?owner=${o}&${bust()}`,
    filename: `${short(o)}-100x-bag.png`,
  };
  const positionShare = (p: Position, value: number, pnl?: Pnl | null): ShareTarget => {
    const key = p.v.acct.key.toBase58();
    const usdS = (q: number) => {
      const u = px.priceUsd(q);
      return u === null ? "—" : `${u < 0 ? "−" : "+"}${usd(Math.abs(u))}`;
    };
    const result = pnl ? ` ${fmtAnnual(pnl.ret)} in ${fmtAge(pnl.days)} (realized ${usdS(pnl.realized)}, unrealized ${usdS(pnl.unrealized)}).` : "";
    return {
      title: `${SIDE[p.side]} 100× on $${p.v.ticker}`,
      text: `${mine ? "I'm" : `${short(o)} is`} ${SIDE[p.side]} 100× on $${p.v.ticker}.${result} ${lev(p.v.side[p.side].leverage)} payout if it ${p.side === 0 ? "pumps" : "dumps"}, ${usd(px.priceUsd(value))} on the line, zero chance of liquidation.`,
      url: shareUrl(`/m/${key}?side=${p.side}`, publicKey),
      image: `/api/og?m=${key}&side=${p.side}&owner=${o}&${bust()}`,
      filename: `${p.v.ticker}-${SIDE[p.side]}-100x.png`,
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
          <div className="worth display num" aria-live="polite">
            {b ? usd(worth) : <span className="skeleton" style={{ width: 200, height: 48 }} />}
          </div>
          <div className="split meta num">
            <span>
              {n} side{n === 1 ? "" : "s"} on {markets} market{markets === 1 ? "" : "s"}
            </span>
            <span>at curve {usd(px.priceUsd(curveTotal))}</span>
            <span>at pot {usd(px.priceUsd(potTotal))}</span>
            <span>dry powder {b ? `${fmtAmount(b.sol, 9, 3)} SOL` : "—"}</span>
            {b && b.quote > 0n && <span>loose change {usd(px.quoteUsd(b.quote))}</span>}
          </div>
          <div className="pnl-strip" aria-label="Profit and loss">
            {basis === null ? (
              <span className="meta">P&amp;L …</span>
            ) : agg ? (
              <>
                <div className="pnl-cell">
                  <span className="meta">realized</span>
                  <strong className={`num ${agg.realized >= 0 ? "up" : "down"}`}>{usdSigned(agg.realized)}</strong>
                  <span className="meta num">taken out, net of cost</span>
                </div>
                <div className="pnl-cell">
                  <span className="meta">unrealized</span>
                  <strong className={`num ${agg.unrealized >= 0 ? "up" : "down"}`}>{usdSigned(agg.unrealized)}</strong>
                  <span className="meta num">held now vs what it cost</span>
                </div>
                <div className="pnl-cell">
                  <span className="meta">return</span>
                  <strong className={`num ${agg.ret >= 0 ? "up" : "down"}`}>{fmtAnnual(agg.ret)}</strong>
                  <span className="meta num">
                    on {usd(px.priceUsd(agg.cost))} in · {fmtAge(agg.days)} avg hold
                  </span>
                </div>
                <div className="pnl-cell">
                  <span className="meta">simple · per year</span>
                  <strong className={`num ${(agg.apr ?? 0) >= 0 ? "up" : "down"}`}>{fmtAnnual(agg.apr)}</strong>
                  <span className="meta num">return × 365 ÷ days held</span>
                </div>
                <div className="pnl-cell">
                  <span className="meta">compounded · per year</span>
                  <strong className={`num ${(agg.apy ?? 0) >= 0 ? "up" : "down"}`}>{fmtAnnual(agg.apy)}</strong>
                  <span className="meta num">if it kept doing this</span>
                </div>
              </>
            ) : (
              <span className="meta">no buys on record for this bag, so no P&amp;L</span>
            )}
          </div>
        </div>
        <div className="bag-actions">
          <button className="btn" onClick={() => setShare(bagShare)} disabled={!b}>
            Flex bag
          </button>
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

      <section className="panel bag-positions" id="positions">
        <h2 className="meta">
          <Anchor id="positions" />
          {mine ? "Sides you're on" : "Sides they're on"}
        </h2>
        {!b ? (
          <span className="skeleton" style={{ height: 120 }} />
        ) : n === 0 ? (
          <p className="note">
            Nothing in the bag. Spectating is free; it also pays nothing. <Link to="/">Pick a side →</Link>
          </p>
        ) : (
          <ol className="pos-list">
            {vals.map(({ p, curve, pot, best, via, pnl }) => (
              <PosRow
                key={p.key}
                p={p}
                curve={curve}
                pot={pot}
                best={best}
                via={via}
                pnl={pnl}
                mine={mine}
                busy={busy}
                onExit={() => exit(p)}
                onCash={() => cashOut(p)}
                onFlex={() => setShare(positionShare(p, best, pnl))}
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
                Money on your side of the table
              </h2>
              {chores.map((c) => (
                <div className="panel-row" key={c.id}>
                  {c.kind === "settle" || c.kind === "waiting" ? (
                    <span>
                      ${c.v.ticker}: <b className={cls(c.side)}>{SIDE[c.side]}</b> owes your pot <b className="num">{pct(c.amount, 1)}</b> of its curve
                      {c.kind === "waiting" && <span className="muted"> · its curve is empty, so it pays the second anyone buys {SIDE[c.side]}</span>}
                    </span>
                  ) : (
                    <span>
                      ${c.v.ticker}: <b className="num">{usd(px.priceUsd(c.amount))}</b> in tips still sitting on the curves
                    </span>
                  )}
                  {c.kind === "waiting" ? (
                    <span className="meta nowrap">waiting</span>
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
              <span className="num">{b ? `${fmtAmount(b.sol, 9, 4)} · ${usd(px.lamportsUsd(b.sol))}` : "—"}</span>
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
            <p className="note">Rounding leaves crumbs behind on every trade. They're yours; sweeping turns them back into SOL.</p>
          </section>
          <section className="panel" id="coin">
            <h2 className="meta">
              <Anchor id="coin" />${MEME_SYMBOL}
            </h2>
            <div className="panel-row">
              <span className="muted">Held</span>
              <span className="num">{b ? fmtAmount(b.meme, MEME_DECIMALS, 0) : "—"}</span>
            </div>
            <div className="panel-row">
              <span className="muted">30% of every fee buys this and burns it. Burning yours pays you from that pot, +3%.</span>
              <span className="bag-links">
                {HERO_MARKET && (
                  <Link className="btn ghost small" to={`/m/${HERO_MARKET}#burn`}>
                    Burn for the bounty
                  </Link>
                )}
                <a className="btn ghost small" href={PUMP_URL} target="_blank" rel="noreferrer">
                  Buy on pump
                </a>
              </span>
            </div>
          </section>
        </div>
      </div>
      {share && <ShareSheet target={share} onClose={() => setShare(null)} />}
    </>
  );
}

function PosRow({
  p, curve, pot, best, via, pnl, mine, busy, onExit, onCash, onFlex,
}: {
  p: Position; curve: number; pot: number; best: number; via: "curve" | "pot"; pnl: Pnl | null | undefined; mine: boolean; busy: string | null;
  onExit: () => void; onCash: () => void; onFlex: () => void;
}) {
  const under = useUnderlying(p.v.underlyingMint);
  const px = usePrices();
  const usdSigned = (q: number) => {
    const u = px.priceUsd(q);
    return u === null ? "—" : `${u < 0 ? "−" : "+"}${usd(Math.abs(u))}`;
  };
  const s = p.v.side[p.side];
  const key = p.v.acct.key.toBase58();
  const ticker = under?.symbol ?? p.v.ticker;
  return (
    <li className="pos">
      <Link to={`/m/${key}?side=${p.side}&tab=sell`} className="pos-id">
        {under?.image && <img className="tokimg" src={under.image} alt="" />}
        <span>
          <b className={cls(p.side)}>{SIDE[p.side]} 100×</b> on ${ticker}
        </span>
      </Link>
      <span className="pos-amt num">
        {fmtAmount(p.amt, s.decimals, 2)} <span className="meta">{s.symbol}</span>
      </span>
      <span className="pos-val num">
        <b>{usd(px.priceUsd(best))}</b>
        <span className="meta">
          {via === "curve" ? "at curve" : "at pot"} · {usd(px.priceUsd(via === "curve" ? pot : curve))} the other way
        </span>
      </span>
      <span className="pos-meta meta num">
        {lev(s.leverage)} payout
        {s.owed > 1e-6 && <> · curve {pct(s.owed, 1)} in the hole</>}
        {s.atFloor && <> · curve at floor</>}
      </span>
      <span className="pos-pnl num">
        {pnl === undefined ? (
          <span>P&amp;L …</span>
        ) : pnl === null ? (
          <span>no buy on record here, so no entry price</span>
        ) : (
          <>
            <span>
              realized <b className={pnl.realized >= 0 ? "up" : "down"}>{usdSigned(pnl.realized)}</b>
            </span>
            <span>
              unrealized <b className={pnl.unrealized >= 0 ? "up" : "down"}>{usdSigned(pnl.unrealized)}</b>
            </span>
            <span>
              <b className={pnl.ret >= 0 ? "up" : "down"}>{fmtAnnual(pnl.ret)}</b> in {fmtAge(pnl.days)}
            </span>
            <span>simple {fmtAnnual(pnl.apr)}/yr</span>
            <span>compounded {fmtAnnual(pnl.apy)}/yr</span>
          </>
        )}
      </span>
      <span className="pos-actions">
        {mine && (
          <button className="btn small" disabled={!!busy} data-loading={busy === `x${p.key}`} onClick={onExit}>
            Exit
          </button>
        )}
        {mine && (
          <button className="btn ghost small" disabled={!!busy} data-loading={busy === `c${p.key}`} onClick={onCash}>
            Cash out at pot
          </button>
        )}
        <button className="chip" onClick={onFlex}>
          flex
        </button>
      </span>
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
        Your referral link
      </h2>
      <div className="ref-link">
        <span className="ref-url num">{link.replace("https://", "")}</span>
        <button className="btn small" onClick={copy}>
          {copied ? "copied ✓" : "Copy"}
        </button>
        <Flex target={siteShare(publicKey)} className="btn ghost small" label="Flex" />
      </div>
      <p className="note">
        Every share button on the site bakes this link in. When someone who arrived through it buys, their SOL enters through the r-fstacc stake
        pool and the pool pays <b>half of its 0.1% deposit fee to you</b>, on-chain, on every buy they ever make here. It lands in your r-fstacc
        account — the "loose change" above — and sweeps to SOL whenever you like.
      </p>
      <div className="vc-nums ref-nums">
        <div className="vc-num">
          <span className="meta">wallets referred</span>
          <strong className="display">{d ? d.referrals : stats.error ? "—" : "…"}</strong>
          <span className="meta num">bought at least once through you</span>
        </div>
        <div className="vc-num">
          <span className="meta">SOL they put in</span>
          <strong className="display">{d ? fmtAmount(BigInt(d.deposits), 9, 2) : "…"}</strong>
          <span className="meta num">{d ? usd(px.lamportsUsd(BigInt(d.deposits))) : ""}</span>
        </div>
        <div className="vc-num">
          <span className="meta">you earned</span>
          <strong className="display up">{d ? usd(px.quoteUsd(BigInt(d.earned))) : "…"}</strong>
          <span className="meta num">{d ? `${fmtAmount(BigInt(d.earned), 9, 6)} r-fstacc · 0.05% of their buys` : ""}</span>
        </div>
      </div>
      {d && d.recent.length > 0 && (
        <ul className="ref-recent meta num">
          {d.recent.slice(0, 8).map((h) => (
            <li key={h.sig}>
              <Link to={`/p/${h.funder}`}>{short(h.funder)}</Link> put in {fmtAmount(BigInt(h.lamports), 9, 3)} SOL → you got {usd(px.quoteUsd(BigInt(h.fee)))} · {ago(h.ts)}
            </li>
          ))}
        </ul>
      )}
      {d && d.referrals === 0 && <p className="note">Nobody through your link yet. Flex a market; the chip is on every card.</p>}
      {stats.error && !d && <p className="err">Couldn't read referral history right now.</p>}
    </section>
  );
}
