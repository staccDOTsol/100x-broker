import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Route, Routes, Link, useLocation } from "react-router-dom";
import { captureRef } from "./lib/ref";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { ToastProvider, useToasts, type Toast } from "./components/Toasts";
import { PriceProvider, usePrices } from "./hooks/price";
import { WalletButton } from "./components/bits";
import { CopyCA } from "./components/Coin";
import { Tape } from "./components/Live";
import { Flash, useNow } from "./components/Pulse";
import { BurnerWalletAdapter } from "./lib/burner";
import { usePoll } from "./hooks";
import { fetchActive, fetchFeed, fetchWinners } from "./lib/feed";
import { short, usd } from "./lib/format";
import Board from "./pages/Board";
import MarketPage from "./pages/MarketPage";
import NewMarket from "./pages/NewMarket";
import PortfolioPage from "./pages/Portfolio";
import YieldPage from "./pages/Yield";
import VaultPage from "./pages/VaultPage";
import MetaPage from "./pages/Meta";
import ArenaPage from "./pages/Arena";
import WinnersPage from "./pages/Winners";
import { NETWORK, RPC_URL } from "./config";
import { NguHero } from "./components/NguHero";
import NguPage from "./pages/Ngu";

type Theme = "auto" | "light" | "dark";
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("theme") as Theme) || "auto";
    } catch {
      return "auto";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* private mode */
    }
  }, [theme]);
  const order: Theme[] = ["auto", "light", "dark"];
  return [theme, () => setTheme((t) => order[(order.indexOf(t) + 1) % order.length])];
}

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (s: number) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;

/** Masthead pills: wallets trading today (real, /api/leaders?active=24) and the live race clock (/api/winners). */
function Pills() {
  const active = usePoll(() => fetchActive(24), [], 60_000);
  const winners = usePoll(fetchWinners, [], 60_000);
  const now = useNow();
  const live = winners.data?.race?.live ?? null;
  return (
    <>
      {active.data && active.data.length > 0 && (
        <Link to="/winners" className="pill live-pill" title="wallets that traded in the last 24h">
          <span className="live-dot" aria-hidden />
          LIVE · <Flash watch={active.data.length}>{active.data.length}</Flash> degens · 24h
        </Link>
      )}
      {live && live.end > now && (
        <Link to="/winners" className={`pill race-pill ${live.end - now < 3600 ? "hot" : ""}`}>
          <span className="wob" aria-hidden>
            🥇
          </span>
          {live.prize_sol} SOL race · <span className="num">{clock(live.end - now)}</span>
        </Link>
      )}
    </>
  );
}

