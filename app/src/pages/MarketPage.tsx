// /m/:key — one market as a trading terminal (Operate): the market strip with its siblings and every other market a click away,
// the holders and live moves on the left, the oracle chart in the middle with your positions, history and every trade under it,
// and the ticket on the right (Long · Short · Yield; Ape · Sell · Cash out) with your PnL and the house rules. Pots, chores, the
// pump companions and the burn sit under the hood below. Mechanics are the program's: no liquidations, the thin side pays most.
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
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
import { type Balances, buildSettleTx, conn, curveCapacity, dbc, explorer, loadMarketView, toV0, userBalances, type MarketView } from "../lib/chain";
import { claimFeesIx, cu, pokeIx, sideAccounts } from "../lib/hooked";
import { depositOut, depositSolIx, poolState, withdrawCapacity, withdrawOut, type PoolState } from "../lib/zap";
import { curveQuote as curveQuoteFor, exitIxs, planExit, potQuote as potQuoteFor, redeemIxs, sellBackEstimate, whatIf } from "../lib/exit";
import { backIxs, exitGain, MIN_SHARE_LAMPORTS, raiseOpen, shareLamports, RAISE_URL } from "../lib/backable";
import { basisByPosition, positionPnl } from "../lib/pnl";
import { fetchFeed, fetchLeaders, fetchMarketStats, fetchWinners, type Ev } from "../lib/feed";
import { referralAccount } from "../lib/ref";
import { confetti } from "../lib/confetti";
import { currentShare, setHash, useQuery } from "../lib/url";
import { Tug, WalletButton } from "../components/bits";
import { Flash } from "../components/Pulse";
import { fetchViews } from "../lib/views";
import { useToasts } from "../components/Toasts";
import { ShareSheet, type ShareTarget } from "../components/ShareSheet";
import { Tweet } from "../components/Share";
import { BurnPanel } from "../components/Coin";
import { type MarketVault, useMarketVault, useVaultCoin, yieldApy, yieldBlocker, YieldPane } from "../components/DnWidget";
import { PumpPair } from "../components/PumpPair";
import { PinButton } from "../components/PinButton";
import { ProviderTrade } from "../components/ProviderTrade";
import { Feed } from "../components/Live";
import { LEGACY_UNAVAILABLE } from "../lib/deployment";
import { rememberMarket, replacementMarket } from "../lib/market-navigation";
import { pct0 } from "./Yield";
import { ago, amount as fmtAmount, lev, parseAmount, pct, short, usd, usdPrice } from "../lib/format";
import { REDEEM_FEE, RFSTACC } from "../config";
import { useSort } from "../lib/order";
import { Avatar, eventRow, HouseRules, MarketBar, MarketPills, PnlCard, TermChart, TraderList, type TRow } from "../components/Terminal";

