import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { useToasts } from "./components/Toasts";
import { conn, sendRaw, TxFailed } from "./lib/chain";
import { POLL_MS } from "./config";

/** Polls `load` every `ms` (default POLL_MS) while the tab is visible. Keeps the last good value on errors. */
export function usePoll<T>(load: () => Promise<T>, deps: unknown[], ms = POLL_MS) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      try {
        const v = await loadRef.current();
        if (alive) {
          setData(v);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) {
          setLoading(false);
          timer = setTimeout(run, document.hidden ? ms * 4 : ms);
        }
      }
    };
    setLoading(true);
    run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, refresh: () => setTick((t) => t + 1) };
}

const ERRORS = [
  "InvalidInstruction", "InvalidMarket", "InvalidOracle", "OracleWindowEmpty", "InvalidMint", "InvalidPool",
  "InvalidVault", "InvalidEscrow", "InvalidProgram", "InvalidPda", "MissingSigner", "SettleInProgress",
  "NotSettling", "NothingOwed", "SettleSandwich", "EscrowNotEmpty", "Overshoot", "NoProceeds", "ZeroAmount",
  "ExceedsCirculating", "MathOverflow",
];
const DN_ERRORS: Record<number, string> = {
  12: "the vault refused: that step would leak value out of the vault (max loss guard)",
  13: "the vault refused: that step would leave the hedge worse than before. The DOWN side is too thin to hedge right now, so your SOL stays parked and the keeper deploys it when DOWN refills",
  14: "the vault refused: the pool price is too far from the market's TWAP right now; try again in a few minutes",
  16: "nothing to unpark: no receipts in this wallet",
};
export function humanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/reject|denied|cancel/i.test(msg)) return "You blinked. Wallet says no.";
  const dn = msg.match(/2ZbjE44nSh3AmpREg4sdNMViBLAzAEtFKYDn1XdqMzEj failed: custom program error: 0x([0-9a-f]+)/i);
  if (dn && DN_ERRORS[parseInt(dn[1], 16)]) return DN_ERRORS[parseInt(dn[1], 16)];
  const custom = (e instanceof TxFailed ? JSON.stringify(e.detail) : msg).match(/(?:Custom"?:?\s*|0x)(\d+|[0-9a-f]+)/i);
  if (custom) {
    const n = custom[0].startsWith("0x") ? parseInt(custom[1], 16) : Number(custom[1]);
    if (n >= 0x1000 && n < 0x1000 + ERRORS.length) return `Program rejected: ${ERRORS[n - 0x1000]}`;
    if (n === 1) return "Not enough in the wallet. Even at 100×.";
  }
  if (/insufficient/i.test(msg)) return "Not enough in the wallet. Even at 100×.";
  return msg.length > 160 ? msg.slice(0, 160) + "…" : msg;
}

type Built = VersionedTransaction | Transaction;
import { track } from "@vercel/analytics";
/** Success copy per action; also the funnel's "tx" event (label = which button). */
const done = (label: string) => (track("tx", { label: label.split(" ").slice(0, 3).join(" ") }),
  /^Ape/.test(label) ? "You're in. The other side would like a word."
  : /^(Sell|Exit)/.test(label) ? "Out. Respectfully, coward."
  : /^Cash out/.test(label) ? "Cashed out at the pot. Clean."
  : /^Collect/.test(label) ? "Collected. Debt's paid."
  : /^Sweep/.test(label) ? "Tips swept into the pots."
  : /^Empty the burner/.test(label) ? "Sent. The burner is empty again."
  : /^Make them pay/.test(label) ? "They paid."
  : /^Tip/.test(label) ? "Tipped. The pots thank you."
  : /^Burn/.test(label) ? "Burned. Supply's smaller, you're richer."
  : /^Park/.test(label) ? "Parked. The keeper's on it; your receipt only gets heavier."
  : /^Unpark/.test(label) ? "Unparked, in kind. Everything that was yours is in your wallet."
  : "Confirmed.");
/** Build -> wallet sign -> send -> poll confirm, narrated through toasts. */
export function useSend() {
  const { publicKey, signTransaction } = useWallet();
  const toasts = useToasts();
  return useCallback(
    async (label: string, build: (payer: PublicKey) => Promise<Built>) => {
      if (!publicKey || !signTransaction) {
        toasts.push({ s: "err", title: label, body: "Connect a wallet first." });
        return null;
      }
      const id = toasts.push({ s: "pending", title: label, body: "Cooking the transaction…" });
      const short = label.split(" ").slice(0, 3).join(" ");
      let stage = "build";
      track("tx_try", { label: short });
      try {
        const tx = await build(publicKey);
        stage = "sign";
        if (tx instanceof Transaction) {
          tx.feePayer = tx.feePayer ?? publicKey;
          tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
        }
        toasts.update(id, { body: "Your wallet wants a word" });
        const signed = await signTransaction(tx);
        stage = "send";
        toasts.update(id, { body: "In flight. Say something nice to the validators." });
        const sig = await sendRaw(signed.serialize());
        toasts.update(id, { s: "ok", body: done(label), sig });
        return sig;
      } catch (e) {
        const why = humanError(e);
        // the funnel's missing step: who tried, where it died (build / sign / send), and why — not just who succeeded
        track(`tx_fail_${stage}`, { label: short, why: why.slice(0, 80) });
        toasts.update(id, { s: "err", body: why, sig: e instanceof TxFailed ? e.sig : undefined });
        return null;
      }
    },
    [publicKey, signTransaction, toasts],
  );
}
