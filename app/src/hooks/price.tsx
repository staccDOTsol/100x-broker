import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { usePoll } from "../hooks";
import { poolState } from "../lib/zap";
import { price, usdPrice } from "../lib/format";

export type Quote = "SOL" | "USDC" | "USDT" | "?";
export type Prices = { solUsd: number | null; rate: number | null; inverted: boolean; toggleInverted: () => void };
const Ctx = createContext<Prices>({ solUsd: null, rate: null, inverted: false, toggleInverted: () => {} });

async function fetchSolUsd(): Promise<number> {
  const r = await fetch("/api/price");
  if (!r.ok) throw new Error("price");
  return (await r.json()).solUsd as number;
}

export function PriceProvider({ children }: { children: ReactNode }) {
  const sol = usePoll(fetchSolUsd, []);
  const pool = usePoll(poolState, []);
  // "inverted" flips every oracle price from USD-per-coin to coins-per-quote (USDC/SOL market reads as SOL's price in USDC)
  const [inverted, setInverted] = useState(() => {
    try {
      return localStorage.getItem("inv") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("inv", inverted ? "1" : "0");
    } catch {
      /* private mode */
    }
  }, [inverted]);
  return (
    <Ctx.Provider value={{ solUsd: sol.data ?? null, rate: pool.data?.rate ?? null, inverted, toggleInverted: () => setInverted((v) => !v) }}>
      {children}
    </Ctx.Provider>
  );
}

export function usePrices() {
  const p = useContext(Ctx);
  /** oracle price in its quote token -> USD */
  const oracleUsd = (x: number, quote: Quote) => (quote === "SOL" ? (p.solUsd ? x * p.solUsd : null) : quote === "?" ? null : x);
  return {
    ...p,
    /** r-fstacc amount (raw 1e9) -> USD */
    quoteUsd: (raw: bigint) => (p.solUsd && p.rate ? (Number(raw) / 1e9) * p.rate * p.solUsd : null),
    /** price in r-fstacc per token -> USD */
    priceUsd: (x: number) => (p.solUsd && p.rate ? x * p.rate * p.solUsd : null),
    /** price in SOL -> USD */
    solPriceUsd: (x: number) => (p.solUsd ? x * p.solUsd : null),
    oracleUsd,
    /** the oracle price the way the user asked to read it: USD per coin, or flipped to coins per unit of the quote */
    oracleFmt: (x: number, quote: Quote, ticker: string) =>
      p.inverted ? (x > 0 ? `${price(1 / x)} ${ticker}/${quote}` : "—") : usdPrice(oracleUsd(x, quote)),
    lamportsUsd: (raw: bigint) => (p.solUsd ? (Number(raw) / 1e9) * p.solUsd : null),
    /** r-fstacc raw -> SOL (number) */
    quoteSol: (raw: bigint) => (p.rate ? (Number(raw) / 1e9) * p.rate : null),
    /** r-fstacc raw -> SOL string */
    sol: (raw: bigint, dp = 4) => (p.rate ? `${((Number(raw) / 1e9) * p.rate).toFixed(dp)} SOL` : "—"),
  };
}