type Tab = "buy" | "sell" | "redeem";
const SIDE = ["UP", "DOWN"] as const;
type Q = { out: bigint; min: bigint; lst?: bigint; back?: bigint; plan?: { sell: bigint; redeem: bigint; sellMin: bigint; redeemMin: bigint; sellOut: bigint; redeemOut: bigint } };

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
  const view = usePoll(() => (marketKey ? loadMarketView(marketKey) : Promise.resolve(null)), [key], 6_000);
  const v = view.data && marketKey && view.data.acct.key.equals(marketKey) ? view.data : null;
  // the rest of the board, for the switcher (edge snapshot, no extra RPC), and its volume/age for the order
  const others = usePoll(fetchViews, [], 30_000);
  const stats = usePoll(() => fetchMarketStats(24), [], 60_000);
  const [sort, setSort] = useSort();
  const feed = usePoll(() => fetchFeed(key), [key], 6_000);
  const wins = usePoll(fetchWinners, [], 20_000);
  const movesHour = (feed.data ?? []).filter((e) => e.ts >= Date.now() / 1000 - 3600).length;
  const bal = usePoll(
    () => (publicKey && v ? userBalances(publicKey, v) : Promise.resolve(null)),
    [publicKey?.toBase58(), v?.acct.key.toBase58(), view.data ? 1 : 0],
  );
  const pool = usePoll(poolState, []);
  const under = useUnderlying(v?.underlyingMint);
  const vault = useMarketVault(marketKey, v?.keys.oraclePool ?? null);
  const toasts = useToasts();
  const px = usePrices();
  const [share, setShare] = useState<ShareTarget | null>(null);

  // the nav's "Trade" reopens the last market that actually loaded
  useEffect(() => {
    if (!v) return;
    rememberMarket(v.acct.key);
  }, [v?.acct.key.toBase58()]);

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
  if (!v && view.error === LEGACY_UNAVAILABLE) return (
    <ClosedMarket key={key} marketKey={marketKey} active={others.data ?? []} />
  );
  if (!v) return <NotFound what={view.error ? `Couldn't load: ${view.error}` : "No market at this address."} />;

  const refresh = () => {
    view.refresh();
    bal.refresh();
  };
  const ticker = under?.symbol ?? v.ticker;
  const twapNow = v.oracle.twap ?? v.oracle.lastTwap;
  const chg = v.oracle.lastTwap > 0 ? twapNow / v.oracle.lastTwap - 1 : 0;
  const marketShare: ShareTarget = {
    title: `$${ticker} · UP ${lev(v.side[0].leverage)} · DOWN ${lev(v.side[1].leverage)}`,
    text: `$${ticker}: UP pays ${lev(v.side[0].leverage)}, DOWN pays ${lev(v.side[1].leverage)}. No liquidations. Somebody's wrong.`,
    url: currentShare(publicKey),
    image: `/api/og?m=${key}`,
    filename: `${ticker}-100x.png`,
  };
  // the market list for the pills: the snapshot, with this page's fresher view swapped in
  const all = others.data ? [...others.data.filter((o) => !o.acct.key.equals(v.acct.key)), v] : [v];
  const statsState = stats.data ? "ok" : stats.loading ? "loading" : "error";
  return (
    <>
      <h1 className="sr-only">
        ${ticker} / {v.oracle.quote}: UP or DOWN, no liquidations
      </h1>
      <div className="tstrip mkt-strip">
        <MarketBar v={v} ticker={ticker} image={under?.image} stat={stats.data?.get(key)}>
          <span className="mbar-actions">
            <PinButton v={v} ticker={ticker} />
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
        </MarketBar>
        <MarketPills current={v} all={all} stats={stats.data} statsState={statsState} sort={sort} onSort={setSort} />
      </div>

      <div className="tgrid mkt-tgrid">
        <MarketTraders v={v} feed={feed.data} feedLoading={feed.loading} feedError={feed.error} ticker={ticker} />
        <div className="tcard tchart-card mkt-chart">
          <TermChart v={v} ticker={ticker} fmt={(p) => px.oracleFmt(p, v.oracle.quote, ticker)} events={feed.data} wins={wins.data?.wins} />
          <div className="tchart-foot">
            <span className="meta">
              {v.side[0].vault + v.side[1].vault === 0n ? (
                <>Pots empty: the first buy on either side sets the odds.</>
              ) : Math.abs(chg) < 5e-6 || !v.pending || v.pending.amount === 0n ? (
                <>Pots square since the last settle.</>
              ) : (
                <>
                  <b className={v.pending.payer === 0 ? "up" : "down"}>{SIDE[v.pending.payer]}</b> owes <b className="num">{pct(1 - v.pending.keep, 1)}</b> of its pot ·{" "}
                  <Flash watch={v.pending.amount.toString()} as="b" className="num">
                    {usd(px.quoteUsd(v.pending.amount))}
                  </Flash>{" "}
                  moves on the next tx
                </>
              )}
              {" · "}
              {movesHour ? <Flash watch={movesHour}>{movesHour} moves · 1h</Flash> : `observed ${ago(v.oracle.updatedTs)}`}
            </span>
            <Tweet
              text={`$${ticker} ${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(3)}% since last settle · UP pays ${lev(v.side[0].leverage)}, DOWN pays ${lev(v.side[1].leverage)}`}
              path={`/m/${key}`}
            />
          </div>
        </div>
        <div className="tcol mkt-side">
          <ProviderTrade view={v} onDone={refresh}>
            <Ticket v={v} ticker={ticker} bal={bal.data ?? null} pool={pool.data ?? null} vault={vault} onDone={refresh} />
          </ProviderTrade>
          <PnlCard />
          <HouseRules ticker={ticker} rulesHref="#rules" />
        </div>
        <BottomTabs v={v} ticker={ticker} bal={bal.data ?? null} feed={feed.data} feedLoading={feed.loading} feedError={feed.error} onShare={setShare} />
      </div>

      <section className="under-hood" aria-label="Under the hood">
        <h2 className="lb-sub">Under the hood</h2>
        <div className="hood-grid">
          <div className="hood-col">
            <section className="panel" id="rules">
              <h2 className="meta">
                <Anchor id="rules" />
                The rules
              </h2>
              <dl className="rules">
                <div>
                  <dt>Every twitch</dt>
                  <dd>
                    Loser's pot pays the winner. <span className="num">1% ≈ 63%</span> of it.
                  </dd>
                </div>
                <div>
                  <dt>Every transfer</dt>
                  <dd>Buy, sell or send settles it.</dd>
                </div>
                <div>
                  <dt>Fees</dt>
                  <dd>4% in, 4% out. 30% burns $100XBRO.</dd>
                </div>
                <div>
                  <dt>Out</dt>
                  <dd>
                    Curve or pot, minus {pct(REDEEM_FEE, 0)}. 20% of gain backs the{" "}
                    <a href={RAISE_URL} target="_blank" rel="noopener noreferrer">
                      raise
                    </a>
                    .
                  </dd>
                </div>
                <div>
                  <dt>Market</dt>
                  <dd className="addr">{key}</dd>
                </div>
              </dl>
            </section>
            <VaultPanel v={v} onDone={refresh} ticker={ticker} />
          </div>
          <div className="hood-col">
            <PumpPair v={v} ticker={ticker} onDone={refresh} />
            <KeeperPanel v={v} onDone={refresh} ticker={ticker} />
            <BurnPanel />
          </div>
        </div>
      </section>
      {share && <ShareSheet target={share} onClose={() => setShare(null)} />}
    </>
  );
}

function ClosedMarket({ marketKey, active }: { marketKey: PublicKey; active: MarketView[] }) {
  const key = marketKey.toBase58();
  const activeKeys = active.map((v) => v.acct.key.toBase58()).join(",");
  const replacement = usePoll(() => replacementMarket(conn, marketKey, active), [key, activeKeys], 60_000);
  const current = replacement.data;
  return (
    <>
      <section className="panel" style={{ padding: 24 }}>
        <h1>Existing market · program closed</h1>
        <p>{LEGACY_UNAVAILABLE}</p>
        {current && <p><Link className="btn signal" to={`/m/${current.acct.key.toBase58()}`}>Open the new ${current.ticker} market →</Link></p>}
        <p><Link to="/me">View existing holdings</Link> · <Link to="/">Open the current board</Link></p>
      </section>
      <section className="panel" style={{ padding: 24 }}><h2>Market history</h2><Feed market={key} /></section>
    </>
  );
}

