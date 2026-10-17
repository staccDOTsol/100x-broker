// /meta — what's spicy right now. One row per narrative market the house is in.
// To add a pick: append an entry, redeploy. The page reads live numbers for `market` with the board's own loader.
export type MetaPick = {
  /** Market account key. Empty string = not live yet: the row renders as "coming" with no link. */
  market: string;
  ticker: string;
  headline: string;
  thesis: string;
  /** The one button: UP / DOWN preselects that side on the market page; VAULT preselects its Yield option (?side=yield). */
  side: "UP" | "DOWN" | "VAULT";
  /** VAULT rows: the vault's key, for reference only (the button goes to the market page, where Yield lives). */
  vault?: string;
  tag: string;
};

export const META: MetaPick[] = [
  // the three live markets on the 2026-10-16 program (9g7ovq…); the old SPYx / USO / SI rows pointed at the closed program
  {
    market: "9tpYA8TxRAs5YfnjQd9HYYXBH1cLbE1oNrcFRjQxsbf",
    ticker: "PUMP",
    headline: "100× on pump.fun's own coin",
    thesis:
      "PUMP against SOL on its Raydium pool, priced by a 2-observation TWAP. UP and DOWN are both live, and this market has its own yield vault too.",
    side: "UP",
    tag: "memes",
  },
  {
    market: "GLMSWgyzyC8GtAbPjv2qCa5fKzYR3GAxCZJ8E1RZMmbz",
    ticker: "SOL",
    headline: "park SOL, no direction",
    thesis:
      "SOL can't be a vault's own coin, so Yield here parks into the USDC/SOL LP on the same Raydium pool, hedged with DOWN on the USDC/SOL market: it earns the pool's fees whichever way SOL goes.",
    side: "VAULT",
    vault: "Aujdpd6Gd2HtPCoX7EKPAWSTJtigASK9CJvjNpcYdRaR",
    tag: "majors",
  },
  {
    market: "V7Uggt9sqD3o3yBxsfcKZ43H99cKQTka5gznmFFRUCR",
    ticker: "WBTC",
    headline: "100× on bitcoin",
    thesis: "Wormhole BTC against SOL. The oracle pool is thin (about $24k of liquidity), so size like a parking meter.",
    side: "DOWN",
    tag: "majors",
  },
];
