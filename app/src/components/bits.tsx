import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { short, lev as fmtLev, usd } from "../lib/format";
import { usePrices, type Quote } from "../hooks/price";
import { humanError } from "../hooks";
import { BURNER_NAME, type BurnerWalletAdapter } from "../lib/burner";
import { BurnerPanel } from "./BurnerPanel";
import { useToasts } from "./Toasts";
import { isMobileBrowser, MWA_NAME, walletBrowserLinks } from "../lib/mobile";
import { track } from "@vercel/analytics";

export function WalletButton() {
  const { wallets, select, wallet, publicKey, connecting, connect, disconnect } = useWallet();
  const toasts = useToasts();
  const [open, setOpen] = useState(false);
  // set by "try with a burner" (or picking Burner in the list): connect once the provider has swapped adapters, then open the panel
  const [wantBurner, setWantBurner] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  const isBurner = wallet?.adapter.name === BURNER_NAME;
  // funnel: a wallet actually connected (and which kind)
  useEffect(() => {
    if (publicKey) track("connect", { wallet: wallet?.adapter.name ?? "?" });
  }, [publicKey, wallet]);
  const hasBurner = wallets.some((w) => w.adapter.name === BURNER_NAME);
  // select() only changes the provider's state; the connect has to wait for the render where `wallet` is the burner
  useEffect(() => {
    if (!wantBurner || !isBurner) return;
    if (publicKey) {
      setWantBurner(false);
      setOpen(true); // the fund-it line should be the first thing they see
      return;
    }
    // The provider auto-connects a freshly selected adapter from its own effect, which runs AFTER ours (parent effects run
    // last). Connecting here first makes the adapter emit `connect` before the provider is listening: key minted, header
    // still says Connect. So wait for the provider; only step in if nothing has happened shortly.
    const t = setTimeout(() => {
      if (connecting) return;
      connect().catch((e) => {
        setWantBurner(false);
        toasts.push({ s: "err", title: "Burner", body: humanError(e) });
      });
    }, 1200);
    return () => clearTimeout(t);
  }, [wantBurner, isBurner, publicKey, connecting, connect, toasts]);
  const tryBurner = () => {
    setOpen(false);
    setWantBurner(true);
    select(BURNER_NAME);
  };
  const ready = wallets.filter((w) => w.readyState === "Installed" || w.readyState === "Loadable");
  // on a phone with no wallet injected, the only way in is through the wallet app's own browser
  const handoff = isMobileBrowser() && !ready.some((w) => w.adapter.name !== BURNER_NAME && w.adapter.name !== MWA_NAME);
  return (
    <div className="wallet" ref={ref}>
      {!publicKey && hasBurner && (
        <button
          type="button"
          className="btn ghost small"
          data-loading={connecting && wantBurner}
          title="A throwaway wallet that lives in this browser. Put a few bucks in, play, sweep it out later."
          onClick={tryBurner}
        >
          try with a burner
        </button>
      )}
      <button
        className={publicKey ? "btn ghost" : "btn"}
        data-loading={connecting && !wantBurner}
        aria-expanded={open}
        aria-haspopup={isBurner ? "dialog" : "menu"}
        onClick={() => setOpen((o) => !o)}
      >
        {publicKey ? (
          <>
            <span className="num">{short(publicKey.toBase58())}</span>
            {isBurner && <span className="meta">burner</span>}
          </>
        ) : (
          "Connect"
        )}
      </button>
      {open && isBurner && publicKey && wallet ? (
        <BurnerPanel
          adapter={wallet.adapter as BurnerWalletAdapter}
          onDisconnect={() => {
            disconnect();
            setOpen(false);
          }}
        />
      ) : open ? (
        <div className="menu" role="menu">
          {publicKey ? (
            <>
              <div className="none">{wallet?.adapter.name}</div>
              <button
                role="menuitem"
                onClick={() => {
                  navigator.clipboard?.writeText(publicKey.toBase58());
                  setOpen(false);
                }}
              >
                Copy address
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  disconnect();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            </>
          ) : (
            <>
              {ready.map((w) => (
                <button
                  role="menuitem"
                  key={w.adapter.name}
                  onClick={() => {
                    if (w.adapter.name === BURNER_NAME) setWantBurner(true);
                    select(w.adapter.name);
                    setOpen(false);
                  }}
                >
                  <img src={w.adapter.icon} alt="" />
                  {w.adapter.name}
                </button>
              ))}
              {handoff ? (
                <>
                  <div className="none">Phone browsers can't see wallet apps. Open this page inside your wallet instead:</div>
                  {walletBrowserLinks().map((l) => (
                    <a
                      role="menuitem"
                      key={l.name}
                      href={l.href}
                      rel="noopener"
                      onClick={() => {
                        track("open_in_wallet", { wallet: l.name });
                        setOpen(false);
                      }}
                    >
                      Open in {l.name}
                    </a>
                  ))}
                </>
              ) : ready.length ? null : (
                <div className="none">No Solana wallet found in this browser.</div>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The UP vs DOWN vault split — the market's tug of war. */
export function Tug({
  up,
  down,
  levUp,
  levDown,
  size = "sm",
}: {
  up: bigint;
  down: bigint;
  levUp: number;
  levDown: number;
  size?: "sm" | "lg";
}) {
  const px = usePrices();
  const empty = up + down === 0n;
  const total = Number(up + down) || 1;
  const u = Number(up) / total;
  return (
    <div className={`tug ${size === "lg" ? "lg" : ""}`}>
      <div
        className="tug-bar"
        role="img"
        aria-label={empty ? "Vaults empty" : `UP vault ${(u * 100).toFixed(0)} percent, DOWN vault ${(100 - u * 100).toFixed(0)} percent`}
      >
        {empty ? (
          <span className="n" style={{ flexGrow: 1 }} />
        ) : (
          <>
            <span className="u" style={{ flexGrow: Math.max(u, 0.002) }} />
            <span className="seam" />
            <span className="d" style={{ flexGrow: Math.max(1 - u, 0.002) }} />
          </>
        )}
      </div>
      <div className="tug-legend num">
        <span className="up">
          {usd(px.quoteUsd(up))} · {fmtLev(levUp)}
        </span>
        <span className="down">
          {fmtLev(levDown)} · {usd(px.quoteUsd(down))}
        </span>
      </div>
    </div>
  );
}

/** Spot steps between stored observations (thin) with the current TWAP (heavy) and the last-rebalance TWAP (dashed). */
export function OracleChart({
  series,
  twap,
  lastTwap,
  fmt,
}: {
  series: { ts: number; price: number }[];
  twap: number | null;
  lastTwap: number;
  fmt: (p: number) => string;
}) {
  if (series.length < 2) return <div className="skeleton" style={{ height: 140 }} />;
  const w = 600;
  const h = 140;
  const pad = 6;
  const prices = series.map((p) => p.price).concat(twap ?? [], lastTwap);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = hi - lo || hi * 1e-6 || 1;
  const t0 = series[0].ts;
  const t1 = series[series.length - 1].ts;
  const x = (ts: number) => pad + ((ts - t0) / Math.max(1, t1 - t0)) * (w - pad * 2);
  const y = (p: number) => h - pad - ((p - lo) / span) * (h - pad * 2);
  let d = "";
  series.forEach((p, i) => {
    d += i === 0 ? `M${x(p.ts)},${y(p.price)}` : `H${x(p.ts)}V${y(p.price)}`;
  });
  const mins = Math.round((t1 - t0) / 60);
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="Oracle price, last hour">
        <line x1={pad} x2={w - pad} y1={y(lastTwap)} y2={y(lastTwap)} className="ref" />
        <path className="spot" d={d} />
        {twap !== null && <line className="twap" x1={pad} x2={w - pad} y1={y(twap)} y2={y(twap)} />}
      </svg>
      <span className="ax hi num">{fmt(hi)}</span>
      <span className="ax lo num">{fmt(lo)}</span>
      <span className="ax t0 meta">{mins} min ago</span>
      <span className="ax t1 meta">now</span>
    </div>
  );
}


/** An oracle price plus the ⇄ that flips every price on the site between USD-per-coin and coins-per-quote. */
export function OraclePrice({ x, quote, ticker, className = "" }: { x: number; quote: Quote; ticker: string; className?: string }) {
  const px = usePrices();
  return (
    <span className={`opx ${className}`}>
      {px.oracleFmt(x, quote, ticker)}
      <button
        className="flip"
        type="button"
        title={px.inverted ? "Show in USD" : `Flip: ${ticker} per ${quote}`}
        aria-label="Flip pricing"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          px.toggleInverted();
        }}
      >
        ⇄
      </button>
    </span>
  );
}