/** One choice row: Long (UP) · Short (DOWN) · Yield (the market's delta-neutral vault, if it has one). The choice lives in ?side=0|1|yield. */
function Ticket({
  v,
  ticker,
  bal,
  pool,
  vault,
  onDone,
}: {
  v: MarketView;
  ticker: string;
  bal: Balances | null;
  pool: PoolState | null;
  vault: MarketVault;
  onDone: () => void;
}) {
  const q = useQuery();
  const px = usePrices();
  const blocker = yieldBlocker(vault, v.oracle.quote, ticker);
  const apy = vault.row ? yieldApy(vault.row) : null;
  const vcoin = useVaultCoin(vault, v.acct.key, ticker);
  const off = !!blocker || (vault.loading && !vault.row);
  const want = q.get("side");
  // a blocked Yield falls back to Long rather than showing an empty pane (and comes back by itself when the vault shows up)
  const choice: 0 | 1 | "yield" = want === "yield" && !blocker ? "yield" : want === "1" ? 1 : 0;
  const twap = v.oracle.twap ?? v.oracle.lastTwap;
  // links to the old #dn panel land on the Yield option
  useEffect(() => {
    if (window.location.hash !== "#dn") return;
    q.set({ side: "yield" });
    document.getElementById("trade")?.scrollIntoView({ block: "start" });
  }, []);
  return (
    <section className="tcard ticket tk" aria-label="Trade ticket" id="trade">
      <header className="tk-head">
        <h2>Market</h2>
        <Flash watch={twap} className="num tk-mark">
          {px.oracleFmt(twap, v.oracle.quote, ticker)}
        </Flash>
      </header>
      <div className="tk-choice" role="group" aria-label="Long, short or yield">
        {([0, 1] as const).map((i) => (
          <button key={i} className={`tk-opt ${i === 0 ? "u" : "d"}`} aria-pressed={choice === i} onClick={() => q.set({ side: i })}>
            <span>
              {i === 0 ? "Long" : "Short"} <small>{SIDE[i]}</small>
            </span>
            <Flash watch={v.side[i].leverage} as="b" className="num">
              {lev(v.side[i].leverage)}
            </Flash>
          </button>
        ))}
        <button
          className="tk-opt y"
          aria-pressed={choice === "yield"}
          aria-disabled={off}
          title={blocker?.full ?? "Park SOL in this market's delta-neutral vault: LP the pool, hedge with DOWN, keep the fees."}
          onClick={() => !off && q.set({ side: "yield" })}
        >
          <span>
            Yield <small>{blocker ? blocker.short : vault.row ? (vcoin.own ? "no direction" : `${vcoin.coin}/SOL LP`) : "checking…"}</small>
          </span>
          <b className="num">{apy === null || apy <= 0 ? "—" : apy >= 99.99 ? ">9,999%" : pct0(apy)}</b>
        </button>
      </div>
      {choice === "yield" ? <YieldPane vault={vault} market={v.acct.key} ticker={ticker} onDone={onDone} /> : <TradeBody v={v} ticker={ticker} bal={bal} pool={pool} side={choice} onDone={onDone} />}
    </section>
  );
}