const HYPE_KEY = "hype";
export const hypeOn = () => {
  try {
    return localStorage.getItem(HYPE_KEY) !== "off";
  } catch {
    return true;
  }
};
const heldStr = (s: number) => (s < 60 ? `${Math.max(1, Math.round(s))}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

/**
 * The live tape, thrown at you: every real ape / bail / cash-out from the feed and every win that lands becomes a hype toast
 * (big display headline, mono subline), site-wide. Never on first load — only what arrived since the last poll. Your own moves
 * are skipped here (useSend already narrates them). Paced to one every ~2.2s so a burst reads as a drumroll, not a wall.
 */
function LiveToasts() {
  const feed = usePoll(() => fetchFeed(), [], 6_000);
  const winners = usePoll(fetchWinners, [], 20_000);
  const px = usePrices();
  const toasts = useToasts();
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const seenEv = useRef<Set<string> | null>(null);
  const seenWin = useRef<Set<string> | null>(null);
  const queue = useRef<Omit<Toast, "id">[]>([]);
  const pump = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enqueue = (t: Omit<Toast, "id">) => {
    if (!hypeOn()) return;
    queue.current.push(t);
    if (queue.current.length > 4) queue.current = queue.current.slice(-4);
    if (pump.current) return;
    const tick = () => {
      const n = queue.current.shift();
      if (!n) {
        pump.current = null;
        return;
      }
      toasts.push(n);
      pump.current = setTimeout(tick, 2200);
    };
    tick();
  };
  useEffect(() => () => { if (pump.current) clearTimeout(pump.current); }, []);
  // trades, from /api/feed
  useEffect(() => {
    const evs = feed.data;
    if (!evs) return;
    if (!seenEv.current) {
      seenEv.current = new Set(evs.map((e) => e.sig));
      return;
    }
    for (const e of [...evs].reverse()) {
      if (seenEv.current.has(e.sig)) continue;
      seenEv.current.add(e.sig);
      if (e.actor === me) continue;
      if (e.kind !== "buy" && e.kind !== "sell" && e.kind !== "redeem" && e.kind !== "listed") continue;
      const usdv = e.quote ? px.quoteUsd(BigInt(e.quote)) : null;
      if (e.kind !== "listed" && (usdv === null || usdv < 5)) continue;
      const side = e.side === 1 ? "DOWN" : "UP";
      const tone = e.side === 1 ? "down" : "up";
      const money = usdv !== null && usdv > 0 ? usd(usdv) : "";
      if (e.kind === "buy") enqueue({ s: "ok", tone, big: `Aped ${side} · $${e.ticker}`, title: `${short(e.actor)} · ${money}`, body: "LFG", sig: e.sig });
      else if (e.kind === "sell") enqueue({ s: "ok", tone, big: `Bailed ${side} · $${e.ticker}`, title: `${short(e.actor)} · ${money}`, sig: e.sig });
      else if (e.kind === "redeem") enqueue({ s: "ok", tone, big: `Cashed out ${side} · $${e.ticker}`, title: `${short(e.actor)} · ${money}`, sig: e.sig });
      else enqueue({ s: "ok", tone: "signal", big: `New board · $${e.ticker}`, title: `${short(e.actor)} listed it`, body: "first in gets the cheap side", sig: e.sig });
    }
  }, [feed.data, me, px, toasts]);
  // wins, from /api/winners
  useEffect(() => {
    const wins = winners.data?.wins;
    if (!wins) return;
    if (!seenWin.current) {
      seenWin.current = new Set(wins.map((w) => w.sig));
      return;
    }
    for (const w of wins) {
      if (seenWin.current.has(w.sig)) continue;
      seenWin.current.add(w.sig);
      if (w.wallet === me) continue;
      const m = w.ret + 1;
      // a multiplier needs a real cost basis; transferred-in tokens have ~0 and would print nonsense — lead with the SOL instead
      const big = w.cost_sol >= 0.005 ? `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}× on $${w.ticker}` : `+${w.gain_sol.toFixed(3)} SOL on $${w.ticker}`;
      enqueue({
        s: "ok",
        tone: w.side === 1 ? "down" : "up",
        big,
        title: `${short(w.wallet)} ${w.kind === "exit" ? (w.side === 1 ? "DOWN" : "UP") : "vault"} · +${w.gain_sol.toFixed(3)} SOL in ${heldStr(w.hold_s)}`,
        sig: w.sig,
        ttl: 5200,
      });
    }
  }, [winners.data, me, toasts]);
  return null;
}

const ENDPOINTS = ["/api", "/api/winners", "/api/feed", "/api/markets", "/api/leaders", "/api/arena", "/api/price", "/api/meta"];

export default function App() {
  const [theme, cycle] = useTheme();
  const loc = useLocation();
  useEffect(() => captureRef(loc.search), [loc.search]);
  // wallet-standard finds installed extensions on its own; the burner is the one wallet the site ships
  const wallets = useMemo(() => [new BurnerWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <ToastProvider>
          <PriceProvider>
            <Tape />
            <div className="shell">
              <header className="masthead">
                <Link to="/" className="wordmark" aria-label="100x.broker home">
                  <b>100x</b>
                  <i>.broker</i>
                </Link>
                <div className="dateline">
                  <Pills />
                  {NETWORK === "fork" && (
                    <span className="netbadge" data-net="fork">
                      local fork
                    </span>
                  )}
                </div>
                <div className="nav">
                  <NavLink to="/" end>
                    Board
                  </NavLink>
                  <NavLink to="/new">List</NavLink>
                  <NavLink to="/me">Bag</NavLink>
                  <NavLink to="/yield" className="nav-yield">
                    Yield
                  </NavLink>
                  <NavLink to="/meta">spicy</NavLink>
                  <NavLink to="/arena">arena</NavLink>
                  <NavLink to="/winners" className="nav-winners">
                    leaderboard
                  </NavLink>
                  <CopyCA small />
                  <button className="theme" onClick={cycle} aria-label={`Theme: ${theme}`} title={`Theme: ${theme}`}>
                    {theme === "auto" ? "◐" : theme === "light" ? "☼" : "☾"}
                  </button>
                  <WalletButton />
                </div>
              </header>
              <div className="crumb meta">
                <span>100x.broker{loc.pathname === "/" ? "" : loc.pathname}</span>
                <span>Up or down · no liquidations · settles in SOL</span>
              </div>
              <NguHero />
              <main>
                <Routes>
                  <Route path="/" element={<Board />} />
                  <Route path="/m/:key" element={<MarketPage />} />
                  <Route path="/new" element={<NewMarket />} />
                  <Route path="/me" element={<PortfolioPage />} />
                  <Route path="/p/:wallet" element={<PortfolioPage />} />
                  <Route path="/yield" element={<YieldPage />} />
                  <Route path="/yield/:vault" element={<VaultPage />} />
                  <Route path="/meta" element={<MetaPage />} />
                  <Route path="/arena" element={<ArenaPage />} />
                  <Route path="/winners" element={<WinnersPage />} />
                  <Route path="/ngu" element={<NguPage />} />
                  <Route
                    path="*"
                    element={
                      <div className="empty">
                        <div className="display">Off the board.</div>
                        <p>Nothing here. Not even a rug.</p>
                        <Link className="btn ghost" to="/">
                          Back to the board
                        </Link>
                      </div>
                    }
                  />
                </Routes>
              </main>
              <footer className="agents">
                <span>Agents · every board is JSON:</span>
                {ENDPOINTS.map((e) => (
                  <a key={e} href={e}>
                    {e}
                  </a>
                ))}
                <a href="/cli/README.md">/cli</a>
                <a href="/cli/NASH.md">/cli/nash</a>
              </footer>
            </div>
            <LiveToasts />
          </PriceProvider>
        </ToastProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
