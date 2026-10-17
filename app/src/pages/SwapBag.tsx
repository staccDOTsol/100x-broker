// swap.100x.broker/bag — the bag, brain-dead simple: what your 100× bets are worth in SOL right now, and one button to sell
// each (or all). Same exit router as the main Bag page (curve for what it absorbs, pot for the rest), paid out in SOL when
// the stake pool's reserve covers it. The full Bag lives on 100x.broker.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePoll, useSend } from "../hooks";
import { loadPortfolio, MEME_DECIMALS, positionValue, type Position } from "../lib/portfolio";
import { MEME_SYMBOL } from "../config";
import { exitIxs, planExit } from "../lib/exit";
import { poolState, withdrawCapacity, withdrawOut } from "../lib/zap";
import { toV0 } from "../lib/chain";
import { WalletButton } from "../components/bits";
import { fetchFeed } from "../lib/feed";
import { aggregatePnl, basisByPosition, positionPnl, type Pnl } from "../lib/pnl";

const SIDE = ["UP", "DOWN"] as const;
const sol = (n: number) => (n === 0 ? "0" : n < 0.0001 ? "<0.0001" : n < 1 ? n.toFixed(4) : n.toFixed(3));
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${sol(Math.abs(n))}`;
const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(Math.abs(x) >= 1 ? 0 : 1)}%`;
/** Seconds since `at`, ticking every second (the "live" line). */
function useAgo(at: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return at === null ? null : Math.max(0, Math.round((now - at) / 1000));
}
const units = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(2));

export default function SwapBagPage() {
  const { publicKey } = useWallet();
  if (!publicKey) {
    return (
      <div className="swap sbag">
        <div className="swap-card sbag-empty">
          <b>Your bag</b>
          <p>Connect to see the 100× bets your swaps bought you, and sell them for SOL in one click.</p>
          <WalletButton solo />
        </div>
      </div>
    );
  }
  return <Bag key={publicKey.toBase58()} />;
}