function TradeBody({
  v,
  ticker,
  bal,
  pool,
  side,
  onDone,
}: {
  v: MarketView;
  ticker: string;
  bal: Balances | null;
  pool: PoolState | null;
  side: 0 | 1;
  onDone: () => void;
}) {
  const q = useQuery();
  const tabParam = q.get("tab");
  const tab: Tab = tabParam === "sell" || tabParam === "redeem" ? tabParam : "buy";
  const setTab = (t: Tab) => q.set({ tab: t === "buy" ? null : t, amt: null });
  const unit = "SOL" as const;
  const [input, setInputRaw] = useState(() => q.get("amt") ?? "");
  const setInput = (v: string) => {
    setInputRaw(v);
    q.set({ amt: v || null });
  };
  // sell / cash-out quote for the chosen side; buys are quoted for BOTH sides so either big button can fire at once
  const [quote, setQuote] = useState<Q | null>(null);
  const [buyQ, setBuyQ] = useState<[Q | null, Q | null]>([null, null]);
  const [curveCap, setCurveCap] = useState<bigint | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<0 | 1 | null>(null);
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

  // pot quotes live in lib/exit.ts (shared with the bag page)
  const potQuote = (n: bigint) => potQuoteFor(v, side, n);

  // live quote: SOL -> r-fstacc (stake pool) -> curve (both sides), or curve/pot -> r-fstacc -> SOL
  useEffect(() => {
    setQuote(null);
    setBuyQ([null, null]);
    setQuoteErr(null);
    if (!raw || raw <= 0n) return;
    if (!pool) return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        if (tab === "buy") {
          const lst = depositOut(pool, raw);
          const both = await Promise.allSettled(
            ([0, 1] as const).map(async (sd) => {
              const cq = await curveQuoteFor(v, sd, lst, false);
              // what the curve would pay to sell those tokens straight back (the honest "flat" number for small bags)
              return { ...cq, back: sellBackEstimate(v, sd, cq.out, lst) };
            }),
          );
          const out = both.map((r) => (r.status === "fulfilled" ? r.value : null)) as [Q | null, Q | null];
          if (!alive) return;
          setBuyQ(out);
          if (!out[0] && !out[1]) setQuoteErr(both[0].status === "rejected" && both[0].reason instanceof Error ? both[0].reason.message : "quote failed");
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
  }, [raw?.toString(), tab, side, v.side[0].vault, v.side[1].vault, s.circulating, a.pool.toBase58(), !!pool, v.pending?.amount, curveCap?.toString()]);

  const quoteFor = (sd: 0 | 1) => (tab === "buy" ? buyQ[sd] : sd === side ? quote : null);
  const overCapacity = solOut && quote ? quote.out > capacity : false;
  const blocked = !publicKey || !raw || raw <= 0n || tooMuch || invalid || busy !== null || !pool;
  const disabledFor = (sd: 0 | 1) => blocked || !quoteFor(sd) || (solOut && (sd !== side || overCapacity));

  async function submit(sd: 0 | 1) {
    const quote = quoteFor(sd);
    if (!raw || !quote) return;
    const s = v.side[sd];
    const a = sideAccounts(v.keys, sd);
    setBusy(sd);
    const label = `${tab === "buy" ? "Ape" : tab === "sell" ? "Exit" : "Cash out"} ${SIDE[sd]}`;
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
          const b = basisByPosition(await fetchFeed(undefined, me, 200), me).get(`${v.acct.key.toBase58()}:${sd}`);
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
        const r = redeemIxs(v, sd, raw, payer, solOut ? pool : null);
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
        return toV0([...ixs, ...tx.instructions, claimFeesIx(v.keys, sd)], payer);
      }
      const plan = quote.plan ?? { sell: raw, redeem: 0n, sellMin: quote.min, redeemMin: 0n, sellOut: 0n, redeemOut: 0n };
      return withShare(await exitIxs(v, sd, plan, payer, solOut ? pool : null), plan.sellMin + plan.redeemMin);
    });
    setBusy(null);
    if (sig) {
      setInput("");
      if (tab === "buy" && sd !== side) q.set({ side: sd });
      onDone();
      if (tab === "buy") confetti(sd);
    }
  }

  const setFrac = (f: number) => {
    if (!have) return;
    const x = (have * BigInt(Math.round(f * 1000))) / 1000n;
    setInput(fmtAmount(x, inDecimals, inDecimals).replace(/,/g, ""));
  };
  const inUsd = raw && raw > 0n && !invalid ? (tab === "buy" ? px.lamportsUsd(raw) : px.priceUsd((Number(raw) / 10 ** s.decimals) * s.nav)) : null;

  return (
    <div className="ticket-body tk-body">
      <div className="tk-tabs" role="tablist">
        {(["buy", "sell", "redeem"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === "redeem" ? "Cash out" : t === "buy" ? "Ape" : "Sell"}
          </button>
        ))}
        <span className="tab-help">{tab === "buy" ? "SOL in → your side's pot slice" : tab === "sell" ? `curve or pot, whichever pays` : "your pot slice, minus 4%"}</span>
      </div>
      <div className="tk-pay">
        <div className="tk-pay-row">
          <label htmlFor="amt">{tab === "buy" ? "You're paying" : `You're ${tab === "sell" ? "selling" : "cashing out"}`}</label>
          <span className="tk-fracs">
            {(tab === "buy" ? [0.25, 0.5, 1] : [0.25, 0.5, 1]).map((f) => (
              <button key={f} type="button" disabled={!have || busy !== null} onClick={() => setFrac(f)}>
                {f === 1 ? "Max" : f === 0.5 ? "Half" : "25%"}
              </button>
            ))}
            <span className="num tk-bal" title="Your balance">
              ◫ {have === null ? "—" : fmtAmount(have, inDecimals, tab === "buy" ? 4 : 2)}
            </span>
          </span>
        </div>
        <div className="tk-input" data-invalid={invalid || tooMuch}>
          <span className={`tk-tok ${tab === "buy" ? "" : side === 0 ? "up" : "down"}`}>{tab === "buy" ? "◎ SOL" : s.symbol}</span>
          <span className="tk-amt">
            <input
              id="amt"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy !== null}
              aria-invalid={invalid || tooMuch}
            />
            <span className="num muted">{inUsd !== null ? usd(inUsd) : "$0.00"}</span>
          </span>
        </div>
        {tab === "buy" && (
          <div className="tk-quick">
            {[0.01, 0.05, 0.1].map((x) => (
              // absolute amounts for a first trade: a burner with $10 in it should be one tap from "in"
              <button key={x} type="button" className="chip" disabled={busy !== null} onClick={() => setInput(String(x))}>
                {x} SOL
              </button>
            ))}
          </div>
        )}
        {tab === "sell" && curveCap !== null && <span className="meta tk-note num">curve takes {fmtAmount(curveCap, s.decimals, 0)} · the rest goes to the pot</span>}
        {invalid && <span className="err">Enter a number with at most {inDecimals} decimals.</span>}
        {tooMuch && <span className="err">{tab === "buy" ? "Not enough SOL. Keep some for fees and account rent." : "More than you hold."}</span>}
        {!publicKey && <span className="tk-note meta">Connect a wallet or grab a burner to trade.</span>}
      </div>

      <LevNow v={v} side={side} />

      {tab === "buy" ? (
        <div className="big-sides">
          {([0, 1] as const).map((sd) => (
            <button key={sd} type="button" className={`bigside ${sd === 0 ? "up" : "down"} ${sd === side ? "pref" : ""}`} disabled={disabledFor(sd)} data-loading={busy === sd} onClick={() => submit(sd)}>
              {SIDE[sd]} <span className="num">{lev(v.side[sd].leverage)}</span>
            </button>
          ))}
        </div>
      ) : (
        <button type="button" className={`bigside wide ${side === 0 ? "up" : "down"}`} disabled={disabledFor(side)} data-loading={busy === side} onClick={() => submit(side)}>
          {tab === "sell" ? "Sell" : "Cash out"} {SIDE[side]}
        </button>
      )}
      {!publicKey && (
        <div className="tk-connect">
          <WalletButton solo />
        </div>
      )}
      <p className="fineprint">
        {tab === "buy"
          ? "SOL stakes to r-freestacc and buys your side's curve in the same transaction. 4% in, 4% out, 1% slippage limit. No liquidations: you leave when you want."
          : "Paid out in SOL in the same transaction. 20% of any gain backs the raise (0/20)."}
      </p>

      <div className="quote est-box" aria-live="polite">
        {tab === "buy" ? (
          <BuyEstimates v={v} ticker={ticker} pool={pool} quotes={buyQ} raw={raw} side={side} />
        ) : (
          <>
            <div className="panel-row">
              <span className="muted">You receive (at least)</span>
              <span className="num">
                {quote ? `${fmtAmount(quote.out, 9)} SOL` : quoteErr ? "—" : raw ? "…" : "—"}
                {quote && <span className="muted"> ≈ {usd(px.lamportsUsd(quote.out))}</span>}
              </span>
            </div>
            {tab === "sell" ? (
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
                Payout now <span className="num">(their pot ÷ yours × 100)</span>
              </span>
              <Flash watch={s.leverage} className={`num ${side === 0 ? "up" : "down"}`}>
                {Number.isNaN(s.leverage) ? "— pots empty" : lev(s.leverage)}
              </Flash>
            </div>
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
            <div className="panel-row">
              <span className="muted">Payout token</span>
              <span className="num">SOL</span>
            </div>
          </>
        )}
        {quoteErr && <span className="err">{quoteErr}</span>}
        {overCapacity && <span className="err">That's more SOL than can be released right now — try a smaller amount.</span>}
      </div>
    </div>
  );
}

/** "Leverage right now": both payouts, how lopsided the pots are, and what a 0.1% move does to the side you're looking at. */
function LevNow({ v, side }: { v: MarketView; side: 0 | 1 }) {
  const q = useQuery();
  const px = usePrices();
  const total = v.side[0].vault + v.side[1].vault;
  const upShare = total > 0n ? Number(v.side[0].vault) / Number(total) : 0.5;
  const s = v.side[side];
  return (
    <div className="levnow tk-lev">
      <span className="meta">Leverage right now</span>
      <div className="levnow-sides">
        {([0, 1] as const).map((i) => (
          <button key={i} type="button" className={`levnow-side ${i === 0 ? "up" : "down"} ${i === side ? "thin" : ""}`} aria-pressed={i === side} onClick={() => q.set({ side: i })}>
            <span className="meta">{SIDE[i]}</span>
            <Flash watch={v.side[i].leverage} as="b" className="num">
              {lev(v.side[i].leverage)}
            </Flash>
            <span className="sub num">{usd(px.quoteUsd(v.side[i].vault))} pot</span>
          </button>
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
      <span className="sub">
        {Number.isFinite(s.leverage) && s.leverage > 0 ? (
          <>
            A 0.1% move: <span className="up num">+{pct(Math.min(((1 - Math.pow(1.0001, -1000)) * s.leverage) / 100, 99), 0)}</span> your way ·{" "}
            <span className="down num">−9.5%</span> not
          </>
        ) : total === 0n ? (
          "Both pots empty: the first buy on either side sets the odds."
        ) : (
          `${SIDE[side]} pays without limit while its pot is empty: the first buyer there takes the other pot's moves.`
        )}
      </span>
    </div>
  );
}

/** The estimates box for a buy, one column per side (the way the two big buttons read): what you get and what it becomes. */
function BuyEstimates({ v, ticker, pool, quotes, raw, side }: { v: MarketView; ticker: string; pool: PoolState | null; quotes: [Q | null, Q | null]; raw: bigint | null; side: 0 | 1 }) {
  const px = usePrices();
  const live = !!raw && raw > 0n;
  const cell = (sd: 0 | 1, f: (q: Q) => ReactNode) => {
    const q = quotes[sd];
    return <td className={`num ${sd === side ? "pref" : ""}`}>{q ? f(q) : live ? "…" : "—"}</td>;
  };
  const sol = (lam: bigint) => `${fmtAmount(lam, 9, 4)}`;
  const at = (sd: 0 | 1, m: number) => (q: Q) => (pool ? sol(whatIf(v, sd, q.out, sd === 0 ? m : -m, pool)) : "—");
  return (
    <table className="est-table">
      <thead>
        <tr>
          <th />
          <th className={`up ${side === 0 ? "pref" : ""}`}>UP</th>
          <th className={`down ${side === 1 ? "pref" : ""}`}>DOWN</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <th>Pays if right</th>
          {([0, 1] as const).map((sd) => (
            <td key={sd} className={`num ${sd === 0 ? "up" : "down"} ${sd === side ? "pref" : ""}`}>
              {lev(v.side[sd].leverage)}
            </td>
          ))}
        </tr>
        <tr>
          <th>You get</th>
          {([0, 1] as const).map((sd) => (
            <Fragment key={sd}>{cell(sd, (q) => `${fmtAmount(q.out, v.side[sd].decimals, 0)} ${v.side[sd].symbol}`)}</Fragment>
          ))}
        </tr>
        <tr>
          <th>If ${ticker} +1%</th>
          {([0, 1] as const).map((sd) => (
            <Fragment key={sd}>{cell(sd, at(sd, 0.01))}</Fragment>
          ))}
        </tr>
        <tr>
          <th>Flat</th>
          {([0, 1] as const).map((sd) => (
            <Fragment key={sd}>{cell(sd, at(sd, 0))}</Fragment>
          ))}
        </tr>
        <tr>
          <th>If ${ticker} −1%</th>
          {([0, 1] as const).map((sd) => (
            <Fragment key={sd}>{cell(sd, at(sd, -0.01))}</Fragment>
          ))}
        </tr>
        <tr>
          <th>Sell back now</th>
          {([0, 1] as const).map((sd) => (
            <Fragment key={sd}>{cell(sd, (q) => (pool && q.back !== undefined ? sol(withdrawOut(pool, q.back)) : "—"))}</Fragment>
          ))}
        </tr>
        <tr>
          <th title="How much of its curve price a side still owes the other pot. Above ~10%, a fresh buy there is settled away fast.">Owes</th>
          {([0, 1] as const).map((sd) => (
            <td key={sd} className={`num ${v.side[sd].owed > 0.1 ? "warn-ink" : ""} ${sd === side ? "pref" : ""}`}>
              {v.side[sd].owed > 1e-6 ? pct(v.side[sd].owed, 1) : "nothing"}
            </td>
          ))}
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <th>Cash-outs in SOL · fees 4.1% · slippage limit 1%</th>
          <td colSpan={2} className="num">
            {live && px.lamportsUsd(raw!) !== null ? `you pay ${usd(px.lamportsUsd(raw!))}` : ""}
          </td>
        </tr>
        {([0, 1] as const)
          .filter((sd) => v.side[sd].owed > 0.01)
          .map((sd) => (
            <tr key={sd}>
              <td colSpan={3}>
                <p className="warn" role="note">
                  {SIDE[sd]} owes <b className="num">{pct(v.side[sd].owed, 0)}</b> to {SIDE[1 - sd]}. Next trade collects it{v.side[sd].owed > 0.1 ? ": a buy there now is mostly settled away." : "."}
                </p>
              </td>
            </tr>
          ))}
      </tfoot>
    </table>
  );
}

type LeftTab = "size" | "up" | "down" | "live";
/** The left rail: who holds this market (both sides by value, or one side), and every move as it lands. */
function MarketTraders({ v, feed, feedLoading, feedError, ticker }: { v: MarketView; feed: Ev[] | undefined; feedLoading: boolean; feedError: string | null; ticker: string }) {
  const [tab, setTab] = useState<LeftTab>("size");
  const px = usePrices();
  const key = v.acct.key.toBase58();
  const board = usePoll(() => fetchLeaders(key), [key], 30_000);
  let rows: TRow[] | undefined;
  if (tab === "live") rows = feed?.map((e) => eventRow(e, px.quoteUsd, false)).filter((r): r is TRow => !!r);
  else if (board.data) {
    const sides = tab === "up" ? [0] : tab === "down" ? [1] : [0, 1];
    rows = sides
      .flatMap((sd) => board.data!.sides[sd].map((h) => ({ h, sd: sd as 0 | 1 })))
      .sort((a, b) => (b.h.valueUsd ?? 0) - (a.h.valueUsd ?? 0))
      .slice(0, 30)
      .map(({ h, sd }) => ({
        id: `${h.owner}:${sd}`,
        wallet: h.owner,
        title: short(h.owner),
        sub: `${SIDE[sd]} · pays ${lev(v.side[sd].leverage)}`,
        tone: sd === 0 ? "up" : "down",
        value: usd(h.valueUsd),
        valueSub: `${(h.share * 100).toFixed(1)}% of ${SIDE[sd]}`,
        to: `/p/${h.owner}`,
      }));
  }
  const top = board.data?.sides[0][0] ?? board.data?.sides[1][0];
  return (
    <TraderList<LeftTab>
      tabs={[
        { id: "size", label: "Top bags" },
        { id: "up", label: "UP" },
        { id: "down", label: "DOWN" },
        { id: "live", label: "Live" },
      ]}
      tab={tab}
      onTab={setTab}
      rows={rows}
      loading={tab === "live" ? feedLoading : board.loading}
      error={tab === "live" ? feedError : board.error}
      ranked={tab !== "live"}
      empty={
        tab === "live" ? (
          "Crickets. First move gets the cheapest side."
        ) : tab === "size" ? (
          <>Nobody's in yet. Both sides are open.</>
        ) : (
          <>
            {tab === "up" ? "UP" : "DOWN"} is empty · pays {lev(v.side[tab === "up" ? 0 : 1].leverage)} unclaimed.
          </>
        )
      }
      footer={
        <span className="tlist-foot-row">
          <Link to="/winners" className="more">
            Leaderboard →
          </Link>
          <Tweet
            text={
              top
                ? `Biggest bags on $${ticker}: UP pays ${lev(v.side[0].leverage)}, DOWN pays ${lev(v.side[1].leverage)}. Come outsize them.`
                : `$${ticker} is empty · UP pays ${lev(v.side[0].leverage)}, DOWN pays ${lev(v.side[1].leverage)} · nobody's claimed it`
            }
            path={`/m/${key}`}
          />
        </span>
      }
    />
  );
}

type Pane = "positions" | "history" | "trades";
/** Under the chart: your positions here, your closed trades and activity, and every trade on this market. ?pane= keeps the tab. */
function BottomTabs({
  v,
  ticker,
  bal,
  feed,
  feedLoading,
  feedError,
  onShare,
}: {
  v: MarketView;
  ticker: string;
  bal: Balances | null;
  feed: Ev[] | undefined;
  feedLoading: boolean;
  feedError: string | null;
  onShare: (t: ShareTarget) => void;
}) {
  const q = useQuery();
  const pane: Pane = q.get("pane") === "history" ? "history" : q.get("pane") === "trades" ? "trades" : "positions";
  const [hist, setHist] = useState<"closed" | "activity">("closed");
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const mine = usePoll(() => (me ? fetchFeed(undefined, me, 200) : Promise.resolve(null)), [me], 20_000);
  const key = v.acct.key.toBase58();
  const held = bal ? [bal.up, bal.down].filter((x) => x > 0n).length : 0;
  return (
    <section className="tcard btabs" aria-label="Positions and trades">
      <div className="btabs-bar" role="tablist">
        {(
          [
            ["positions", `Positions (${held})`],
            ["history", "History"],
            ["trades", "All trades"],
          ] as [Pane, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={pane === id} onClick={() => q.set({ pane: id === "positions" ? null : id })}>
            {label}
          </button>
        ))}
        <Link to="/me" className="more btabs-more">
          Full bag →
        </Link>
      </div>
      {pane === "positions" && <Positions v={v} ticker={ticker} bal={bal} mine={mine.data ?? null} onShare={onShare} />}
      {pane === "history" && (
        <>
          <div className="seg-mini btabs-sub" role="tablist" aria-label="History">
            <button role="tab" aria-selected={hist === "closed"} onClick={() => setHist("closed")}>
              Closed positions
            </button>
            <button role="tab" aria-selected={hist === "activity"} onClick={() => setHist("activity")}>
              Activity
            </button>
          </div>
          {!me ? (
            <Empty icon="↺" text="Connect a wallet to see your trades on this market." action={<WalletButton solo />} />
          ) : mine.loading && !mine.data ? (
            <span className="skeleton" style={{ height: 96 }} />
          ) : !mine.data ? (
            <Empty icon="!" text={`Your history didn't load${mine.error ? `: ${mine.error}` : ""}. Retrying.`} />
          ) : hist === "closed" ? (
            <Closed evs={mine.data.filter((e) => e.market === key)} me={me} ticker={ticker} />
          ) : (
            <Activity evs={mine.data.filter((e) => e.market === key && e.actor === me)} ticker={ticker} />
          )}
        </>
      )}
      {pane === "trades" && <AllTrades evs={feed} loading={feedLoading} error={feedError} ticker={ticker} />}
    </section>
  );
}

function Empty({ icon, text, action }: { icon: string; text: ReactNode; action?: ReactNode }) {
  return (
    <div className="btabs-empty">
      <span className="btabs-icon" aria-hidden>
        {icon}
      </span>
      <p>{text}</p>
      {action}
    </div>
  );
}

/** Your UP and DOWN here: what each is worth at the curve and at the pot, the share of its side, unrealized PnL, and the doors out. */
function Positions({ v, ticker, bal, mine, onShare }: { v: MarketView; ticker: string; bal: Balances | null; mine: Ev[] | null; onShare: (t: ShareTarget) => void }) {
  const { publicKey } = useWallet();
  const px = usePrices();
  const q = useQuery();
  if (!publicKey) return <Empty icon="◎" text={`Your positions on $${ticker} show here.`} action={<WalletButton solo />} />;
  if (!bal) return <span className="skeleton" style={{ height: 72 }} />;
  const owner = publicKey.toBase58();
  const key = v.acct.key.toBase58();
  const rows = ([0, 1] as const).map((i) => ({ i, amt: i === 0 ? bal.up : bal.down })).filter((r) => r.amt > 0n);
  if (!rows.length)
    return (
      <Empty
        icon="⌁"
        text={
          <>
            Spectating. Your positions on ${ticker} show here. Dry powder <b className="num">{fmtAmount(bal.sol, 9, 4)} SOL</b>.
          </>
        }
      />
    );
  const basis = mine ? basisByPosition(mine, owner) : null;
  const now = Math.floor(Date.now() / 1000);
  const go = (side: 0 | 1, tab: Tab) => {
    q.set({ side, tab });
    document.getElementById("trade")?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const positionShare = (i: 0 | 1, amt: bigint): ShareTarget => {
    const s = v.side[i];
    const units = Number(amt) / 10 ** s.decimals;
    return {
      title: `${SIDE[i]} ${lev(s.leverage)} on $${ticker}`,
      text: `I'm ${SIDE[i]} on $${ticker}. ${lev(s.leverage)} payout if it ${i === 0 ? "pumps" : "dumps"}, ${usd(px.priceUsd(units * s.curvePrice))} on the line, zero chance of liquidation. Come take it.`,
      url: currentShare(publicKey).replace(/([?&])side=\d/, `$1side=${i}`),
      image: `/api/og?m=${key}&side=${i}&owner=${owner}`,
      filename: `${ticker}-${SIDE[i]}-100x.png`,
    };
  };
  return (
    <div className="lb-scroll">
      <table className="lb-table bt-table">
        <thead>
          <tr>
            <th>Position</th>
            <th className="num">Value at pot</th>
            <th className="num">At curve</th>
            <th className="num">PnL</th>
            <th className="num">Share of side</th>
            <th className="num">Pays now</th>
            <th>Status</th>
            <th aria-label="actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ i, amt }) => {
            const s = v.side[i];
            const units = Number(amt) / 10 ** s.decimals;
            const potQ = units * s.nav * (1 - REDEEM_FEE);
            const curveQ = s.atFloor ? 0 : Math.min(units * s.curvePrice, Number(s.reserve) / 1e9);
            const pnl = positionPnl(basis?.get(`${key}:${i}`), units, potQ, now);
            const share = s.circulating > 0n ? Number(amt) / Number(s.circulating) : 0;
            return (
              <tr key={i}>
                <td>
                  <span className={`bt-pos ${i === 0 ? "up" : "down"}`}>
                    <b>{SIDE[i]}</b> ${ticker} <span className="muted num">{fmtAmount(amt, s.decimals, 2)}</span>
                  </span>
                </td>
                <td className="num">{usd(px.priceUsd(potQ))}</td>
                <td className="num">{s.atFloor ? "nothing" : usd(px.priceUsd(curveQ))}</td>
                <td className={`num ${pnl ? (pnl.unrealized >= 0 ? "up" : "down") : ""}`}>
                  {pnl ? (
                    <>
                      {pnl.unrealized >= 0 ? "+" : "−"}
                      {usd(Math.abs(px.priceUsd(pnl.unrealized) ?? 0))}
                      <span className="sub">{pnl.cost > 0 ? `${pnl.ret >= 0 ? "+" : ""}${(pnl.ret * 100).toFixed(1)}%` : ""}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="num">{(share * 100).toFixed(1)}%</td>
                <td className={`num ${i === 0 ? "up" : "down"}`}>{lev(s.leverage)}</td>
                <td>{s.owed > 0.1 ? <span className="warn-ink">owes {pct(s.owed, 0)}</span> : s.owed > 1e-6 ? `owes ${pct(s.owed, 1)}` : "square"}</td>
                <td className="bt-actions">
                  <button className="chip" onClick={() => go(i, "sell")}>
                    Sell
                  </button>
                  <button className="chip" onClick={() => go(i, "redeem")}>
                    Cash out
                  </button>
                  <button className="chip" onClick={() => onShare(positionShare(i, amt))}>
                    Flex
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Your sells and cash-outs here, average cost basis: what each one paid and what it realized. */
function Closed({ evs, me, ticker }: { evs: Ev[]; me: string; ticker: string }) {
  const px = usePrices();
  const rows: { e: Ev; realized: number; cost: number }[] = [];
  const pos = new Map<number, { q: number; t: number }>();
  for (const e of [...evs].sort((a, b) => a.ts - b.ts)) {
    if (e.actor !== me || e.side === undefined) continue;
    if (e.kind !== "buy" && e.kind !== "sell" && e.kind !== "redeem") continue;
    const p = pos.get(e.side) ?? { q: 0, t: 0 };
    const qq = Number(e.quote ?? 0) / 1e9;
    const t = e.tokens ?? 0;
    if (e.kind === "buy") {
      p.q += qq;
      p.t += t;
    } else {
      const cost = p.t > 0 ? Math.min(p.q, (p.q / p.t) * t) : 0;
      p.q -= cost;
      p.t = Math.max(0, p.t - t);
      rows.push({ e, realized: qq - cost, cost });
    }
    pos.set(e.side, p);
  }
  if (!rows.length) return <Empty icon="↺" text={`No closed trades on $${ticker} yet. They show here once you sell or cash out.`} />;
  return (
    <div className="lb-scroll">
      <table className="lb-table bt-table">
        <thead>
          <tr>
            <th>Position</th>
            <th className="num">Size</th>
            <th className="num">Paid out</th>
            <th className="num">Cost</th>
            <th className="num">Realized PnL</th>
            <th aria-label="transaction" />
          </tr>
        </thead>
        <tbody>
          {rows.reverse().map(({ e, realized, cost }) => (
            <tr key={e.sig}>
              <td>
                <span className={`bt-pos ${e.side === 0 ? "up" : "down"}`}>
                  <b>{SIDE[e.side!]}</b> ${ticker} · {e.kind === "redeem" ? "cashed out" : "sold"}
                </span>
                <span className="sub">{new Date(e.ts * 1000).toLocaleString()}</span>
              </td>
              <td className="num">{(e.tokens ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
              <td className="num">{px.quoteSol(BigInt(e.quote ?? 0))?.toFixed(4) ?? "—"} SOL</td>
              <td className="num">{px.rate ? (cost * px.rate).toFixed(4) : "—"} SOL</td>
              <td className={`num ${realized >= 0 ? "up" : "down"}`}>
                {px.rate ? `${realized >= 0 ? "+" : "−"}${Math.abs(realized * px.rate).toFixed(4)} SOL` : "—"}
                <span className="sub">{cost > 0 ? `${realized >= 0 ? "+" : ""}${((realized / cost) * 100).toFixed(1)}%` : "no basis"}</span>
              </td>
              <td>
                <a className="tx-link" href={explorer(e.sig)} target="_blank" rel="noreferrer" aria-label="View transaction">
                  ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ACTION: Record<Ev["kind"], string> = { buy: "Opened", sell: "Sold", redeem: "Cashed out", settle: "Settled", claim: "Tips swept", rebalance: "Pot payout", listed: "Listed", burn: "Burned" };

/** Your moves here, newest first. */
function Activity({ evs, ticker }: { evs: Ev[]; ticker: string }) {
  const px = usePrices();
  if (!evs.length) return <Empty icon="↺" text={`No moves on $${ticker} from this wallet yet.`} />;
  return (
    <ol className="bt-activity">
      {evs.map((e) => (
        <li key={e.sig}>
          <span>
            <b>
              ${ticker} · {ACTION[e.kind]}
              {e.side !== undefined && <span className={e.side === 0 ? "up" : "down"}> {SIDE[e.side]}</span>}
            </b>
            <span className="sub">
              {new Date(e.ts * 1000).toLocaleString()} ·{" "}
              <a href={explorer(e.sig)} target="_blank" rel="noreferrer" className="num">
                {short(e.sig)} ↗
              </a>
            </span>
          </span>
          <span className="num">{e.quote ? `${px.quoteSol(BigInt(e.quote))?.toFixed(4) ?? "—"} SOL` : ""}</span>
        </li>
      ))}
    </ol>
  );
}

/** Every trade on this market from the feed: who, what, how big, at what price per token, when. */
function AllTrades({ evs, loading, error, ticker }: { evs: Ev[] | undefined; loading: boolean; error: string | null; ticker: string }) {
  const px = usePrices();
  if (loading && !evs) return <span className="skeleton" style={{ height: 120 }} />;
  const rows = (evs ?? []).filter((e) => e.kind !== "burn");
  if (!rows.length) return <Empty icon="⌁" text={error ? "The trade feed is taking a breather. Retrying." : `No trades on $${ticker} yet. First move gets the cheapest side.`} />;
  return (
    <div className="lb-scroll">
      <table className="lb-table bt-table">
        <thead>
          <tr>
            <th>Trade</th>
            <th>Trader</th>
            <th>Action</th>
            <th className="num">Size</th>
            <th className="num">Price / token</th>
            <th className="num">When</th>
            <th aria-label="transaction" />
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => {
            const amt = e.paid && !e.quote ? BigInt(e.paid.amount) : e.quote ? BigInt(e.quote) : null;
            const size = amt !== null ? px.quoteUsd(amt) : null;
            const per = e.quote && e.tokens ? px.priceUsd(Number(e.quote) / 1e9 / e.tokens) : null;
            const side = e.paid && e.kind === "rebalance" ? e.paid.to : e.side;
            return (
              <tr key={e.sig}>
                <td>
                  <span className={`bt-pos ${side === 0 ? "up" : side === 1 ? "down" : ""}`}>
                    {side !== undefined && <b>{SIDE[side]}</b>} ${ticker}
                  </span>
                </td>
                <td>
                  <Link to={`/p/${e.actor}`} className="lb-who num">
                    <Avatar wallet={e.actor} size={20} />
                    {short(e.actor)}
                  </Link>
                </td>
                <td>
                  <span className={`bt-act k-${e.kind}`}>
                    {ACTION[e.kind]}
                    {e.paid && e.kind !== "rebalance" ? ` · ${SIDE[e.paid.from]} paid ${SIDE[e.paid.to]}` : e.paid ? ` · ${SIDE[e.paid.from]} → ${SIDE[e.paid.to]}` : ""}
                  </span>
                </td>
                <td className="num">{size !== null ? usd(size) : "—"}</td>
                <td className="num">{per !== null ? usdPrice(per) : "—"}</td>
                <td className="num">{ago(e.ts)}</td>
                <td>
                  <a className="tx-link" href={explorer(e.sig)} target="_blank" rel="noreferrer" aria-label="View transaction">
                    ↗
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function VaultPanel({ v, onDone, ticker }: { v: MarketView; onDone: () => void; ticker: string }) {
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
      <h2 className="meta" title={`${px.sol(total, 3)} across both pots`}>
        <Anchor id="vaults" />
        Pots · <Flash watch={total.toString()} className="num">{usd(px.quoteUsd(total))}</Flash>
        <span className="right h2-share">
          <Tweet
            text={`$${ticker} pots: ${usd(px.quoteUsd(total))} on the table. UP ${usd(px.quoteUsd(v.side[0].vault))} vs DOWN ${usd(px.quoteUsd(v.side[1].vault))}. Somebody's wrong.`}
            path={`/m/${v.acct.key.toBase58()}`}
          />
        </span>
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
              <b className="num">{usd(px.quoteUsd(unclaimed))}</b> in tips, unswept. Anyone can sweep.
            </>
          ) : (
            "Tips swept. Pots have everything."
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
              <b className="num">{usd(px.quoteUsd(v.pending.amount))}</b>. Any transfer collects.
            </>
          ) : (
            "Pots are square."
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

function KeeperPanel({ v, onDone, ticker }: { v: MarketView; onDone: () => void; ticker: string }) {
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
  const key = v.acct.key.toBase58();
  // the side most in the hole, if any: the real chore on offer
  const debtor = ([0, 1] as const).filter((i) => v.side[i].owed > 1e-6).sort((a, b) => v.side[b].owed - v.side[a].owed)[0];
  return (
    <details className="panel keep" id="keep">
      <summary className="meta" title="Optional, for keepers. Anyone can, nobody's paid, everybody wins.">
        <Anchor id="keep" />
        Chores
        <span className="right h2-share">
          <Tweet
            text={
              debtor !== undefined
                ? `${SIDE[debtor]} owes ${pct(v.side[debtor].owed, 2)} on $${ticker}. Anyone can collect it.`
                : `$${ticker} pots are square. Tip them, deepen the game.`
            }
            path={debtor !== undefined ? `/m/${key}?side=${debtor}` : `/m/${key}`}
          />
        </span>
      </summary>
      <div className="actions">
        {([0, 1] as const).map((i) => (
          <div className="action" key={`s${i}`}>
            <p>
              <span className={i === 0 ? "up" : "down"}>{SIDE[i]}</span> curve{" "}
              <b className="num">{v.side[i].owed > 1e-6 ? `${pct(v.side[i].owed, 2)} in the hole` : "square"}</b>.{" "}
              {v.side[i].owed > 1e-6 && v.side[i].atFloor ? `Collects once ${SIDE[i]} trades above floor.` : `Proceeds land in ${SIDE[1 - i]}'s pot.`}
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
            <p>Tip the pots. SOL, split evenly.</p>
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
    <div aria-busy="true" aria-label="Loading market">
      <div className="tstrip">
        <span className="skeleton" style={{ height: 52, flex: 1 }} />
      </div>
      <div className="tgrid mkt-tgrid">
        <span className="skeleton tlist" style={{ height: 420 }} />
        <span className="skeleton mkt-chart" style={{ height: 520 }} />
        <div className="tcol mkt-side">
          <span className="skeleton" style={{ height: 460 }} />
          <span className="skeleton" style={{ height: 180 }} />
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
