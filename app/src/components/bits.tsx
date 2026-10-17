import type { WalletName } from "@solana/wallet-adapter-base";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { short, lev as fmtLev, usd } from "../lib/format";
import { usePrices, type Quote } from "../hooks/price";
import { humanError } from "../hooks";
import { conn } from "../lib/chain";
import { BURNER_NAME, type BurnerWalletAdapter } from "../lib/burner";
import { BurnerPanel } from "./BurnerPanel";
import { useToasts } from "./Toasts";
import { isMobileBrowser, MWA_NAME, walletBrowserLinks } from "../lib/mobile";
import { track } from "@vercel/analytics";

const OB_KEY = "onboarded";
const seenOnboarding = () => {
  try {
    return localStorage.getItem(OB_KEY) === "1";
  } catch {
    return true;
  }
};
const markOnboarded = () => {
  try {
    localStorage.setItem(OB_KEY, "1");
  } catch {}
};
const API_ENDPOINTS = ["/api", "/api/winners", "/api/markets", "/api/feed", "/api/arena"];

/**
 * "Whoa down there": the first thing a stranger sees instead of a wallet prompt. Two ways in that touch nothing of theirs —
 * a burner that lives in this browser, or the JSON API for their agents — and a quiet "connect anyway" for people who trust us.
 */