function Bag() {
  const { publicKey } = useWallet();
  const owner = publicKey!;
  const o = owner.toBase58();
  // live: balances + market state every 5 s (markets come from the shared snapshot, edge-cached ~10 s); cost basis every 20 s
  const book = usePoll(() => loadPortfolio(owner), [o], 5_000);
  const moves = usePoll(() => fetchFeed(undefined, o, 200), [o], 20_000);
  const pool = usePoll(poolState, []).data ?? null;
  const send = useSend();
  const [busy, setBusy] = useState<string | null>(null);
  const [seenAt, setSeenAt] = useState<number | null>(null);
  useEffect(() => {
    if (book.data) setSeenAt(Date.now());
  }, [book.data]);
  const ago = useAgo(seenAt);
  const rate = pool?.rate ?? 1;
  const basis = useMemo(() => (moves.data ? basisByPosition(moves.data, o) : null), [moves.data, o]);
  const now = Math.floor(Date.now() / 1000);
  const rows = (book.data?.positions ?? [])
    .map((p) => {
      const v = positionValue(p);
      // P&L in r-fstacc (what the curves and pots settle in), shown in SOL at the stake pool's rate
      const pnl: Pnl | null | undefined = basis ? positionPnl(basis.get(`${p.v.acct.key.toBase58()}:${p.side}`), v.units, v.best, now) : undefined;
      // what the tokens still held cost (average-cost basis): value minus their unrealized P&L. Zero means the wallet holds
      // tokens its recorded buys don't cover (bought before the feed's window, or received) — no honest P&L to show.
      const heldCost = pnl ? v.best - pnl.unrealized : 0;
      return { p, worth: v.best * rate, pnl: pnl && heldCost > 1e-12 ? pnl : pnl === undefined ? undefined : null, heldCost };
    })
    .sort((a, b) => b.worth - a.worth);
  const total = rows.reduce((a, r) => a + r.worth, 0);
  const agg = basis ? aggregatePnl(rows.map((r) => r.pnl)) : null;
  const aggSol = agg ? (agg.realized + agg.unrealized) * rate : null;

  const sell = async (p: Position) => {
    setBusy(p.key);
    const sig = await send(`Sell ${SIDE[p.side]} $${p.v.ticker}`, async (payer) => {
      const plan = await planExit(p.v, p.side, p.amt);
      const min = plan.sellMin + plan.redeemMin;
      // SOL out while the stake pool's reserve covers it; otherwise it lands as r-fstacc (SOL-backed, sweepable later)
      const solOut = pool && withdrawOut(pool, min) <= withdrawCapacity(pool) ? pool : null;
      return toV0(await exitIxs(p.v, p.side, plan, payer, solOut), payer);
    });
    setBusy(null);
    if (sig) book.refresh();
    return sig;
  };
  const sellAll = async () => {
    for (const r of rows) if (!(await sell(r.p))) break;
  };

  return (
    <div className="swap sbag">
      <div className="swap-card">
        <div className="sbag-head">
          <span>Your 100× bets are worth</span>
          <strong className="display">{book.data ? `${sol(total)} SOL` : "…"}</strong>
          {agg && aggSol !== null && (
            <span className={`sbag-pnl ${aggSol >= 0 ? "up" : "down"}`}>
              {signed(aggSol)} SOL ({pct(agg.ret)}) all-time P&L
            </span>
          )}
          {book.data && <small>{rows.length ? `${rows.length} bet${rows.length === 1 ? "" : "s"} · ${sol(Number(book.data.sol) / 1e9)} SOL in wallet` : "No 100× bets in this wallet yet. Every swap here buys you two."}</small>}
          {/* the coin itself is not a bet, but holders look for it here first */}
          {book.data && book.data.meme > 0n && (
            <small className="sbag-coin">
              You also hold {units(Number(book.data.meme) / 10 ** MEME_DECIMALS)} ${MEME_SYMBOL}. That's the coin, not a bet, so it isn't counted above.
            </small>
          )}
          {ago !== null && (
            <small className="sbag-live">
              <i aria-hidden="true" /> live · updated {ago}s ago
            </small>
          )}
        </div>
        {rows.length > 0 && (
          <ul className="sbag-list">
            {rows.map(({ p, worth, pnl, heldCost }) => {
              const s = p.v.side[p.side];
              const up = pnl ? pnl.unrealized * rate : null;
              return (
                <li key={p.key}>
                  <span className={p.side ? "down" : "up"}>{SIDE[p.side]}</span>
                  <span className="sbag-name">
                    <b>${p.v.ticker}</b>
                    <small>{units(Number(p.amt) / 10 ** s.decimals)} tokens</small>
                  </span>
                  <span className="sbag-worth">
                    {sol(worth)} SOL
                    {pnl && up !== null ? (
                      <small className={up >= 0 ? "up" : "down"}>
                        {signed(up)}{heldCost > 0 ? ` (${pct(pnl.unrealized / heldCost)})` : ""}
                      </small>
                    ) : (
                      <small className="muted">{basis ? "cost unknown" : "…"}</small>
                    )}
                  </span>
                  <button className="btn small" disabled={!!busy} onClick={() => sell(p)}>
                    {busy === p.key ? "Selling…" : "Sell"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {rows.length > 1 && (
          <button className="btn swap-go" disabled={!!busy} onClick={sellAll}>
            {busy ? "Selling…" : `Sell everything for ~${sol(total)} SOL`}
          </button>
        )}
        {book.error && !book.data && <p className="swap-err">Couldn't read your bag: {book.error}</p>}
        <p className="sbag-foot">
          <Link to="/">← back to swap</Link> · <a href={`https://100x.broker/p/${owner.toBase58()}`}>full bag on 100x.broker</a>
        </p>
      </div>
    </div>
  );
}
