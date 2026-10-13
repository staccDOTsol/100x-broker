import { PublicKey } from "@solana/web3.js";

// Vite inlines import.meta.env in the browser bundle; on the server (api/arena.ts reuses the trade builders) it is undefined.
const env: Record<string, string | undefined> = (import.meta as any).env ?? {};

export const PROGRAM_ID = new PublicKey(
  env.VITE_PROGRAM_ID ?? "T8EKHG9mJhwWNAYWisFKvbYynGMvSHP5Fb7kxSDh7cb",
);
export const RFSTACC = new PublicKey("pSYRpDqr847kB2nD5ZhjcPsHLV2ZpUxweXm1MwiSTcc");
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
export const ALT_FALLBACK = [ALT, new PublicKey("27hak3EqFEAVp98eDci1FWV1EVBs87Efp7kMJ8ZEkm7X")];
/** $100X — the coin 30% of every fee buys and burns. */
export const MEME_MINT = new PublicKey("Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump");
export const MEME_SYMBOL = "100XBRO";
export const PUMP_URL = `https://pump.fun/coin/${MEME_MINT.toBase58()}`;
export const FEE_SPLIT = { mech: 60, burn: 30, dev: 10 } as const;
