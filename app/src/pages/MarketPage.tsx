import { useEffect, useMemo, useState } from "react";
import { track } from "@vercel/analytics";
import { Link, useParams } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { usePoll, useSend } from "../hooks";
import { useUnderlying } from "../hooks/underlying";
import { usePrices } from "../hooks/price";
import { type Balances, buildSettleTx, curveCapacity, dbc, loadMarketView, toV0, userBalances, type MarketView } from "../lib/chain";
import { claimFeesIx, cu, pokeIx, sideAccounts } from "../lib/hooked";
import { depositOut, depositSolIx, poolState, withdrawCapacity, withdrawOut, type PoolState } from "../lib/zap";
import { curveQuote as curveQuoteFor, exitIxs, planExit, potQuote as potQuoteFor, redeemIxs, sellBackEstimate, whatIf } from "../lib/exit";
import { backIxs, exitGain, MIN_SHARE_LAMPORTS, raiseOpen, shareLamports, RAISE_URL } from "../lib/backable";
import { basisByPosition } from "../lib/pnl";
import { fetchFeed } from "../lib/feed";
import { referralAccount } from "../lib/ref";
import { confetti } from "../lib/confetti";
import { currentShare, setHash, useQuery } from "../lib/url";
import { OracleChart, OraclePrice, Tug } from "../components/bits";
import { useToasts } from "../components/Toasts";
import { ShareSheet, type ShareTarget } from "../components/ShareSheet";
import { Feed, Leaders } from "../components/Live";
import { BurnPanel } from "../components/Coin";
import { DnWidget } from "../components/DnWidget";
import { ago, amount as fmtAmount, lev, parseAmount, pct, price, usd, usdPrice } from "../lib/format";
import { REDEEM_FEE, RFSTACC } from "../config";

type Tab = "buy" | "sell" | "redeem";
const SIDE = ["UP", "DOWN"] as const;

