import { PublicKey } from "@solana/web3.js";

// Vite inlines import.meta.env in the browser bundle; on the server (api/arena.ts reuses the trade builders) it is undefined.
const env: Record<string, string | undefined> = typeof window === "undefined" && typeof process !== "undefined"
  ? process.env
  : (import.meta as any).env ?? {};

export const PROGRAM_ID = new PublicKey(
  env.VITE_PROGRAM_ID ?? "37N7DexkZCdWDSLjqWrv6eSsDBKQNkg1P8ogHqKoV7XP",
);
/** Closed deployments remain readable for history and existing holdings, never transaction targets. */
export const LEGACY_PROGRAM_IDS = [
  new PublicKey("3ZACDHNMHhuZkPYZQZwyXYoJCxJr8kK8yUzGoqt5FbeH"),
  new PublicKey("9g7ovqLM7LVzRN2mZCkeCeAZYafK1twhKzTNcqXtirG6"),
  new PublicKey("T8EKHG9mJhwWNAYWisFKvbYynGMvSHP5Fb7kxSDh7cb"),
];
export const HISTORY_PROGRAM_IDS = [...new Map([PROGRAM_ID, ...LEGACY_PROGRAM_IDS].map((p) => [p.toBase58(), p])).values()];
export const CLOSED_PROGRAM_IDS = new Set([
  ...LEGACY_PROGRAM_IDS.map((p) => p.toBase58()),
  "63rmnKrW69fhp8bYKT21GE4kUVouMvdr1EwxHfKbvKFU", // closed DN vault program
  "HQ7oEm6WqZVmA8PSZVXC1mX28Xnbhq3kky4QhFixdNzC", // closed replacement DN
  "9D2CVzKrvB8MYXZhZzRS3a7BdDBbdzVKqFd82QnVVzjA", // closed replacement Composer
  "7LEh2yE62ocfnqcENYuZNL9ZFyaSdrfMygR2tisb2684", // closed NGU program
  "BHYw1FAWPriW9Gh7BG49X4UVe96CDjaxFrFFUtGSQmRx", // first closed Composer
  "2qiAsxua4dx5SPRD1CDXeNAKDKRepDQ1rags3vAoZ5fN", // second closed Composer
]);
export const LEGACY_DN_PROGRAM_ID = new PublicKey("63rmnKrW69fhp8bYKT21GE4kUVouMvdr1EwxHfKbvKFU");
export const LEGACY_DN_PROGRAM_IDS = [LEGACY_DN_PROGRAM_ID, new PublicKey("HQ7oEm6WqZVmA8PSZVXC1mX28Xnbhq3kky4QhFixdNzC")];
export const DN_PROGRAM_ID = new PublicKey(env.VITE_DN_PROGRAM_ID ?? "2BR8GRZu1ZLeunPdAfhY1vhZuCS4mW3Aei8aGG3MiNCj");
export const COMPOSER_PROGRAM_ID = new PublicKey(env.VITE_COMPOSER_PROGRAM_ID ?? "DsfsXoh9kvmpAKzrY72cPhBjXWG3xKtJcRWDpj5V6LQ");
/** The liquidityxyz API's service hostname remains available while its custom API DNS is repaired. */
export const LIQUIDITY_ROUTER_URL = (env.VITE_LIQUIDITY_ROUTER_URL ?? "https://ftl-firehose.fly.dev").replace(/\/$/, "");
export const HISTORY_DN_PROGRAM_IDS = [...new Map([DN_PROGRAM_ID, ...LEGACY_DN_PROGRAM_IDS].map((p) => [p.toBase58(), p])).values()];
export const RFSTACC = new PublicKey("pSYRpDqr847kB2nD5ZhjcPsHLV2ZpUxweXm1MwiSTcc");
/** Markets that exist on chain but must never be listed: the first PUMP / SOL / BTC markets under program 9g7ovq… were created with a
 *  66-minute window (copied from the old board) instead of the owner's 2-observation rule (window_secs = 1). The window is in the
 *  market's PDA seeds, so they cannot be fixed, only hidden; the window-1 replacements are what the site lists. */
export const RETIRED_MARKETS = new Set([
  "FguvR3kaMdeuvZ8eKuhz9jDP1S3ApRjJHGFvTKuQn5Gj", // PUMP, window 3960
  "7379fbMnbbsGThpxLBnTbumhvWenAMCkf5bkh3zCBNwW", // SOL, window 3960
  "33HifKMSbX7CVyQCh292KrYzGNG2MDEbHcFv1xim59ka", // BTC (WBTC), window 3960
]);

export const DBC = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const RAYDIUM_CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
export const DEFAULT_ORACLE_POOL = "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5"; // SOL/PUMP CLMM
export const DEFAULT_WINDOW_SECS = 3960;

export const LEVERAGE = 100;
export const REDEEM_FEE = 0.04;
export const QUOTE_DECIMALS = 9;
export const QUOTE_SYMBOL = "r-fstacc";

// browser: the key-hiding proxy; server (Vercel function): the upstream itself
// Server side: Helius first (one URL, known-good); Flux keys rotate inside /api/rpc where a bad key can fall through. The shared `conn` has no fallback.
export const RPC_URL = typeof window !== "undefined" ? `${window.location.origin}/api/rpc` : process.env.HELIUS_RPC_URL || process.env.FLUX_RPC_URLS?.split(",")[0]?.trim() || "https://100x.broker/api/rpc";
export const NETWORK: "mainnet" | "fork" = (env.VITE_NETWORK as "fork") ?? "mainnet";
export const POLL_MS = 10_000;
/** Markets pinned as the board hero: first is the house coin (big), the rest sit beside it. */
export const HERO_MARKETS: string[] = (env.VITE_HERO_MARKETS ?? env.VITE_HERO_MARKET ?? "")
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);
export const HERO_MARKET: string | null = HERO_MARKETS[0] ?? null;
/** Default referral account for stake-pool deposits when no ?ref= is present. */
export const HOUSE_WALLET = new PublicKey("331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth");
export const SITE_URL = "https://100x.broker";
/** Address lookup table (keeper-maintained) — without it a stranger's SOL->Ape tx is 2 bytes over the 1232 limit. */
export const ALT = new PublicKey(env.VITE_ALT ?? "HR1YvAhHBXPkhFFjp2mzaAg5ojnNUQyamU8qzTW4PK7U");
/** Every lookup table the keeper owns is one of ours; the site finds them on chain by this authority (no registry, no redeploy per table). */
export const ALT_AUTHORITY = new PublicKey(env.VITE_ALT_AUTHORITY ?? "EGa3ng1xcuB5X9tkK7czYczhD4PpAYAJF52Vo9F2Cn7");
/** Known tables, used only if the on-chain scan is unavailable. Add here when the keeper opens a new one. */
export const ALT_FALLBACK = [ALT, new PublicKey("27hak3EqFEAVp98eDci1FWV1EVBs87Efp7kMJ8ZEkm7X"), new PublicKey("2pKkyuLSiaGuuieAzVQx7q5jujnPJCBCkhPaZ6D7vtPS")];
/** $100X — the coin 30% of every fee buys and burns. */
export const MEME_MINT = new PublicKey("Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump");
export const MEME_SYMBOL = "100XBRO";
export const PUMP_URL = `https://pump.fun/coin/${MEME_MINT.toBase58()}`;
export const FEE_SPLIT = { mech: 60, burn: 30, dev: 10 } as const;
