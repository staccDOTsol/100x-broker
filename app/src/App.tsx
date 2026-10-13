import { useEffect, useMemo, useState } from "react";
import { NavLink, Route, Routes, Link, useLocation } from "react-router-dom";
import { captureRef } from "./lib/ref";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { ToastProvider } from "./components/Toasts";
import { PriceProvider } from "./hooks/price";
import { WalletButton } from "./components/bits";
import { CopyCA } from "./components/Coin";
import { BurnerWalletAdapter } from "./lib/burner";
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
          <div className="shell">
            <header className="masthead">
              <Link to="/" className="wordmark" aria-label="100x.broker home">
                <b>100x</b>
                <i>.broker</i>
              </Link>
              <div className="dateline">
                <span className="tag">Up or down · no liquidations · settles in SOL</span>
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
                <NavLink to="/winners" className="nav-winners">leaderboard</NavLink>
                <CopyCA small />
                <button className="theme" onClick={cycle} aria-label={`Theme: ${theme}`} title={`Theme: ${theme}`}>
                  {theme === "auto" ? "◐" : theme === "light" ? "☼" : "☾"}
                </button>
                <WalletButton />
              </div>
            </header>
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
          </div>
          </PriceProvider>
        </ToastProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
