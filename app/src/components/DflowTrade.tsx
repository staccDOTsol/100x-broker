import { useEffect, useId, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { useSearchParams } from "react-router-dom";
import { WSOL } from "../config";
import { humanError, useSend } from "../hooks";
import { conn, type MarketView } from "../lib/chain";
import { amount as formatAmount, parseAmount } from "../lib/format";
import { DflowClientError, dflowRequestKey, fetchDflowOrder, fetchDflowQuote, fetchDflowStatus, prepareDflowTransaction, type DflowParams, type DflowQuote } from "../lib/dflow";
import { WalletButton } from "./bits";

type Props = { view: MarketView; onDone?: () => void | Promise<void>; className?: string };
type QuoteState = { key: string; value: DflowQuote; at: number };
const U64_MAX = (1n << 64n) - 1n;
function slippageFromPercent(text: string): number | null {
  if (!/^\d{1,2}(?:\.\d{0,2})?$/.test(text)) return null;
  const bps = Math.round(Number(text) * 100);
  return bps >= 1 && bps <= 1000 ? bps : null;
}

export function DflowTrade({ view, onDone, className = "" }: Props) {
  const [query, setQuery] = useSearchParams();
  const queryAmount = query.get("amt");
  const side: 0 | 1 = query.get("side") === "1" ? 1 : 0;
  const mode = query.get("mode") === "sell" ? "sell" : "buy";
  const market = view.acct.key.toBase58();
  const mint = (side === 0 ? view.acct.bullMint : view.acct.bearMint).toBase58();
  const sideSymbol = view.side[side].symbol || `${side === 0 ? "UP" : "DOWN"} ${view.ticker}`;
  const sideDecimals = view.side[side].decimals;
  const buy = mode === "buy";
  const inputDecimals = buy ? 9 : sideDecimals;
  const outputDecimals = buy ? sideDecimals : 9;
  const inputSymbol = buy ? "SOL" : sideSymbol;
  const outputSymbol = buy ? sideSymbol : "SOL";
  const { publicKey, signTransaction } = useWallet();
  const owner = publicKey?.toBase58() ?? null;
  const send = useSend();
  const amountId = useId();
  const slippageId = useId();
  const [input, setInput] = useState(() => queryAmount ?? "");
  const [slippageText, setSlippageText] = useState("1");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuoteState | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [tick, setTick] = useState(0);
  const [balances, setBalances] = useState<{ key: string; sol: bigint; token: bigint } | null>(null);
  const [balanceError, setBalanceError] = useState(false);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const quoteController = useRef<AbortController | null>(null);
  const submitController = useRef<AbortController | null>(null);
  const queryKey = JSON.stringify([market, mode, queryAmount]);
  const appliedQueryKey = useRef(queryKey);
  const slippageBps = slippageFromPercent(slippageText);
  const amountRaw = input.length <= 60 ? parseAmount(input, inputDecimals) : null;
  const amountValid = amountRaw !== null && amountRaw > 0n && amountRaw <= U64_MAX;
  const params: DflowParams | null = amountValid && slippageBps !== null ? {
    inputMint: buy ? WSOL.toBase58() : mint, outputMint: buy ? mint : WSOL.toBase58(), amount: amountRaw.toString(), slippageBps,
  } : null;
  const requestKey = params ? dflowRequestKey(params) : "";
  const live = useRef({ key: requestKey, owner, market, queryKey });
  live.current = { key: requestKey, owner, market, queryKey };
  const currentQuote = configured === true && quote?.key === requestKey ? quote : null;
  const balanceKey = `${owner}:${mint}`;
  const balance = balances?.key === balanceKey ? (buy ? balances.sol : balances.token) : null;
  const insufficient = balance !== null && amountRaw !== null && amountRaw > balance;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; quoteController.current?.abort(); submitController.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!busy && !busyRef.current && appliedQueryKey.current !== queryKey) {
      appliedQueryKey.current = queryKey;
      setInput(queryAmount ?? ""); setQuote(null); setActionError(null); setQuoteError(null);
    }
  }, [queryKey, queryAmount, busy]);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const check = async () => {
      try { const ready = await fetchDflowStatus(controller.signal); if (alive) { setConfigured(ready); setStatusError(null); } }
      catch (e) { if (alive && !controller.signal.aborted) { setConfigured(null); setStatusError(humanError(e)); } }
    };
    void check();
    const timer = setInterval(check, 30_000);
    return () => { alive = false; controller.abort(); clearInterval(timer); };
  }, []);
  useEffect(() => {
    let alive = true;
    setBalanceError(false);
    if (!owner) { setBalances(null); return; }
    const load = async () => {
      try {
        const wallet = new PublicKey(owner);
        const ata = getAssociatedTokenAddressSync(new PublicKey(mint), wallet, false, TOKEN_2022_PROGRAM_ID);
        const [walletInfo, tokenInfo] = await conn.getMultipleAccountsInfo([wallet, ata], "confirmed");
        const token = tokenInfo ? unpackAccount(ata, tokenInfo, TOKEN_2022_PROGRAM_ID).amount : 0n;
        if (alive) { setBalances({ key: `${owner}:${mint}`, sol: BigInt(walletInfo?.lamports ?? 0), token }); setBalanceError(false); }
      } catch { if (alive) setBalanceError(true); }
    };
    void load();
    const timer = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [owner, mint, tick]);
  useEffect(() => {
    quoteController.current?.abort();
    if (busy) return;
    setQuoteError(null);
    if (!params || !configured) { setQuote(null); setQuoting(false); return; }
    const controller = new AbortController();
    quoteController.current = controller;
    setQuoting(true);
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const value = await fetchDflowQuote(params, controller.signal);
        if (!controller.signal.aborted && live.current.key === requestKey) { setQuote({ key: requestKey, value, at: Date.now() }); setQuoteError(null); }
      } catch (e) {
        if (!controller.signal.aborted && live.current.key === requestKey) { setQuote(null); setQuoteError(humanError(e)); }
      } finally {
        if (!controller.signal.aborted) { setQuoting(false); timer = setTimeout(load, 15_000); }
      }
    };
    timer = setTimeout(load, 300);
    return () => { controller.abort(); clearTimeout(timer); };
    // Primitive key covers every request field; the market snapshot may refresh without changing the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, configured, busy, tick]);

  const changeChoice = (nextSide: 0 | 1, nextMode: "buy" | "sell") => {
    if (busyRef.current) return;
    const next = new URLSearchParams(query);
    next.set("side", String(nextSide)); next.set("mode", nextMode); next.delete("amt");
    setQuery(next, { replace: true });
    setQuote(null); setActionError(null); setQuoteError(null);
    if (nextMode !== mode) setInput("");
  };
  async function submit() {
    if (busyRef.current || !publicKey || !signTransaction || !params || !currentQuote || !configured || insufficient || balanceError || balance === null) return;
    if (Date.now() - currentQuote.at > 30_000) { setActionError("That quote expired. Refresh it before trading."); setQuote(null); setTick((value) => value + 1); return; }
    const expected = params;
    const displayed = currentQuote.value;
    const expectedKey = requestKey;
    const expectedOwner = publicKey.toBase58();
    const expectedMarket = market;
    const expectedQueryKey = queryKey;
    const controller = new AbortController();
    submitController.current = controller;
    quoteController.current?.abort();
    busyRef.current = true; setBusy(true); setActionError(null); setPhase("Getting a fresh DFlow order…");
    const assertCurrent = () => {
      if (!mounted.current || controller.signal.aborted || live.current.key !== expectedKey || live.current.owner !== expectedOwner || live.current.market !== expectedMarket || live.current.queryKey !== expectedQueryKey) {
        throw new DflowClientError("The selected trade or wallet changed. Review the quote again.", "DFLOW_REQUEST_CHANGED");
      }
    };
    try {
      const signature = await send(`${buy ? "Buy" : "Sell"} ${sideSymbol} · DFlow`, async (payer) => {
        try {
          assertCurrent();
          if (payer.toBase58() !== expectedOwner) throw new DflowClientError("The connected wallet changed. Review the trade again.");
          const order = await fetchDflowOrder(expected, expectedOwner, controller.signal);
          assertCurrent();
          const transaction = prepareDflowTransaction(order, displayed, expected, payer);
          setPhase("Checking the trade before signing…");
          const [simulation, height] = await Promise.all([
            conn.simulateTransaction(transaction, { commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: false }),
            conn.getBlockHeight("confirmed"),
          ]);
          assertCurrent();
          if (simulation.value.err) throw new DflowClientError("The DFlow trade did not pass simulation. Refresh the quote before trying again.", "DFLOW_SIMULATION_FAILED");
          if (height > order.lastValidBlockHeight!) throw new DflowClientError("The DFlow order expired. Refresh the quote.", "DFLOW_ORDER_EXPIRED");
          setPhase("Confirm in your wallet; awaiting the transaction result…");
          return transaction;
        } catch (e) { if (mounted.current) setActionError(humanError(e)); throw e; }
      }, assertCurrent);
      if (signature) {
        if (mounted.current) { setInput(""); setQuote(null); setPhase("Trade confirmed."); }
        try { await onDone?.(); }
        catch { if (mounted.current) setActionError("Trade confirmed. Market data could not refresh; reload to see your updated position."); }
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) { setBusy(false); setPhase(""); setTick((value) => value + 1); }
    }
  }

  const canTrade = Boolean(publicKey && signTransaction && configured && currentQuote && Date.now() - currentQuote.at <= 30_000 && params && balance !== null && !balanceError && !insufficient && !busy);
  const invalidAmount = input !== "" && !amountValid;
  return (
    <section className={`ticket ${className}`} aria-label="DFlow trading" aria-busy={busy}>
      <div className="sides" role="group" aria-label="Position direction">
        {([0, 1] as const).map((choice) => <button key={choice} className={`side ${choice === 0 ? "u" : "d"}`} aria-pressed={choice === side} disabled={busy} onClick={() => changeChoice(choice, mode)}>
          <strong>{choice === 0 ? "UP" : "DOWN"}</strong><span className="meta">{view.side[choice].symbol}</span>
        </button>)}
      </div>
      <div className="ticket-body">
        <div className="panel-row"><strong>Trade with DFlow</strong><span className="meta">{sideSymbol}</span></div>
        <div className="tabs" role="group" aria-label="Buy or sell">
          <button aria-pressed={buy} aria-selected={buy} disabled={busy} onClick={() => changeChoice(side, "buy")}>Buy</button>
          <button aria-pressed={!buy} aria-selected={!buy} disabled={busy} onClick={() => changeChoice(side, "sell")}>Sell</button>
        </div>
        {configured === false ? <p className="note" role="status"><strong>DFlow is not available yet.</strong><br />Trading will open here when production API access is connected.</p>
          : statusError ? <p className="err" role="status">DFlow availability could not be checked. Retrying…</p>
          : configured === null ? <p className="note" role="status">Checking DFlow availability…</p> : null}
        <div className="field">
          <label htmlFor={amountId}><span>{buy ? "You pay" : "You sell"}</span><span className="meta">{owner ? balanceError ? "Balance unavailable" : balance === null ? "Loading balance…" : `Balance ${formatAmount(balance, inputDecimals, 6)}` : "Connect to see balance"}</span></label>
          <div className="input" data-invalid={invalidAmount || insufficient}>
            <input id={amountId} inputMode="decimal" autoComplete="off" placeholder="0.0" value={input} disabled={busy} aria-invalid={invalidAmount || insufficient} onChange={(event) => { setInput(event.target.value); setActionError(null); }} />
            <span className="unit">{inputSymbol}</span>
          </div>
          {invalidAmount ? <span className="err">Enter a positive amount with at most {inputDecimals} decimal places.</span> : insufficient ? <span className="err">This exceeds your {inputSymbol} balance.</span> : null}
        </div>
        <div className="field">
          <label htmlFor={slippageId}>Slippage tolerance</label>
          <div className="input text" data-invalid={slippageBps === null}>
            <input id={slippageId} inputMode="decimal" value={slippageText} disabled={busy} aria-invalid={slippageBps === null} onChange={(event) => { setSlippageText(event.target.value); setActionError(null); }} />
            <span className="unit">%</span>
          </div>
          {slippageBps === null ? <span className="err">Choose 0.01%–10% slippage.</span> : null}
        </div>
        <div className="quote" aria-live="polite">
          <div className="panel-row"><span>Estimated received</span><strong className="num">{currentQuote ? `${formatAmount(BigInt(currentQuote.value.outAmount), outputDecimals, outputDecimals)} ${outputSymbol}` : quoting ? "Quoting…" : "—"}</strong></div>
          <div className="panel-row"><span>Minimum received</span><strong className="num">{currentQuote ? `${formatAmount(BigInt(currentQuote.value.minOutAmount), outputDecimals, outputDecimals)} ${outputSymbol}` : "—"}</strong></div>
          {currentQuote ? <p className="meta">{currentQuote.value.routePlan.map((hop) => hop.venue).join(" → ")}</p> : null}
        </div>
        {actionError ? <p className="err" role="alert">{actionError}</p> : quoteError ? <p className="err" role="alert">{quoteError}</p> : null}
        {!publicKey ? <WalletButton solo /> : null}
        <button className={`btn big ${side === 0 ? "up" : "down"}`} disabled={!canTrade} data-loading={busy} onClick={() => void submit()}>
          {busy ? "Trading…" : !publicKey ? "Connect a wallet to trade" : !signTransaction ? "Wallet cannot sign transactions" : `${buy ? "Buy" : "Sell"} ${sideSymbol}`}
        </button>
        {busy ? <p className="note" role="status">{phase}</p> : <p className="note">DFlow routes the swap. Your wallet approves it. Network and venue fees apply.</p>}
        <button className="linkish" disabled={busy} onClick={() => { setActionError(null); setTick((value) => value + 1); }}>Refresh quote and balance</button>
      </div>
    </section>
  );
}
