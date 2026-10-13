import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { conn } from "../lib/chain";
import { amount, short } from "../lib/format";
import { usePoll, useSend } from "../hooks";
import { useToasts } from "./Toasts";
import type { BurnerWalletAdapter } from "../lib/burner";

/** One signature's fee; the sweep sends everything above it, leaving the burner at zero. */
const FEE = 5_000n;

/** Sits in the wallet popover while the burner is connected: fund it, watch it, export it, empty it. */
export function BurnerPanel({ adapter, onDisconnect }: { adapter: BurnerWalletAdapter; onDisconnect: () => void }) {
  const { publicKey } = useWallet();
  const toasts = useToasts();
  const send = useSend();
  const addr = publicKey?.toBase58() ?? "";
  const bal = usePoll(async () => (publicKey ? BigInt(await conn.getBalance(publicKey, "confirmed")) : 0n), [addr], 10_000);
  const [secret, setSecret] = useState<string | null>(null);
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState(false);
  const destKey = useMemo(() => {
    try {
      return dest.trim() ? new PublicKey(dest.trim()) : null;
    } catch {
      return null;
    }
  }, [dest]);
  const lamports = bal.data ?? 0n;
  const sweepable = lamports > FEE ? lamports - FEE : 0n;
  const copy = () => {
    navigator.clipboard?.writeText(addr);
    toasts.push({ s: "ok", title: "Address copied", body: "Send SOL here from any wallet or exchange." });
  };
  const sweep = async () => {
    if (!destKey || sweepable === 0n) return;
    setBusy(true);
    const sig = await send("Empty the burner", async (payer) =>
      new Transaction().add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: destKey, lamports: sweepable })),
    );
    setBusy(false);
    if (sig) {
      setDest("");
      bal.refresh();
    }
  };
  return (
    <div className="menu burner" role="dialog" aria-label="Burner wallet">
      <div className="none">Burner · {adapter.persisted ? "saved in this browser" : "this tab only (storage is off, so it dies with the tab)"}</div>
      <div className="who">
        <button type="button" className="addr num" onClick={copy} title="Copy address">
          {short(addr)} ⧉
        </button>
        <span className="meta num" aria-live="polite">
          {bal.data === undefined ? (bal.error ? "balance —" : "balance…") : `${amount(lamports, 9)} SOL`}
        </span>
      </div>
      <p>Send it $5–20 of SOL from anywhere, then press buttons. Nothing to install, nothing to trust.</p>
      <div className="acts">
        <button type="button" className="btn ghost small" onClick={copy}>
          copy address
        </button>
        <button type="button" className="btn ghost small" onClick={() => setSecret((s) => (s ? null : adapter.exportSecret()))}>
          {secret ? "hide secret" : "export secret"}
        </button>
      </div>
      {secret && (
        <>
          <p className="meta">Anyone with this can spend the burner. Import it into a wallet app; paste it nowhere else.</p>
          <code>{secret}</code>
        </>
      )}
      <div className="field">
        <label className="meta" htmlFor="burner-dest">
          sweep everything to
        </label>
        <div className="input" data-invalid={dest.trim() !== "" && !destKey}>
          <input
            id="burner-dest"
            placeholder="a wallet address"
            value={dest}
            onChange={(e) => setDest(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
          />
        </div>
        <button type="button" className="btn small" disabled={!destKey || sweepable === 0n || busy} data-loading={busy} onClick={sweep}>
          {sweepable === 0n ? "nothing to sweep" : `sweep ${amount(sweepable, 9)} SOL`}
        </button>
      </div>
      <p className="meta">This key lives in this browser's storage. Clearing site data deletes it. Export it before you rely on it.</p>
      <div className="acts">
        <button type="button" className="btn ghost small" onClick={onDisconnect}>
          Disconnect
        </button>
      </div>
    </div>
  );
}
