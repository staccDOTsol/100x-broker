// /meta — what's spicy right now. One row per narrative market the house is in.
// To add a pick: append an entry, redeploy. The page reads live numbers for `market` with the board's own loader.
import type { MarketView } from "./lib/chain.js";

export type MetaPick = {
  /** Market account key. Empty string = not live yet: the row renders as "coming" with no link. */
  market: string;
  ticker: string;
  /** Match a replacement market by the actual underlying mint, never by a spoofable symbol. */
  underlyingMint?: string;
  /** Preserve the quote direction of inverse markets used by yield. */
  oracleQuote?: string;
  headline: string;
  thesis: string;
  /** The one button: UP / DOWN preselects that side on the market page; VAULT preselects its Yield option (?side=yield). */
  side: "UP" | "DOWN" | "VAULT";
  /** VAULT rows: the vault's key, for reference only (the button goes to the market page, where Yield lives). */
  vault?: string;
  tag: string;
};

export function resolveMetaPick(pick: MetaPick, views: MarketView[]): MarketView | null {
  return views.find((v) => v.acct.key.toBase58() === pick.market)
    ?? views.find((v) => pick.underlyingMint && v.underlyingMint === pick.underlyingMint && (!pick.oracleQuote || v.oracle.quote === pick.oracleQuote))
    ?? null;
}

export const META: MetaPick[] = [
  // Original market links remain historical fallbacks; MetaPage resolves replacement picks by underlying mint.
  {
    market: "9tpYA8TxRAs5YfnjQd9HYYXBH1cLbE1oNrcFRjQxsbf",
    ticker: "PUMP",
    underlyingMint: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
    headline: "100× on pump.fun's own coin",
    thesis:
      "PUMP against SOL on its Raydium pool, priced by a 2-observation TWAP. UP and DOWN are both live, and this market has its own yield vault too.",
    side: "UP",
    tag: "memes",
  },
  {
    market: "GLMSWgyzyC8GtAbPjv2qCa5fKzYR3GAxCZJ8E1RZMmbz",
    ticker: "SOL",
    underlyingMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    oracleQuote: "SOL",
    headline: "park SOL, no direction",
    thesis:
      "SOL can't be a vault's own coin, so Yield here parks into the USDC/SOL LP on the same Raydium pool, hedged with DOWN on the USDC/SOL market: it earns the pool's fees whichever way SOL goes.",
    side: "VAULT",
    tag: "majors",
  },
  {
    market: "V7Uggt9sqD3o3yBxsfcKZ43H99cKQTka5gznmFFRUCR",
    ticker: "WBTC",
    underlyingMint: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
    headline: "100× on bitcoin",
    thesis: "Wormhole BTC against SOL. The oracle pool is thin (about $24k of liquidity), so size like a parking meter.",
    side: "DOWN",
    tag: "majors",
  },
];