export default function MarketPage() {
  const { key = "" } = useParams();
  const marketKey = useMemo(() => {
    try {
      return new PublicKey(key);
    } catch {
      return null;
    }
  }, [key]);
  const { publicKey } = useWallet();
  const view = usePoll(() => (marketKey ? loadMarketView(marketKey) : Promise.resolve(null)), [key]);
  const v = view.data;
  const bal = usePoll(
    () => (publicKey && v ? userBalances(publicKey, v) : Promise.resolve(null)),
    [publicKey?.toBase58(), v?.acct.key.toBase58(), view.data ? 1 : 0],
  );
  const pool = usePoll(poolState, []);
  const under = useUnderlying(v?.underlyingMint);
  const toasts = useToasts();
  const [share, setShare] = useState<ShareTarget | null>(null);

  // deep-linked panel: the fragment is evaluated before the panel exists, so re-apply it once rendered
  // (native fragment navigation gives us :target highlight + scroll for free)
  useEffect(() => {
    const h = window.location.hash;
    if (!v || !h) return;
    const t = setTimeout(() => {
      history.replaceState(null, "", window.location.pathname + window.location.search);
      window.location.hash = h;
    }, 150);
    return () => clearTimeout(t);
  }, [v?.acct.key.toBase58()]);

  if (!marketKey) return <NotFound what="That isn't a market address." />;
  if (view.loading && !v) return <MarketSkeleton />;
  if (!v) return <NotFound what={view.error ? `Couldn't load: ${view.error}` : "No market at this address."} />;

  const refresh = () => {
    view.refresh();
    bal.refresh();
  };
  const ticker = under?.symbol ?? v.ticker;
  const marketShare: ShareTarget = {
    title: `$${ticker} ±100×`,
    text: `$${ticker} at 100×, up or down. ${lev(v.side[0].leverage)} payout if it pumps, ${lev(v.side[1].leverage)} if it dumps. No liquidations. Somebody's wrong.`,
    url: currentShare(publicKey),
    image: `/api/og?m=${key}`,
    filename: `${ticker}-100x.png`,
  };
  return (
    <>
      <header className="mkt-head">
        <div className="mkt-title">
          <div className="meta">
            <Link to="/">Board</Link> / market
          </div>
          <h1 className="display">
            {under?.image && <img className="tokimg xl" src={under.image} alt="" />}
            {ticker} <span className="muted quote">/ {v.oracle.quote}</span>
          </h1>
          <div className="addr">
            {v.acct.key.toBase58()}
            <span className="sharebar">
              <button className="btn ghost small" onClick={() => setShare(marketShare)}>
                Flex
              </button>
              <button
                className="btn ghost small"
                onClick={() => {
                  navigator.clipboard?.writeText(currentShare(publicKey));
                  toasts.push({ s: "ok", title: "Link copied", body: `Side, tab and amount included.${publicKey ? " Your wallet is the referrer." : ""}` });
                }}
              >
                Copy link
              </button>
            </span>
          </div>
        </div>
        <div className="px">
          <div className="meta" title="TWAP: the time-weighted average price. Pots settle on this, not on spot, so nobody can flash-move it.">Price · {Math.round(v.acct.windowSecs / 60)}-min average</div>
          <div className="big"><OraclePrice x={v.oracle.twap ?? v.oracle.lastTwap} quote={v.oracle.quote} ticker={ticker} /></div>
          <div className="meta num">
            {price(v.oracle.twap ?? v.oracle.lastTwap)} {v.oracle.quote} · observed {ago(v.oracle.updatedTs)}
          </div>
        </div>
      </header>
      <div className="mkt-grid">
        <div className="col">
          <Primer ticker={ticker} />
          <Ticket v={v} bal={bal.data ?? null} pool={pool.data ?? null} onDone={refresh} />
          <section className="panel dnw" id="dn">
            <h2 className="meta">
              <Anchor id="dn" />
              Yield · the delta-neutral vault
            </h2>
            <DnWidget market={v.acct.key} ticker={ticker} quote={v.oracle.quote} onDone={refresh} />
          </section>
          <dl className="rules">
            <div>
              <dt>Every twitch</dt>
              <dd>
                Every time {v.ticker}'s price moves, the losing pot pays the winning pot. A 1% move hands over ~63% of the loser's pot; a 0.1%
                move, ~10%. It can never hand over all of it — nobody gets liquidated, ever.
                <small className="muted num">exact: 1 − 1.0001<sup>−100·|Δtick|</sup> of the loser's pot per move</small>
              </dd>
            </div>
            <div>
              <dt>Every transfer</dt>
              <dd>Anyone's buy, sell or send pulls the trigger. No keeper, no funding, no 3am margin call.</dd>
            </div>
            <div>
              <dt>Fees</dt>
              <dd>
                4% on trades, 4% on cash-outs. 60% back into the pots, 30% buys ${"100XBRO"} and burns it, 10% buys BABY100X and burns it. All on-chain, every time.
              </dd>
            </div>
            <div>
              <dt>Getting out</dt>
              <dd>Sell into the curve, or cash out your slice of the pot minus {pct(REDEEM_FEE, 0)}. SOL in, SOL out. <b>The 0/20 rule:</b> 0% of your stake, 20% of your realized gain gets swapped to USDC and committed to the <a href={RAISE_URL} target="_blank" rel="noopener noreferrer">STACCIndex raise</a> in your name, same transaction. You hold the claim: $STACCS at close, or the USDC back if it misses.</dd>
            </div>
          </dl>
        </div>
        <div className="col">
          <section className="panel" id="live">
            <h2 className="meta">
              <Anchor id="live" />
              <span className="live-dot" aria-hidden />
              Live
            </h2>
            <Feed market={v.acct.key.toBase58()} limit={10} />
          </section>
          <OraclePanel v={v} />
          <VaultPanel v={v} onDone={refresh} />
          <section className="panel" id="leaders">
            <h2 className="meta">
              <Anchor id="leaders" />
              Leaderboard
            </h2>
            <Leaders market={v.acct.key.toBase58()} />
          </section>
          <BookPanel v={v} bal={bal.data ?? null} onShare={setShare} ticker={ticker} />
          <KeeperPanel v={v} onDone={refresh} />
          <BurnPanel />
        </div>
      </div>
      {share && <ShareSheet target={share} onClose={() => setShare(null)} />}
    </>
  );
}

