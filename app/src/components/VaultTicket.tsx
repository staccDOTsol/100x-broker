// Park / Unpark ticket for one dnvault — the same slip on the /yield list and the vault page. Operate pattern: one amount, one verb, progress inline. Default verbs are the 1-click zaps
// (park + deploy, unpark straight to SOL); the plain in-kind paths stay as quiet escape hatches.
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSend } from "../hooks";
import { usePrices } from "../hooks/price";
import { useToasts } from "../components/Toasts";
import { toV0 } from "../lib/chain";
import { cu } from "../lib/hooked";
import { depositIxs, shareBalance, withdrawIxs, type VaultView } from "../lib/dn";
import { explorerFor, planZapIn, zapIn, zapOut, zapOutFinish, type Step } from "../lib/zapdn";
import { amount as fmtAmount, parseAmount, usd } from "../lib/format";

type Mode = "park" | "unpark";

export function VaultTicket({ view, ticker, onDone, className = "" }: { view: VaultView; ticker: string; onDone: () => void; className?: string }) {
  const { v, x } = view;
  const wallet = useWallet();
  const { publicKey } = wallet;
  const px = usePrices();
  const send = useSend();
  const toasts = useToasts();
  const [mode, setMode] = useState<Mode>("park");
  const [input, setInput] = useState("");
  const [part, setPart] = useState(100);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mine, setMine] = useState<bigint | null>(null);
  const [sol, setSol] = useState<bigint | null>(null);

  useEffect(() => {
    if (!publicKey) {
      setMine(null);
      setSol(null);
      return;
    }
    let alive = true;
    shareBalance(publicKey, v).then((b) => alive && setMine(b)).catch(() => alive && setMine(0n));
    import("../lib/chain").then(({ conn }) => conn.getBalance(publicKey).then((b) => alive && setSol(BigInt(b))));
    return () => {
      alive = false;
    };
  }, [publicKey?.toBase58(), x.supply.toString(), steps?.every((s) => s.status === "done")]);

  const raw = parseAmount(input, 9);
  const maxSol = sol !== null ? (sol > 15_000_000n ? sol - 15_000_000n : 0n) : null; // keep fees + the ATAs' rent
  const tooMuch = raw !== null && maxSol !== null && raw > maxSol;
  const invalid = input !== "" && raw === null;
  const sharesOut = mine !== null ? (mine * BigInt(part)) / 100n : 0n;
  const myVal = mine !== null && x.supply > 0n ? (x.nav * mine) / x.supply : 0n;
  const outVal = x.supply > 0n ? (x.nav * sharesOut) / x.supply : 0n;
  const done = useMemo(() => !!steps?.length && steps.every((s) => s.status === "done"), [steps]);
  const failed = useMemo(() => !!steps?.some((s) => s.status === "failed"), [steps]);

  const finish = (label: string) => {
    setBusy(false);
    onDone();
    toasts.push({ s: "ok", title: label, body: mode === "park" ? "Parked and working. Your receipt only gets heavier from here." : "Unparked. It's all SOL in your wallet again." });
  };
  const fail = (e: unknown) => {
    setBusy(false);
    const msg = e instanceof Error ? e.message : String(e);
    setErr(/reject|cancel|denied/i.test(msg) ? "You closed the wallet. Nothing moved." : msg.length > 160 ? msg.slice(0, 160) + "…" : msg);
  };

  async function parkDeploy() {
    if (!publicKey || !raw || raw <= 0n) return;
    setBusy(true);
    setErr(null);
    setSteps([{ label: "Planning the deploy", status: "sending" }]);
    try {
      const plan = await planZapIn(publicKey, view, raw);
      await zapIn(publicKey, plan, wallet, setSteps);
      if (plan.note) toasts.push({ s: "ok", title: "Parked", body: plan.note });
      setInput("");
      finish("Park & deploy");
    } catch (e) {
      fail(e);
    }
  }
  async function parkOnly() {
    if (!publicKey || !raw || raw <= 0n) return;
    setBusy(true);
    setErr(null);
    setSteps(null);
    const sig = await send(`Park SOL in ${ticker}`, async (payer) => toV0([cu(400_000), ...depositIxs(payer, view, raw)], payer));
    setBusy(false);
    if (sig) {
      setInput("");
      onDone();
    }
  }
  async function unparkSol() {
    if (!publicKey || sharesOut <= 0n) return;
    setBusy(true);
    setErr(null);
    setSteps([{ label: "Planning the exit", status: "sending" }]);
    try {
      await zapOut(publicKey, view, sharesOut, wallet, setSteps);
      finish("Unpark to SOL");
    } catch (e) {
      fail(e);
    }
  }
  async function finishLeftovers() {
    if (!publicKey) return;
    setBusy(true);
    setErr(null);
    setSteps([{ label: "Reading what's in your wallet", status: "sending" }]);
    try {
      await zapOutFinish(publicKey, view, wallet, setSteps);
      finish("Turned into SOL");
    } catch (e) {
      fail(e);
    }
  }
  async function unparkKind() {
    if (!publicKey || sharesOut <= 0n) return;
    setBusy(true);
    setErr(null);
    setSteps(null);
    const sig = await send(`Unpark ${part}% of ${ticker}`, async (payer) => toV0([cu(900_000), ...(await withdrawIxs(payer, view, sharesOut))], payer));
    setBusy(false);
    if (sig) onDone();
  }

  const canPark = !!publicKey && !!raw && raw > 0n && !tooMuch && !busy;
  const canUnpark = !!publicKey && sharesOut > 0n && !busy;

  return (
    <div className={`vc-ticket ${className}`} aria-busy={busy}>
      <div className="tabs" role="tablist" aria-label="Park or unpark">
        <button role="tab" aria-selected={mode === "park"} onClick={() => (setMode("park"), setSteps(null), setErr(null))} disabled={busy}>
          Park SOL
        </button>
        <button role="tab" aria-selected={mode === "unpark"} onClick={() => (setMode("unpark"), setSteps(null), setErr(null))} disabled={busy}>
          Unpark
        </button>
      </div>

      <div className="panel-row">
        <span className="muted">Your bag</span>
        <span className="num nowrap">{mine === null ? "—" : `${usd(px.lamportsUsd(myVal))} · ${fmtAmount(mine, 9, 3)} receipts`}</span>
      </div>

      {mode === "park" ? (
        <>
          <div className="input text" data-invalid={invalid || tooMuch}>
            <input
              inputMode="decimal"
              placeholder="0.0"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-label="SOL to park"
              aria-invalid={invalid || tooMuch}
              disabled={busy}
            />
            <span className="unit">SOL</span>
          </div>
          <div className="zap-hints meta num">
            <span>{sol === null ? "" : `balance ${fmtAmount(sol, 9, 3)}`}</span>
            <span className="chips">
              {[25, 50, 100].map((p) => (
                <button key={p} className="chip" disabled={busy || maxSol === null} onClick={() => maxSol !== null && setInput(fmtAmount((maxSol * BigInt(p)) / 100n, 9, 4).replace(/,/g, ""))}>
                  {p}%
                </button>
              ))}
            </span>
          </div>
          {tooMuch && <span className="err">More than your balance (we keep ~0.015 SOL back for fees).</span>}
          {invalid && <span className="err">That's not a number.</span>}
          <button className="btn big" disabled={!canPark} data-loading={busy} onClick={parkDeploy}>
            {publicKey ? "Park & deploy — 1 click" : "Connect to park"}
          </button>
          <p
            className="note num"
            title={`One prompt, up to three transactions: park, swap half to ${ticker} + buy the DOWN hedge, add liquidity. You keep the ${v.keeperBps / 100}% keeper bounty. Steps 2–3 may preview as "may fail" until step 1 lands.`}
          >
            1 prompt · 3 tx · you keep {v.keeperBps / 100}%
          </p>
          <button className="linkish" disabled={!canPark} onClick={parkOnly}>
            just park · keeper deploys →
          </button>
        </>
      ) : (
        <>
          <div className="chips" role="group" aria-label="How much">
            {[25, 50, 100].map((p) => (
              <button key={p} className="chip" aria-pressed={part === p} disabled={busy} onClick={() => setPart(p)}>
                {p}%
              </button>
            ))}
            <span className="meta num nowrap">≈ {usd(px.lamportsUsd(outVal))}</span>
          </div>
          <button className="btn big" disabled={!canUnpark} data-loading={busy} onClick={unparkSol}>
            {publicKey ? `Unpark ${part}% to SOL — 1 click` : "Connect to unpark"}
          </button>
          <p
            className="note num"
            title={`One prompt, two transactions: your slice comes out in kind (SOL, ${ticker}, LP, DOWN hedge), then the second sells the ${ticker} back, exits the DOWN at the better of curve or pot, and unstakes the rest. SOL only.`}
          >
            1 prompt · 2 tx · SOL out
          </p>
          <button className="linkish" disabled={!canUnpark} onClick={unparkKind}>
            take in kind · keep {ticker} + DOWN →
          </button>
          <button className="linkish" disabled={!publicKey || busy} onClick={finishLeftovers}>
            {failed ? "finish · leftovers → SOL →" : `leftovers → SOL →`}
          </button>
        </>
      )}

      {steps && (
        <ol className={`zap-steps ${done ? "done" : failed ? "failed" : ""}`} aria-live="polite">
          {steps.map((st, i) => (
            <li key={i} className={`st ${st.status}`}>
              <span className="glyph" aria-hidden>
                {st.status === "done" ? "✓" : st.status === "failed" ? "✕" : st.status === "sending" ? "⟳" : st.status === "signing" ? "✎" : "·"}
              </span>
              <span className="label">{st.label}</span>
              {st.sig && (
                <a className="meta" href={explorerFor(st.sig)} target="_blank" rel="noreferrer">
                  tx ↗
                </a>
              )}
              {st.error && <span className="err">{st.error}</span>}
            </li>
          ))}
        </ol>
      )}
      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
