import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { humanError, usePoll } from "../hooks";
import { sendWarRaw } from "../lib/war-confirm";
import { formatWarTokenAmount } from "../lib/war-routing";
import { signAndSendWarTransactions, WarSendError, type WarSendProgress } from "../lib/war-send";
import { useToasts } from "./Toasts";

type QuoteBag = {
  wallet: string;
  quote: string;
  keysRaw: string;
  wars: number;
  claimable: { id: number; owedRaw: string }[];
  totals: { mint: string | null; owedRaw: string }[];
};

type Props = {
  mint: string | null;
  symbol: string;
  decimals: number;
  usd: number | null;
  revision: number;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onClaimed?: () => void;
};

/** A wallet's entire quote position, including keys in games with no dividends yet. */
export function WarQuotePosition({ mint, symbol, decimals, usd, revision, disabled = false, onBusyChange, onClaimed }: Props) {
  const { publicKey, signAllTransactions, signTransaction } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const quote = mint ?? "SOL";
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [progress, setProgress] = useState<WarSendProgress | null>(null);
  const running = useRef(false);
  const previousRevision = useRef(revision);
  const bag = usePoll<QuoteBag | null>(async () => {
    if (!wallet) return null;
    const r = await fetch(`/api/war?bag=${wallet}&mint=${encodeURIComponent(quote)}`, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "couldn't load your quote position");
    return j as QuoteBag;
  }, [wallet, quote], 30_000);
  const refreshRef = useRef(bag.refresh);
  refreshRef.current = bag.refresh;

  useEffect(() => {
    if (previousRevision.current === revision || bag.loading) return;
    const timer = setTimeout(() => {
      previousRevision.current = revision;
      refreshRef.current();
    }, 300);
    return () => clearTimeout(timer);
  }, [revision, bag.loading]);

  useEffect(() => {
    setBlocked(false);
    setProgress(null);
  }, [wallet, quote]);

  // usePoll retains its last result while identities change; never display another wallet or quote's balance.
  const position = bag.data?.wallet === wallet && bag.data.quote === quote ? bag.data : null;
  const owedRaw = position?.totals.reduce((sum, row) => row.mint === mint ? sum + BigInt(row.owedRaw) : sum, 0n) ?? 0n;
  const owed = formatWarTokenAmount(owedRaw, decimals);
  const owedUsd = usd === null ? null : Number(owedRaw) / 10 ** decimals * usd;
  const usdLabel = owedUsd === null ? "" : owedUsd === 0 ? "$0" : owedUsd >= 1 ? `$${owedUsd.toFixed(2)}` : `$${owedUsd.toPrecision(2)}`;

  async function claim() {
    if (!wallet || !position || owedRaw <= 0n || disabled || bag.loading || running.current || blocked) return;
    running.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setProgress(null);
    const toast = toasts.push({ s: "pending", title: `Claim all $${symbol} dividends`, body: "Preparing claims across your games…" });
    try {
      const r = await fetch("/api/war", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "claimall", wallet, mint }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "couldn't prepare your claims");
      const txs = (j.txs as string[]).map((raw) => VersionedTransaction.deserialize(Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))));
      const games = Number(j.summary?.wars ?? position.claimable.length);
      toasts.update(toast, { body: `${games} ${games === 1 ? "game" : "games"}. Sign ${txs.length} ${txs.length === 1 ? "transaction" : "transactions"} once.` });
      await signAndSendWarTransactions(txs, { signAllTransactions, signTransaction }, sendWarRaw, (p) => {
        setProgress(p);
        if (p.submitted) toasts.update(toast, { body: `${p.confirmed} / ${p.total} transactions landed. Submitting claims in order.` });
      });
      toasts.update(toast, { s: "ok", body: `Dividends claimed from ${games} ${games === 1 ? "game" : "games"}.` });
      onClaimed?.();
    } catch (error) {
      const uncertain = error instanceof WarSendError && error.submitted;
      if (uncertain) {
        setBlocked(true);
        onClaimed?.();
      }
      toasts.update(toast, { s: "err", body: `${uncertain ? `${error.confirmed} of ${error.total} transactions landed. A submitted claim may still land; check its status before another batch. ` : ""}${humanError(error)}` });
    } finally {
      refreshRef.current();
      running.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  if (!wallet) return null;
  return (
    <section className="war-me" aria-label={`Your aggregate $${symbol} position`}>
      <div><small>your keys on ${symbol}</small><b>{position?.keysRaw ?? "…"}</b></div>
      <div><small>your dividends on ${symbol}</small><b>{position ? `${owed} $${symbol}${usdLabel ? ` (~${usdLabel})` : ""}` : "…"}</b></div>
      <div className="war-actions">
        <button className="btn small" disabled={disabled || busy || bag.loading || blocked || !position || owedRaw <= 0n} onClick={claim}>{busy ? "Claiming…" : "Claim all"}</button>
        <small>{position ? `Across ${position.wars} ${position.wars === 1 ? "game" : "games"} on $${symbol}. One wallet approval.` : "Loading your games…"}</small>
      </div>
      {busy && progress && <small role="status">{progress.confirmed} / {progress.total} transactions landed</small>}
      {blocked && <small className="war-err">The claim batch stopped. Some claims may still land; refresh the page to review your position before another batch.</small>}
      {bag.error && <small className="war-err">{bag.error}</small>}
    </section>
  );
}

export default WarQuotePosition;
