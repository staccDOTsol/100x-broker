import { useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, Link, useLocation } from "react-router-dom";
import { captureRef } from "./lib/ref";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { ToastProvider, useToasts, type Toast } from "./components/Toasts";
import { PriceProvider, usePrices } from "./hooks/price";
import { WalletButton } from "./components/bits";
import { CopyCA } from "./components/Coin";
import { carriedCat, withCat } from "./components/CatFilter";
import { Tape } from "./components/Live";
import { Flash, useNow } from "./components/Pulse";
import { BurnerWalletAdapter } from "./lib/burner";
import { usePoll } from "./hooks";
import { fetchActive, fetchFeed, fetchWinners } from "./lib/feed";
import { short, usd } from "./lib/format";
import Board from "./pages/Board";
import MarketPage from "./pages/MarketPage";
import NewMarket from "./pages/NewMarket";
import Launch from "./pages/Launch";
import PortfolioPage from "./pages/Portfolio";
import VaultRedirect from "./pages/VaultRedirect";
import MetaPage from "./pages/Meta";
import ArenaPage from "./pages/Arena";
import WinnersPage from "./pages/Winners";
import SwapPage from "./pages/Swap";
import SwapBagPage from "./pages/SwapBag";
import WrapPage from "./pages/Wrap";
import WarPage, { NewWarPage, WarLobby, WatchPage } from "./pages/War";
import WarAction from "./pages/WarAction";
import { HERO_MARKET, NETWORK, RPC_URL } from "./config";
import { Icon } from "./components/Icons";

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

const LAST_MARKET = "lastMarket";
const lastMarket = () => {
  try {
    return localStorage.getItem(LAST_MARKET) ?? HERO_MARKET;
  } catch {
    return HERO_MARKET;
  }
};