function Onboard({ step, addr, lamports, onBurner, onConnectAnyway, onDone, onClose }: {
  step: "pick" | "done";
  addr: string | null;
  lamports: bigint | null;
  onBurner: () => void;
  onConnectAnyway: () => void;
  onDone: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  const copy = () => {
    navigator.clipboard?.writeText("curl https://100x.broker/api");
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="ob-backdrop" onClick={onClose}>
      <div className="ob" role="dialog" aria-modal="true" aria-labelledby="ob-title" onClick={(e) => e.stopPropagation()}>
        <button className="ob-x" aria-label="Close" onClick={onClose}>
          ×
        </button>
        {step === "pick" ? (
          <>
            <div className="ob-body">
              <div className="meta ob-kicker">
                <span className="wob" aria-hidden>
                  🤠
                </span>
                hold your horses
              </div>
              <h2 id="ob-title" className="display">
                Whoa down there,
                <br />
                <span className="signal">cowboy / cowgirl!</span>
              </h2>
              <p>Don't want to connect your wallet to a strange site? Fair. You don't have to. Two ways in, zero risk to your main bag:</p>
            </div>
            <div className="ob-opts">
              <button className="ob-opt burner" onClick={onBurner}>
                <span className="display ob-n">1</span>
                <span>
                  <b className="display">Try with a burner</b>
                  <span className="sub">A throwaway wallet that lives in this browser. Put a few bucks in, play, sweep it out later.</span>
                </span>
                <span className="ob-tag">1 click</span>
              </button>
              <div className="ob-opt api">
                <span className="display ob-n">2</span>
                <div>
                  <b className="display">Point your agents at the API</b>
                  <span className="sub">Every board, feed and market is JSON. Let your bot do the clicking.</span>
                  <div className="ob-curl num">
                    <span className="muted">$</span> curl https://100x.broker/api
                    <button className={`chip ${copied ? "up" : ""}`} onClick={copy}>
                      {copied ? "copied" : "copy"}
                    </button>
                  </div>
                  <div className="ob-links num">
                    {API_ENDPOINTS.map((e) => (
                      <a key={e} href={e} target="_blank" rel="noreferrer">
                        {e}
                      </a>
                    ))}
                    <a href="/cli/README.md" target="_blank" rel="noreferrer">
                      CLI docs →
                    </a>
                  </div>
                </div>
              </div>
            </div>
            <div className="ob-foot">
              <span className="meta num">no liquidations · max loss = what you put in</span>
              <button className="linkish" onClick={onConnectAnyway}>
                Got a wallet you trust? Connect anyway →
              </button>
            </div>
          </>
        ) : (
          <div className="ob-body done">
            <div className="meta ob-kicker up">burner minted · lives in this browser</div>
            <h2 id="ob-title" className="display up">
              Saddle up.
              <br />
              You're in.
            </h2>
            <div className="ob-addr num">
              <span>{addr ? short(addr) : "…"}</span>
              <button
                className="chip"
                onClick={() => {
                  if (addr) navigator.clipboard?.writeText(addr);
                }}
              >
                copy address
              </button>
              <span className="muted right">{lamports === null ? "…" : `${(Number(lamports) / 1e9).toFixed(3)} SOL`}</span>
            </div>
            <ol className="ob-steps">
              <li>
                <b className="num">1</b> Send it a few bucks of SOL. Treat it like a casino chip.
              </li>
              <li>
                <b className="num">2</b> Pick a coin, pick UP or DOWN, ape.
              </li>
              <li>
                <b className="num">3</b> Sweep it back whenever. The key never leaves this browser.
              </li>
            </ol>
            <button className="btn up big ob-lfg display" onClick={onDone}>
              Start aping · LFG
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function WalletButton({ solo = false }: { solo?: boolean } = {}) {
  const { wallets, select, wallet, publicKey, connecting, connect, disconnect } = useWallet();
  const toasts = useToasts();
  const [open, setOpen] = useState(false);
  // set by "try with a burner" (or picking Burner in the list): connect once the provider has swapped adapters, then open the panel
  const [wantBurner, setWantBurner] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  const [ob, setOb] = useState<"pick" | "done" | null>(null);
  const [obLamports, setObLamports] = useState<bigint | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // first visit, no wallet: the "whoa" card shows itself once, a beat after the page settles
  useEffect(() => {
    if (solo || publicKey || seenOnboarding()) return;
    const t = setTimeout(() => setOb((o) => o ?? "pick"), 2500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  // A wallet that never settles leaves the header as a spinner and blocks the next click.
  useLayoutEffect(() => {
    for (const w of wallets) {
      if (w.adapter.name !== BURNER_NAME) continue; // extension wallets go through the provider's own connect
      const adapter = w.adapter as { connect: () => Promise<void>; __bounded?: boolean };
      if (adapter.__bounded) continue;
      adapter.__bounded = true;
      const call = adapter.connect.bind(adapter);
      adapter.connect = () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
          call(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Wallet didn't answer. Open it and try again.")), 15_000);
          }),
        ]).finally(() => clearTimeout(timer));
      };
    }
  }, [wallets]);
  // select() only changes the provider's state. Connect the adapter itself once it is current, after the
  // provider has subscribed (parent effects run first). The provider's connect() no-ops while a previous
  // attempt is still marked connecting, which is how the button gets stuck on a spinner.
  const toastRef = useRef(toasts);
  toastRef.current = toasts;
  useEffect(() => {
    if (!pending || wallet?.adapter.name !== pending) return;
    if (publicKey) {
      setPending(null);
      setWantBurner(false);
      if (pending === BURNER_NAME) {
        if (ob === "pick") setOb("done");
        else setOpen(true);
      }
      return;
    }
    // The provider (autoConnect) connects a wallet the user just picked, with its listener already attached; connecting it
    // here first made the burner emit `connect` before anyone listened, and the button never left "Connect". Only step in
    // when nothing has happened shortly (re-picking a wallet that is selected but not connected).
    const t = setTimeout(() => {
      if (connecting) return;
      connect().catch((e: unknown) => {
        setPending(null);
        setWantBurner(false);
        toastRef.current.push({ s: "err", title: "Wallet", body: humanError(e) });
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [pending, pick, wallet?.adapter, publicKey, ob, connecting, connect]);
  // the "saddle up" step shows the fresh burner's balance
  useEffect(() => {
    if (ob !== "done" || !publicKey) return;
    let alive = true;
    conn.getBalance(publicKey, "confirmed").then((n) => alive && setObLamports(BigInt(n))).catch(() => alive && setObLamports(0n));
    return () => {
      alive = false;
    };
  }, [ob, publicKey]);
  const choose = (name: string) => {
    setOpen(false);
    if (name !== BURNER_NAME) {
      // Phantom & co: the standard flow. select() + the provider's autoConnect connects a wallet the user picked, with the
      // provider already listening for its connect event. Re-picking the selected-but-disconnected wallet retries.
      if (wallet?.adapter.name === name && !publicKey) connect().catch((e) => toasts.push({ s: "err", title: "Wallet", body: humanError(e) }));
      else select(name as WalletName);
      return;
    }
    markOnboarded();
    setWantBurner(true);
    setPending(name);
    setPick((n) => n + 1);
    if (wallet?.adapter.name !== name) select(name as WalletName);
  };
  const tryBurner = () => choose(BURNER_NAME);
  const closeOb = () => {
    markOnboarded();
    setOb(null);
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
          data-loading={!!pending && !publicKey && wantBurner}
          title="A throwaway wallet that lives in this browser. Put a few bucks in, play, sweep it out later."
          onClick={tryBurner}
        >
          try with a burner
        </button>
      )}
      <button
        className={publicKey ? "btn ghost" : "btn signal"}
        data-loading={connecting && !wantBurner}
        aria-expanded={open}
        aria-haspopup={isBurner ? "dialog" : "menu"}
        onClick={() => (!solo && !publicKey && !seenOnboarding() ? setOb("pick") : setOpen((o) => !o))}
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
                  onClick={() => choose(w.adapter.name)}
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
      {ob && (
        <Onboard
          step={ob}
          addr={publicKey?.toBase58() ?? null}
          lamports={obLamports}
          onBurner={tryBurner}
          onConnectAnyway={() => {
            closeOb();
            setOpen(true);
          }}
          onDone={() => {
            closeOb();
            setOpen(true); // the burner panel: fund it, copy it, sweep it
          }}
          onClose={closeOb}
        />
      )}
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
  if (series.length < 2) return <div className="skeleton" style={{ height: 300 }} />;
  const w = 600;
  const h = 300;
  const pad = 8;
  const prices = series.map((p) => p.price).concat(twap ?? [], lastTwap);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  // a flat window (no tick yet) would land on the bottom edge and vanish; give it ±0.5% of headroom so the line sits mid-chart
  if (hi - lo <= Math.abs(hi) * 1e-9) {
    const mid = hi || 1;
    lo = mid * 0.995;
    hi = mid * 1.005;
  }
  const span = hi - lo || 1;
  const t0 = series[0].ts;
  const t1 = series[series.length - 1].ts;
  const x = (ts: number) => pad + ((ts - t0) / Math.max(1, t1 - t0)) * (w - pad * 2);
  const y = (p: number) => h - pad - ((p - lo) / span) * (h - pad * 2);
  const d = series.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ts).toFixed(1)},${y(p.price).toFixed(1)}`).join("");
  const last = series[series.length - 1];
  const now = twap ?? last.price;
  const dir = now > lastTwap * (1 + 1e-9) ? "up" : now < lastTwap * (1 - 1e-9) ? "down" : "flat";
  const mins = Math.round((t1 - t0) / 60);
  return (
    <div className={`chart big ${dir}`}>
      <svg key={`${series.length}:${last.ts}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="Oracle price, last hour" className="spark">
        <defs>
          <linearGradient id="ochart" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path className="area" d={`${d}L${x(last.ts).toFixed(1)},${h}L${x(t0).toFixed(1)},${h}Z`} fill="url(#ochart)" />
        <line x1={pad} x2={w - pad} y1={y(lastTwap)} y2={y(lastTwap)} className="ref" />
        {twap !== null && <line className="twap" x1={pad} x2={w - pad} y1={y(twap)} y2={y(twap)} />}
        <path className="line" d={d} pathLength={1} />
        <circle className="dot" cx={x(last.ts)} cy={y(last.price)} r={3} />
        <circle className="halo" cx={x(last.ts)} cy={y(last.price)} r={3} />
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
