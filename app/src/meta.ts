// /meta — what's spicy right now. One row per narrative market the house is in.
// To add a pick: append an entry, redeploy. The page reads live numbers for `market` with the board's own loader.
export type MetaPick = {
  /** Market account key. Empty string = not live yet: the row renders as "coming" with no link. */
  market: string;
  ticker: string;
  headline: string;
  thesis: string;
  /** The one button: UP / DOWN preselects that side on the market page; VAULT sends to the delta-neutral vault. */
  side: "UP" | "DOWN" | "VAULT";
  /** VAULT rows: the vault key for /yield/<vault>. Leave unset while it's being born: the row then points at the market's vault panel (#dn). */
  vault?: string;
  tag: string;
};

export const META: MetaPick[] = [
  {
    market: "ECZiaQYbpZDRzs927Vz1U3xdDbMDhgQBxpCoFfjhUzCj",
    ticker: "SPYx",
    headline: "short murica",
    thesis:
      "Houthis hit Saudi's main airport while US futures were shut. SPYx trades on-chain 24/7, so the weekend gap is live now. DOWN = 100× short the S&P.",
    side: "DOWN",
    tag: "geopolitics",
  },
  {
    market: "6c5V6uTyFeTbXJFrmSWvieZMuPaDCpZzGDUtZKP4vkbF",
    ticker: "USO",
    headline: "long oil volatility",
    thesis:
      "Oil has to move; which way is the fight. The USO vault is delta-neutral: it LPs USO/SOL and shorts the USO leg with DOWN, so it earns the chop whichever way crude goes.",
    side: "VAULT",
    vault: "Ew9Z6M4YEWU2ohdPhtV8TNUjTbamP31357Jz9hhMSbbg",
    tag: "oil",
  },
  {
    market: "9LAcY3v4EBG8dkKtHvh7ynJGzvGFp5cTQqzGuowaSgCG",
    ticker: "SI",
    headline: "$SI, 100× both ways · vault lands ~02:45 UTC",
    thesis:
      "Stupid Inu's second leg. UP/DOWN at 100× are live now. The vault is late and that one's on the clanker: it launched the market on a Raydium pool it had made minutes earlier, and the oracle's 66-min window had to roll past the pool's first tick before the TWAP read the real price. Clock, not a hole in your money. Oracle is that pool: thin, so size like a parking meter.",
    side: "UP",
    tag: "memes",
  },
];