/** The slim side rail: every section as an icon (labels show on hover and on narrow screens, where it becomes a scroll row). */
function RailNav({ cat, trade }: { cat: ReturnType<typeof carriedCat>; trade: string }) {
  const loc = useLocation();
  const items: { to: string; label: string; icon: () => JSX.Element; end?: boolean; on?: boolean }[] = [
    { to: withCat("/", cat), label: "Markets", icon: Icon.markets, end: true },
    { to: trade, label: "Trade", icon: Icon.trade, on: loc.pathname.startsWith("/m/") },
    { to: withCat("/new", cat), label: "New market", icon: Icon.plus },
    { to: "/launch", label: "Launch", icon: Icon.launch },
    { to: withCat("/me", cat), label: "Bag", icon: Icon.bag },
    { to: "/meta", label: "Spicy", icon: Icon.spicy },
    { to: "/wrap", label: "Wrap", icon: Icon.wrap },
    { to: withCat("/arena", cat), label: "Arena", icon: Icon.arena },
    { to: withCat("/winners", cat), label: "Leaderboard", icon: Icon.trophy },
  ];
  return (
    <nav className="side-rail" aria-label="Sections">
      {items.map((it) => (
        <NavLink
          key={it.label}
          to={it.to}
          end={it.end}
          className={({ isActive }) => (isActive || it.on ? "active" : "")}
          aria-current={it.on ? "page" : undefined}
          title={it.label}
        >
          <it.icon />
          <span>{it.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

const ENDPOINTS = ["/api", "/api/winners", "/api/feed", "/api/markets", "/api/leaders", "/api/arena", "/api/price", "/api/meta"];

export default function App() {
  const [theme, cycle] = useTheme();
  const loc = useLocation();
  useEffect(() => captureRef(loc.search), [loc.search]);
  // "Trade" in the nav reopens the last market that loaded (MarketPage writes it), the hero market before that
  const last = lastMarket();
  const trade = last ? `/m/${last}` : "/";
  // Memes · Majors · Stonks rides along the list pages' nav links (this page's `cat`, else the remembered one)
  const cat = carriedCat(loc.search);
  // lastbidwins.fun: the Stars War host — the same app, the war at "/", the swap-style bare masthead
  const onWar = typeof window !== "undefined" && /(^|\.)lastbidwins\.fun$/.test(window.location.hostname);
  const onSwap = onWar || (typeof window !== "undefined" && window.location.hostname.split(".")[0] === "swap");
  // ?embed=1: the swap widget inside someone else's page (public/widget.js) — the card and the wallet, no tape, no masthead
  const embed = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("embed") === "1";
  // wallet-standard finds installed extensions on its own; the burner is the one wallet the site ships
  const wallets = useMemo(() => [new BurnerWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      {/* autoConnect: the provider connects a wallet the user picks (and reconnects the last one). Removing it left
          Phantom spinning: the custom connect fired before the provider listened. */}
      <WalletProvider wallets={wallets} autoConnect>
        <ToastProvider>
          <PriceProvider>
            {/* the main site is a trading terminal now: live trades float on the charts and fill the trade tables, so no tape on top */}
            {onSwap && !embed && loc.pathname !== "/a" && loc.pathname !== "/play" && !loc.pathname.startsWith("/play/") && <Tape />}
            {!onSwap && !embed && <RailNav cat={cat} trade={trade} />}
            <div className={loc.pathname === "/a" ? "shell war-bare" : embed ? "shell swap-shell swap-embed" : onSwap ? "shell swap-shell" : "shell term"}>
              {onWar && <p className="not-gambling">it's not gambling; the winner is well-known at all times, there is no rng</p>}
              <header className="masthead">
                {onWar ? (
                  <Link to="/" className="wordmark" aria-label="lastbidwins.fun">
                    <b>lastbidwins</b>
                    <i>.fun</i>
                  </Link>
                ) : onSwap ? (
                  <a href="https://100x.broker" className="wordmark" aria-label="100x.broker">
                    <b>swap</b>
                  </a>
                ) : (
                  <Link to="/" className="wordmark" aria-label="100x.broker home">
                    <b>100x</b>
                    <i>.broker</i>
                  </Link>
                )}
                {!onSwap && (
                  <div className="dateline">
                    <Pills />
                    {NETWORK === "fork" && (
                      <span className="netbadge" data-net="fork">
                        local fork
                      </span>
                    )}
                  </div>
                )}
                <div className="nav">
                  {onWar ? (
                    <>
                      <NavLink to="/" end className="swap-nav">
                        Gold run
                      </NavLink>
                      <NavLink to="/w" end className="swap-nav">
                        All wars
                      </NavLink>
                      <WalletButton solo />
                    </>
                  ) : onSwap || embed ? (
                    <>
                      <NavLink to={`/${loc.search}`} end className="swap-nav">
                        Swap
                      </NavLink>
                      <NavLink to={`/bag${loc.search}`} className="swap-nav swap-nav-bag">
                        Bag
                      </NavLink>
                      <WalletButton solo />
                    </>
                  ) : (
                    <>
                      <span className="top-tabs">
                        <NavLink to={withCat("/", cat)} end>
                          Markets
                        </NavLink>
                        <NavLink to={trade} className={loc.pathname.startsWith("/m/") ? "active" : undefined} aria-current={loc.pathname.startsWith("/m/") ? "page" : undefined}>
                          Trade
                        </NavLink>
                        <NavLink to={withCat("/winners", cat)} className="nav-winners">
                          Leaderboard
                        </NavLink>
                      </span>
                      <NavLink to={withCat("/new", cat)} className="btn signal small spawn" title="Anyone can list a market on any coin">
                        + New<span className="hide-xs">{"\u00a0"}market</span>
                      </NavLink>
                      <CopyCA small />
                      <button className="theme" onClick={cycle} aria-label={`Theme: ${theme}`} title={`Theme: ${theme}`}>
                        {theme === "auto" ? "◐" : theme === "light" ? "☼" : "☾"}
                      </button>
                      <WalletButton />
                    </>
                  )}
                </div>
              </header>
              <main>
                <Routes>
                  <Route path="/" element={onWar ? <WarPage /> : onSwap || embed ? <SwapPage /> : <Board />} />
                  <Route path="/a" element={<WarAction />} />
                  <Route path="/w" element={<WarLobby />} />
                  <Route path="/w/new" element={<NewWarPage />} />
                  <Route path="/w/:id" element={<WarPage />} />
                  <Route path="/play" element={<WatchPage />} />
                  <Route path="/play/:mint" element={<WatchPage />} />
                  <Route path="/swap" element={<SwapPage />} />
                  <Route path="/bag" element={<SwapBagPage />} />
                  <Route path="/m/:key" element={<MarketPage />} />
                  <Route path="/new" element={<NewMarket />} />
                  <Route path="/launch" element={<Launch />} />
                  <Route path="/me" element={<PortfolioPage />} />
                  <Route path="/p/:wallet" element={<PortfolioPage />} />
                  {/* yield lives on the market pages now (?side=yield); the old routes bounce there */}
                  <Route path="/yield" element={<Navigate to={{ pathname: "/", search: loc.search }} replace />} />
                  <Route path="/yield/:vault" element={<VaultRedirect />} />
                  <Route path="/meta" element={<MetaPage />} />
                  <Route path="/arena" element={<ArenaPage />} />
                  <Route path="/winners" element={<WinnersPage />} />
                  <Route path="/wrap" element={<WrapPage />} />
                  <Route path="/wrap/:mint" element={<WrapPage />} />
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
              {!onSwap && (
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
              )}
            </div>
            <LiveToasts />
          </PriceProvider>
        </ToastProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