function Ticket({
  v,
  bal,
  pool,
  onDone,
}: {
  v: MarketView;
  bal: Balances | null;
  pool: PoolState | null;
  onDone: () => void;
}) {
  const q = useQuery();
  const side: 0 | 1 = q.get("side") === "1" ? 1 : 0;
  const setSide = (i: 0 | 1) => q.set({ side: i });
  const tabParam = q.get("tab");
  const tab: Tab = tabParam === "sell" || tabParam === "redeem" ? tabParam : "buy";
  const setTab = (t: Tab) => q.set({ tab: t === "buy" ? null : t, amt: null });
  const unit = "SOL" as const;
  const [input, setInputRaw] = useState(() => q.get("amt") ?? "");
  const setInput = (v: string) => {
    setInputRaw(v);
    q.set({ amt: v || null });
  };
  const [quote, setQuote] = useState<{ out: bigint; min: bigint; lst?: bigint; back?: bigint; plan?: { sell: bigint; redeem: bigint; sellMin: bigint; redeemMin: bigint; sellOut: bigint; redeemOut: bigint } } | null>(null);
  const [curveCap, setCurveCap] = useState<bigint | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = useSend();
  const { publicKey } = useWallet();
  const px = usePrices();
  const s = v.side[side];
  const a = sideAccounts(v.keys, side);

  const inDecimals = tab === "buy" ? 9 : s.decimals;
  const raw = parseAmount(input, inDecimals);
  const have = bal ? (tab === "buy" ? bal.sol : side === 0 ? bal.up : bal.down) : null;
  const tooMuch = raw !== null && have !== null && raw > have;
  const invalid = input !== "" && raw === null;
  const payLabel = tab === "buy" ? "Pay SOL" : `${tab === "sell" ? "Exit" : "Burn"} ${s.symbol}`;
  const solOut = tab !== "buy";
  const capacity = pool ? withdrawCapacity(pool) : 0n;

  // curve capacity for this side (how much a sell can push down to the launch price)
  useEffect(() => {
    let alive = true;
    curveCapacity(v, side).then((c) => alive && setCurveCap(c)).catch(() => alive && setCurveCap(null));
    return () => {
      alive = false;
    };
  }, [side, s.vault, v.pending?.amount, a.pool.toBase58()]);

  // pot + curve quotes live in lib/exit.ts (shared with the bag page)
  const potQuote = (n: bigint) => potQuoteFor(v, side, n);
  const curveQuote = (n: bigint, sell: boolean) => curveQuoteFor(v, side, n, sell);

  // live quote: SOL -> r-fstacc (stake pool) -> curve, or curve/pot -> r-fstacc -> SOL
  useEffect(() => {
    setQuote(null);
    setQuoteErr(null);
    if (!raw || raw <= 0n) return;
    if (!pool) return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        if (tab === "buy") {
          const q = await curveQuote(depositOut(pool, raw), false);
          // what the curve would pay to sell those tokens straight back (the honest "flat" number for small bags)
          const back = sellBackEstimate(v, side, q.out, depositOut(pool, raw));
          if (alive) setQuote({ ...q, back });
          return;
        }
        if (tab === "redeem") {
          const pq = potQuote(raw);
          if (!pq) throw new Error("nothing circulating");
          if (alive) setQuote({ out: withdrawOut(pool, pq.safe), min: pq.safe, lst: pq.lst });
          return;
        }
        // sell = exit router (lib/exit.ts): curve for what it can absorb, pot for the rest; whole-pot if that pays more
        const plan = await planExit(v, side, raw, curveCap ?? 0n);
        const min = plan.sellMin + plan.redeemMin;
        if (alive) setQuote({ out: withdrawOut(pool, min), min, lst: plan.sellOut + plan.redeemOut, plan });
      } catch (e) {
        if (alive) setQuoteErr(e instanceof Error ? e.message : "quote failed");
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [raw?.toString(), tab, side, s.vault, s.circulating, a.pool.toBase58(), !!pool, v.pending?.amount, curveCap?.toString()]);

  const outDecimals = tab === "buy" ? s.decimals : 9;
  const outUnit = tab === "buy" ? s.symbol : "SOL";
  const overCapacity = solOut && quote ? quote.out > capacity : false;
  const disabled = !publicKey || !raw || raw <= 0n || tooMuch || invalid || busy || !quote || overCapacity || !pool;

  async function submit() {
    if (!raw || !quote) return;
    setBusy(true);
    const label = `${tab === "buy" ? "Ape" : tab === "sell" ? "Exit" : "Cash out"} ${SIDE[side]}`;
    const sig = await send(label, async (payer) => {
      const quoteAta = getAssociatedTokenAddressSync(RFSTACC, payer);
      const ata = createAssociatedTokenAccountIdempotentInstruction(payer, quoteAta, payer, RFSTACC);
      // the 0/20 rule: a fifth of any realized gain, swapped to USDC and committed to the STACCIndex raise in the user's name
      const withShare = async (ixs: TransactionInstruction[], proceeds: bigint) => {
        if (!solOut || !pool || !raiseOpen()) {
          track("backable_skip", { why: !raiseOpen() ? "closed" : "no_sol_out" });
          return toV0(ixs, payer);
        }
        try {
          const me = payer.toBase58();
          const b = basisByPosition(await fetchFeed(undefined, me, 200), me).get(`${v.acct.key.toBase58()}:${side}`);
          const lam = shareLamports(exitGain(b, Number(raw) / 10 ** s.decimals, proceeds), pool);
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
      if (tab === "redeem") {
        const r = redeemIxs(v, side, raw, payer, solOut ? pool : null);
        return withShare(r.ixs, r.min);
      }
      if (tab === "buy") {
        const amountIn = unit === "SOL" ? depositOut(pool!, raw) : raw;
        const tx = await dbc.pool.swap2WithTransferHook({
          owner: payer, pool: a.pool, swapBaseForQuote: false, referralTokenAccount: null, payer,
          swapMode: SwapMode.ExactIn, amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(quote.min.toString()),
        });
        const ixs = [cu(450_000)];
        if (unit === "SOL") {
          const refAcct = await referralAccount(payer, quoteAta);
          ixs.push(ata, depositSolIx(pool!, payer, quoteAta, raw, refAcct));
        }
        return toV0([...ixs, ...tx.instructions, claimFeesIx(v.keys, side)], payer);
      }
      const plan = quote.plan ?? { sell: raw, redeem: 0n, sellMin: quote.min, redeemMin: 0n, sellOut: 0n, redeemOut: 0n };
      return withShare(await exitIxs(v, side, plan, payer, solOut ? pool : null), plan.sellMin + plan.redeemMin);
    });
    setBusy(false);
    if (sig) {
      setInput("");
      onDone();
      if (tab === "buy") confetti(side);
    }
  }

  const setFrac = (f: number) => {
    if (!have) return;
    const x = (have * BigInt(Math.round(f * 1000))) / 1000n;
    setInput(fmtAmount(x, inDecimals, inDecimals).replace(/,/g, ""));
  };

  return (
    <section className="ticket" aria-label="Trade ticket" id="trade">
      <div className="sides" role="group" aria-label="Side">
        {([0, 1] as const).map((i) => (
          <button key={i} className={`side ${i === 0 ? "u" : "d"}`} aria-pressed={side === i} onClick={() => setSide(i)}>
            <span className="meta">{v.side[i].symbol || SIDE[i]}</span>
            <span className="display">
              {i === 0 ? "Up" : "Down"} 100×<small className="ls">{i === 0 ? "long" : "short"}</small>
            </span>
            <span className="lev">
              {usdPrice(px.priceUsd(v.side[i].curvePrice))} · {lev(v.side[i].leverage)} leverage
            </span>
          </button>
        ))}
      </div>
      <div className="ticket-body">
        <div className="tabs" role="tablist">
          {(["buy", "sell", "redeem"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {t === "redeem" ? "Cash out" : t === "buy" ? "Buy" : "Sell"}
            </button>
          ))}
        </div>
        <p className="tab-help">
          {tab === "buy"
            ? `SOL in, ${s.symbol} out. Those tokens are your slice of the ${SIDE[side]} pot.`
            : tab === "sell"
              ? "Sell your tokens back for SOL. We route to whichever pays more, the curve or the pot."
              : "Burn your tokens for your slice of the pot, paid in SOL, minus 4%."}
        </p>
        <div className="field">
          <label htmlFor="amt">
            <span className="meta">{payLabel}</span>
            <span className="meta num">
              {have === null ? "—" : `balance ${fmtAmount(have, inDecimals)}`}
              {tab === "sell" && curveCap !== null && <> · curve takes {fmtAmount(curveCap, s.decimals, 0)}</>}
            </span>
          </label>
          <div className="input" data-invalid={invalid || tooMuch}>
            <input
              id="amt"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.0"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy}
              aria-invalid={invalid || tooMuch}
            />
            <span className="unit">{tab === "buy" ? "SOL" : s.symbol}</span>
          </div>
          <div className="chips">
            {tab === "buy" &&
              [0.01, 0.05, 0.1].map((v) => (
                // absolute amounts for a first trade: a burner with $10 in it should be one tap from "in"
                <button key={v} className="chip" disabled={busy} onClick={() => setInput(String(v))}>
                  {v} SOL
                </button>
              ))}
            {(tab === "buy" ? [1] : [0.25, 0.5, 1]).map((f) => (
              <button key={f} className="chip" disabled={!have || busy} onClick={() => setFrac(f)}>
                {f === 1 ? "max" : `${f * 100}%`}
              </button>
            ))}
          </div>
          {invalid && <span className="err">Enter a number with at most {inDecimals} decimals.</span>}
          {tooMuch && <span className="err">More than your balance.</span>}
        </div>
        <div className="quote" aria-live="polite">
          <div className="panel-row">
            <span className="muted">You receive{tab === "redeem" || (tab === "sell" && solOut) ? " (at least)" : ""}</span>
            <span className="num">
              {quote ? `${fmtAmount(quote.out, outDecimals)} ${outUnit}` : quoteErr ? "—" : raw ? "…" : "—"}
              {quote && (
                <span className="muted">
                  {" "}
                  ≈{" "}
                  {usd(
                    tab === "buy"
                      ? px.priceUsd((Number(quote.out) / 10 ** s.decimals) * s.curvePrice)
                      : solOut
                        ? px.lamportsUsd(quote.out)
                        : px.quoteUsd(quote.out),
                  )}
                </span>
              )}
            </span>
          </div>
          {tab !== "redeem" ? (
            <div className="panel-row">
              <span className="muted">Fees · slippage limit</span>
              <span className="num">4.1% · 1%</span>
            </div>
          ) : (
            <div className="panel-row">
              <span className="muted">Vault value per token · fee</span>
              <span className="num">
                {usdPrice(px.priceUsd(s.nav))} · {pct(REDEEM_FEE + 0.001, 1)}
              </span>
            </div>
          )}
          <div className="panel-row">
            <span className="muted">
              Leverage right now <span className="num">(their pot ÷ your pot × 100)</span>
            </span>
            <span className={`num ${side === 0 ? "up" : "down"}`}>{Number.isNaN(s.leverage) ? "— pots empty" : lev(s.leverage)}</span>
          </div>
          {Number.isFinite(s.leverage) && s.leverage > 0 && (
            <div className="panel-row">
              <span className="muted">A 0.1% move in {v.ticker}</span>
              <span className="num">
                <span className="up">+{pct(Math.min(((1 - Math.pow(1.0001, -1000)) * s.leverage) / 100, 99), 0)}</span> for you if it goes your way ·{" "}
                <span className="down">−9.5%</span> if not
              </span>
            </div>
          )}
          {tab === "buy" && s.owed > 0.01 && (
            <p className="warn" role="note">
              Heads up: {SIDE[side]} still owes <b className="num">{pct(s.owed, 0)}</b> of its curve price to {SIDE[1 - side]}. The next trade above the floor collects
              it, so a fresh buy's curve value drops right after you buy. Trust the pot numbers below, not the token price.
            </p>
          )}
          {tab === "buy" && quote && pool && (
            <div className="whatif" aria-label="What happens to your money">
              <span className="meta">If {v.ticker} moves in the next hour, your slice of the pot cashes out for…</span>
              <div className="cells">
                {[-0.01, 0, 0.01].map((m) => {
                  const lam = whatIf(v, side, quote.out, side === 0 ? m : -m, pool);
                  return (
                    <div key={m} className={`cell ${(side === 0 ? m : -m) > 0 ? "win" : m !== 0 ? "lose" : ""}`}>
                      <span className="meta">{m === 0 ? "flat" : `${m > 0 ? "+" : "−"}1%`}</span>
                      <strong className="num">{fmtAmount(lam, 9, 4)} SOL</strong>
                      <span className="meta num">{usd(px.lamportsUsd(lam))}</span>
                    </div>
                  );
                })}
              </div>
              {quote.back !== undefined && (
                <span className="meta">
                  Or sell straight back right now for ≈ <b className="num">{fmtAmount(withdrawOut(pool, quote.back), 9, 4)} SOL</b>, whichever of curve or pot
                  pays more. The flat number above is the pot alone.
                </span>
              )}
            </div>
          )}
          {quoteErr && <span className="err">{quoteErr}</span>}
          {overCapacity && <span className="err">That's more SOL than can be released right now — try a smaller amount.</span>}
          {tab === "sell" && quote?.plan && (
            <div className="panel-row">
              <span className="muted">Exit route</span>
              <span className="num">
                {quote.plan.sell > 0n && <>{fmtAmount(quote.plan.sell, s.decimals, 0)} at curve</>}
                {quote.plan.sell > 0n && quote.plan.redeem > 0n && " + "}
                {quote.plan.redeem > 0n && <>{fmtAmount(quote.plan.redeem, s.decimals, 0)} at pot</>}
              </span>
            </div>
          )}
        </div>
        <button className={`btn big ${side === 0 ? "up" : "down"}`} disabled={disabled} data-loading={busy} onClick={submit}>
          {!publicKey
            ? "Connect a wallet. Then pick a side."
            : tab === "buy"
              ? `Buy ${SIDE[side]} 100×`
              : tab === "sell"
                ? `Sell ${SIDE[side]}`
                : `Cash out ${SIDE[side]}`}
        </button>
      </div>
    </section>
  );
}

function OraclePanel({ v }: { v: MarketView }) {
  const px = usePrices();
  const now = v.oracle.twap ?? v.oracle.lastTwap;
  const chg = now / v.oracle.lastTwap - 1;
  const loser = v.pending ? SIDE[v.pending.payer] : null;
  return (
    <section className="panel oracle" id="oracle">
      <h2 className="meta">
        <Anchor id="oracle" />
        Oracle · {v.ticker}/{v.oracle.quote} on Raydium · {Math.round(v.acct.windowSecs / 60)}-min TWAP</h2>
      <OracleChart series={v.oracle.series} twap={v.oracle.twap} lastTwap={v.oracle.lastTwap} fmt={(p) => px.oracleFmt(p, v.oracle.quote, v.ticker)} />
      <div className="legend">
        <span>
          <i className="sw spot" /> spot
        </span>
        <span>
          <i className="sw twap" /> TWAP now <b className="num">{px.oracleFmt(now, v.oracle.quote, v.ticker)}</b>
        </span>
        <span>
          <i className="sw ref" /> at last rebalance <b className="num">{px.oracleFmt(v.oracle.lastTwap, v.oracle.quote, v.ticker)}</b>
        </span>
      </div>
      <p className="story">
        {Math.abs(chg) < 5e-6 ? (
          <>Hasn't twitched since last time. Nobody owes anybody. Boring. Fix that.</>
        ) : (
          <>
            {v.ticker} twitched <b className={`num ${chg > 0 ? "up" : "down"}`}>{chg > 0 ? "+" : ""}{(chg * 100).toFixed(3)}%</b> since last
            time. At 100× that's <span className={loser === "UP" ? "up" : "down"}>{loser}</span> owing{" "}
            <b className="num">{v.pending ? pct(1 - v.pending.keep, 1) : "—"}</b> of its pot
            {v.pending ? <> — <b className="num">{usd(px.quoteUsd(v.pending.amount))}</b> leaves on the next transfer</> : null}.
          </>
        )}
      </p>
    </section>
  );
}

function VaultPanel({ v, onDone }: { v: MarketView; onDone: () => void }) {
  const send = useSend();
  const px = usePrices();
  const [busy, setBusy] = useState<string | null>(null);
  const total = v.side[0].vault + v.side[1].vault;
  const unclaimed = v.side[0].unclaimed + v.side[1].unclaimed;
  const run = async (id: string, label: string, build: Parameters<typeof send>[1]) => {
    setBusy(id);
    if (await send(label, build)) onDone();
    setBusy(null);
  };
  return (
    <section className="panel" id="vaults">
      <h2 className="meta">
        <Anchor id="vaults" />
        Pots · {usd(px.quoteUsd(total))} <span className="num">· {px.sol(total, 3)}</span>
      </h2>
      <Tug up={v.side[0].vault} down={v.side[1].vault} levUp={v.side[0].leverage} levDown={v.side[1].leverage} size="lg" />
      <div className="vtable" role="table" aria-label="Vaults">
        <div className="vrow meta" role="row">
          <span role="columnheader">Side</span>
          <span role="columnheader">Pot</span>
          <span role="columnheader">Per token</span>
          <span role="columnheader" title="Curve price ÷ what the pot pays per token when you cash out. The hype tax.">Hype tax</span>
        </div>
        {([0, 1] as const).map((i) => {
          const s = v.side[i];
          const prem = s.nav > 0 ? s.curvePrice / s.nav - 1 : NaN;
          return (
            <div className="vrow num" role="row" key={i}>
              <span className={i === 0 ? "up" : "down"} role="cell">
                {SIDE[i]}
              </span>
              <span role="cell">{usd(px.quoteUsd(s.vault))}</span>
              <span role="cell">{usdPrice(px.priceUsd(s.nav))}</span>
              <span role="cell" className="muted">
                {!Number.isFinite(prem) ? "—" : prem >= 9 ? `${(prem + 1).toFixed(0)}× vault` : `${prem >= 0 ? "+" : ""}${pct(prem, 0)}`}
              </span>
            </div>
          );
        })}
      </div>
      <div className="action">
        <p>
          {unclaimed > 0n ? (
            <>
              <b className="num">{usd(px.quoteUsd(unclaimed))}</b> in tips is sitting in the curves. Every trade here sweeps its
              side; anyone can sweep both.
            </>
          ) : (
            "Tips swept. The pots have everything."
          )}
        </p>
        <button
          className="btn ghost small"
          disabled={unclaimed === 0n || !!busy}
          data-loading={busy === "fees"}
          onClick={() => run("fees", "Claim fees", async (p) => toV0([cu(200_000), claimFeesIx(v.keys, 0), claimFeesIx(v.keys, 1)], p))}
        >
          Sweep tips
        </button>
      </div>
      <div className="action">
        <p>
          {v.pending ? (
            <>
              <span className={v.pending.payer === 0 ? "up" : "down"}>{SIDE[v.pending.payer]}</span> owes{" "}
              <span className={v.pending.payer === 0 ? "down" : "up"}>{SIDE[1 - v.pending.payer]}</span>{" "}
              <b className="num">{usd(px.quoteUsd(v.pending.amount))}</b>. Any transfer collects it.
            </>
          ) : (
            "Pots are square with the oracle."
          )}
        </p>
        <button
          className="btn ghost small"
          disabled={!v.pending || !!busy}
          data-loading={busy === "poke"}
          onClick={() => run("poke", "Rebalance", async (p) => toV0([cu(60_000), pokeIx(v.keys)], p))}
        >
          Make them pay
        </button>
      </div>
    </section>
  );
}

function BookPanel({
  v,
  bal,
  onShare,
  ticker,
}: {
  v: MarketView;
  bal: Balances | null;
  onShare: (t: ShareTarget) => void;
  ticker: string;
}) {
  const { publicKey } = useWallet();
  const px = usePrices();
  if (!publicKey) return null;
  const owner = publicKey.toBase58();
  const key = v.acct.key.toBase58();
  const positionShare = (i: 0 | 1, amt: bigint): ShareTarget => {
    const s = v.side[i];
    const units = Number(amt) / 10 ** s.decimals;
    return {
      title: `${SIDE[i]} 100× on $${ticker}`,
      text: `I'm ${SIDE[i]} 100× on $${ticker}. ${lev(s.leverage)} payout if it ${i === 0 ? "pumps" : "dumps"}, ${usd(px.priceUsd(units * s.curvePrice))} on the line, zero chance of liquidation. Come take it.`,
      url: currentShare(publicKey).replace(/([?&])side=\d/, `$1side=${i}`),
      image: `/api/og?m=${key}&side=${i}&owner=${owner}`,
      filename: `${ticker}-${SIDE[i]}-100x.png`,
    };
  };
  const portfolioShare: ShareTarget = {
    title: "My 100× bag",
    text: "My ±100× bag on 100x.broker. Up or down, no liquidations, somebody's paying me.",
    url: currentShare(publicKey),
    image: `/api/og?owner=${owner}`,
    filename: "100x-book.png",
  };
  const rows = [
    { i: 0 as const, amt: bal?.up ?? 0n },
    { i: 1 as const, amt: bal?.down ?? 0n },
  ];
  const any = rows.some((r) => r.amt > 0n);
  return (
    <section className="panel" id="book">
      <h2 className="meta">
        <Anchor id="book" />
        Your book
        <span className="right h2-actions">
          <Link className="btn ghost small" to="/me">
            Full bag →
          </Link>
          <button className="btn ghost small" onClick={() => onShare(portfolioShare)}>
            Flex bag
          </button>
        </span>
      </h2>
      {!bal ? (
        <span className="skeleton" style={{ height: 48 }} />
      ) : !any ? (
        <p className="note">You're a spectator. Pick a side.</p>
      ) : (
        rows
          .filter((r) => r.amt > 0n)
          .map(({ i, amt }) => {
            const s = v.side[i];
            const units = Number(amt) / 10 ** s.decimals;
            return (
              <div className="panel-row" key={i}>
                <span className={i === 0 ? "up" : "down"}>
                  <span className="num">{fmtAmount(amt, s.decimals, 2)}</span> {SIDE[i]}
                  <span className="book-row-actions">
                    <button className="chip" onClick={() => onShare(positionShare(i, amt))}>
                      flex
                    </button>
                  </span>
                </span>
                <span className="num">
                  {s.atFloor ? "nothing" : usd(px.priceUsd(Math.min(units * s.curvePrice, Number(s.reserve) / 1e9)))} at curve ·{" "}
                  {usd(px.priceUsd(units * s.nav * (1 - REDEEM_FEE)))} if you cash out
                </span>
              </div>
            );
          })
      )}
      <div className="panel-row">
        <span className="muted">Dry powder</span>
        <span className="num">{bal ? `${fmtAmount(bal.sol, 9, 4)} · ${usd(px.lamportsUsd(bal.sol))}` : "—"}</span>
      </div>
    </section>
  );
}

function KeeperPanel({ v, onDone }: { v: MarketView; onDone: () => void }) {
  const send = useSend();
  const [busy, setBusy] = useState<string | null>(null);
  const [donate, setDonate] = useState("");
  const donateRaw = parseAmount(donate, 9);
  const pool = usePoll(poolState, []).data ?? null;
  const run = async (id: string, label: string, build: Parameters<typeof send>[1]) => {
    setBusy(id);
    if (await send(label, build)) onDone();
    setBusy(null);
  };
  return (
    <details className="panel keep" id="keep">
      <summary className="meta">
        <Anchor id="keep" />
        Chores · optional, for keepers. Anyone can, nobody's paid, everybody wins
      </summary>
      <div className="actions">
        {([0, 1] as const).map((i) => (
          <div className="action" key={`s${i}`}>
            <p>
              <span className={i === 0 ? "up" : "down"}>{SIDE[i]}</span> curve is{" "}
              <b className="num">{v.side[i].owed > 1e-6 ? `${pct(v.side[i].owed, 2)} in the hole` : "square"}</b>.{" "}
              {v.side[i].owed > 1e-6 && v.side[i].atFloor
                ? `It's been drained to its launch price — the debt gets collected the second ${SIDE[i]} trades above the floor.`
                : `Collecting mints ${SIDE[i]} and sells it into its own curve; the proceeds land in the ${SIDE[1 - i]} pot.`}
            </p>
            <button
              className="btn ghost small"
              disabled={v.side[i].owed <= 1e-6 || v.side[i].atFloor || !!busy || v.acct.settling}
              data-loading={busy === `s${i}`}
              onClick={() => run(`s${i}`, `Settle ${SIDE[i]}`, async (p) => (await buildSettleTx(v, i, p)).tx)}
            >
              Collect from {SIDE[i]}
            </button>
          </div>
        ))}
        <div className="action">
          <div className="field">
            <p>Tip the pots. SOL, split evenly, you get nothing back except a deeper game.</p>
            <div className="input text">
              <input
                inputMode="decimal"
                placeholder="0.0"
                value={donate}
                onChange={(e) => setDonate(e.target.value)}
                aria-label="Donation in SOL"
              />
              <span className="unit">SOL</span>
            </div>
          </div>
          <button
            className="btn ghost small"
            disabled={!donateRaw || donateRaw < 1_000_000n || !!busy || !pool}
            data-loading={busy === "donate"}
            onClick={() =>
              run("donate", "Donate to vaults", async (p) => {
                const from = getAssociatedTokenAddressSync(RFSTACC, p);
                const minted = depositOut(pool!, donateRaw!);
                const half = minted / 2n;
                return new Transaction().add(
                  createAssociatedTokenAccountIdempotentInstruction(p, from, p, RFSTACC),
                  depositSolIx(pool!, p, from, donateRaw!, await referralAccount(p, from)),
                  createTransferInstruction(from, sideAccounts(v.keys, 0).vault, p, half),
                  createTransferInstruction(from, sideAccounts(v.keys, 1).vault, p, minted - half),
                );
              }).then(() => setDonate(""))
            }
          >
            Tip
          </button>
        </div>
      </div>
    </details>
  );
}

function MarketSkeleton() {
  return (
    <div aria-busy="true">
      <div className="mkt-head">
        <span className="skeleton" style={{ width: 240, height: 56 }} />
      </div>
      <div className="mkt-grid">
        <span className="skeleton" style={{ height: 420 }} />
        <div className="col">
          <span className="skeleton" style={{ height: 180 }} />
          <span className="skeleton" style={{ height: 140 }} />
        </div>
      </div>
    </div>
  );
}

function NotFound({ what }: { what: string }) {
  return (
    <div className="empty">
      <div className="display">Off the board.</div>
      <p>{what} Not even a rug.</p>
      <Link className="btn ghost" to="/">
        Back to the board
      </Link>
    </div>
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

/** First-visit orientation: three sentences, one dismiss, remembered per browser. */
function Primer({ ticker }: { ticker: string }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem("primer") === "1";
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  const hide = () => {
    try {
      localStorage.setItem("primer", "1");
    } catch {}
    setHidden(true);
  };
  return (
    <aside className="primer" aria-label="How this works">
      <strong>New here? The 20-second version.</strong>
      <p className="pitch">
        You long ${ticker}? Long it. Short? Short it. Don't want to be long or short but think it's gonna be a wild ride?{" "}
        <a href="#dn">Park it in the vault.</a>
      </p>
      <ol>
        <li>
          Pick <b className="up">UP</b> if you think ${ticker} goes up in the next hour, <b className="down">DOWN</b> if down.
        </li>
        <li>Pay SOL, get tokens. Your tokens are your slice of your side's pot.</li>
        <li>Every move in ${ticker}'s price, the losing pot pays the winning pot. Sell or cash out whenever. Nobody gets liquidated.</li>
      </ol>
      <button className="linkish" onClick={hide}>
        got it, hide this →
      </button>
    </aside>
  );
}
