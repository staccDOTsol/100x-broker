// $100X: the fee split, the CA, the pot, and the burn bounty.
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePoll, useSend } from "../hooks";
import { usePrices } from "../hooks/price";
import { useToasts } from "./Toasts";
import { Tweet } from "./Share";
import { Rolling } from "./Pulse";
import { buildBurnTx, loadBurnPot, memeBalance } from "../lib/burn";
import { amount as fmtAmount, parseAmount, usd } from "../lib/format";
import { FEE_SPLIT, MEME_MINT, MEME_SYMBOL, PUMP_URL } from "../config";

export function CopyCA({ small = false }: { small?: boolean }) {
  const toasts = useToasts();
  const ca = MEME_MINT.toBase58();
  return (
    <button
      className={`btn ghost ${small ? "small" : ""} ca`}
      title={ca}
      onClick={() => {
        navigator.clipboard?.writeText(ca);
        toasts.push({ s: "ok", title: "CA copied", body: ca });
      }}
    >
      <span className="num">{ca.slice(0, 6)}…{ca.slice(-4)}</span> <span className="muted">copy CA</span>
    </button>
  );
}

/** Board strip: what the coin is, where fees go, the pot. */
export function CoinStrip() {
  const { data: p } = usePoll(loadBurnPot, []);
  const px = usePrices();
  return (
    <section className="coin" id="coin">
      <div className="coin-left">
        <div className="meta">
          The coin · ${MEME_SYMBOL}
          <span className="right">
            {p && <Tweet text={`${FEE_SPLIT.burn}% of every 100x.broker fee burns $${MEME_SYMBOL} · ${fmtAmount(p.totalBurned, p.decimals, 0)} burned so far`} path="/#coin" />}
          </span>
        </div>
        <h2 className="display">
          {FEE_SPLIT.burn}% of fees → <span className="down">burn</span>.
        </h2>
        <p className="coin-copy num">on-chain · permissionless · burners paid +3%</p>
        <div className="coin-actions">
          <CopyCA />
          <a className="btn" href={PUMP_URL} target="_blank" rel="noreferrer">
            Buy on pump.fun
          </a>
        </div>
        <details className="fine">
          <summary className="meta">how →</summary>
          <p>
            4% in, 4% out → <b>{FEE_SPLIT.mech}%</b> pots · <b>{FEE_SPLIT.burn}%</b> buys ${MEME_SYMBOL}, burns it · <b>{FEE_SPLIT.dev}%</b> buys BABY100X, burns it. Bring $
            {MEME_SYMBOL}, program burns it, pays you +3% over market.
          </p>
        </details>
      </div>
      <div className="coin-right">
        <div className="split" role="img" aria-label="Fee split 60 30 10">
          <span style={{ flex: FEE_SPLIT.mech }} className="s-mech">
            {FEE_SPLIT.mech}% pots
          </span>
          <span style={{ flex: FEE_SPLIT.burn }} className="s-burn">
            {FEE_SPLIT.burn}% burn
          </span>
          <span style={{ flex: FEE_SPLIT.dev }} className="s-dev" title="10% of every fee buys BABY100X with $100XBRO and burns it">
            {FEE_SPLIT.dev}% BABY burn
          </span>
        </div>
        <div className="coin-stats">
          <div className="stat-card">
            <span className="meta">Burn pot</span>
            <strong className="display num">{p && px.quoteUsd(p.pot) !== null ? <Rolling value={px.quoteUsd(p.pot)!} format={usd} /> : "—"}</strong>
          </div>
          <div className="stat-card">
            <span className="meta">Burned</span>
            <strong className="display num">{p ? <Rolling value={Number(p.totalBurned) / 10 ** p.decimals} format={(n) => n.toLocaleString(undefined, { maximumFractionDigits: 0 })} /> : "—"}</strong>
          </div>
          <div className="stat-card">
            <span className="meta">Paid out</span>
            <strong className="display num">{p && px.quoteUsd(p.totalPaid) !== null ? <Rolling value={px.quoteUsd(p.totalPaid)!} format={usd} /> : "—"}</strong>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The burn action: anyone brings $100X, gets paid from the pot. */
export function BurnPanel() {
  const { publicKey } = useWallet();
  const { data: p, refresh } = usePoll(loadBurnPot, []);
  const bal = usePoll(() => (publicKey && p ? memeBalance(publicKey, p) : Promise.resolve(null)), [publicKey?.toBase58(), !!p]);
  const px = usePrices();
  const send = useSend();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  if (!p) return null;
  const raw = parseAmount(input, p.decimals);
  const paid = raw && raw > 0n ? p.quote(raw) : null;
  const over = raw !== null && raw > p.maxTokens;
  const tooMuch = raw !== null && bal.data !== null && bal.data !== undefined && raw > bal.data;
  return (
    <section className="panel" id="burn">
      <h2 className="meta">
        Burn · pot {usd(px.quoteUsd(p.pot))}
        <span className="right">
          <Tweet text={`${fmtAmount(p.totalBurned, p.decimals, 0)} $${MEME_SYMBOL} burned so far · ${usd(px.quoteUsd(p.pot))} pot pays +3% to burn more · 100x.broker`} path="/#burn" />
        </span>
      </h2>
      <p className="note">
        {p.venue === "curve" ? "curve" : "PumpSwap"} price +3% in SOL · 1/min · max 5% of pot · burned <b className="num">{fmtAmount(p.totalBurned, p.decimals, 0)}</b>
      </p>
      <div className="field">
        <label htmlFor="burn-amt">
          <span className="meta">Burn ${MEME_SYMBOL}</span>
          <span className="meta num">
            {bal.data !== null && bal.data !== undefined ? `balance ${fmtAmount(bal.data, p.decimals, 0)}` : "—"} · max {fmtAmount(p.maxTokens, p.decimals, 0)}
          </span>
        </label>
        <div className="input" data-invalid={over || tooMuch}>
          <input id="burn-amt" inputMode="decimal" placeholder="0" value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} />
          <span className="unit">${MEME_SYMBOL}</span>
        </div>
        <div className="chips">
          <button className="chip" disabled={busy} onClick={() => setInput(fmtAmount(p.maxTokens, p.decimals, 0).replace(/,/g, ""))}>
            max for this burn
          </button>
          {bal.data ? (
            <button className="chip" disabled={busy} onClick={() => setInput(fmtAmount(bal.data! < p.maxTokens ? bal.data! : p.maxTokens, p.decimals, 0).replace(/,/g, ""))}>
              all mine (capped)
            </button>
          ) : null}
        </div>
        {over && <span className="err">Over the 5% cap for one burn. Max right now: {fmtAmount(p.maxTokens, p.decimals, 0)}.</span>}
        {tooMuch && <span className="err">More than you hold.</span>}
      </div>
      <div className="quote">
        <div className="panel-row">
          <span className="muted">You get (SOL)</span>
          <span className="num">{paid ? `≈ ${px.sol(paid)} · ${usd(px.quoteUsd(paid))}` : "—"}</span>
        </div>
        <div className="panel-row">
          <span className="muted">Venue price</span>
          <span className="num">{usd(px.solPriceUsd(p.priceSol))} per ${MEME_SYMBOL}</span>
        </div>
        {p.cooldownLeft > 0 && <span className="err">Cooling down — {p.cooldownLeft}s until the next burn.</span>}
      </div>
      <button
        className="btn big"
        disabled={!publicKey || !raw || raw <= 0n || over || tooMuch || busy || p.cooldownLeft > 0}
        data-loading={busy}
        onClick={async () => {
          if (!raw) return;
          setBusy(true);
          const sig = await send(`Burn ${MEME_SYMBOL}`, async (payer) => buildBurnTx(payer, p, raw));
          setBusy(false);
          if (sig) {
            setInput("");
            refresh();
            bal.refresh();
          }
        }}
      >
        {!publicKey ? "Connect a wallet to burn" : `Burn ${input || "…"} $${MEME_SYMBOL} and get paid`}
      </button>
    </section>
  );
}
