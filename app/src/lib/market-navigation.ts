import { PublicKey, type Connection } from "@solana/web3.js";
import { HERO_MARKET, LEGACY_PROGRAM_IDS, PROGRAM_ID } from "../config";
import type { MarketView } from "./chain";

// A remembered market belongs to one deployment. Never reopen a closed program's
// market just because this browser visited it before a redeployment.
const LAST_MARKET = `lastMarket:${PROGRAM_ID.toBase58()}`;
const CHANGED = "100x:market-navigation";

export function lastMarket(): string | null {
  try {
    const value = localStorage.getItem(LAST_MARKET);
    return value ? new PublicKey(value).toBase58() : HERO_MARKET;
  } catch {
    return HERO_MARKET;
  }
}

export function rememberMarket(market: PublicKey): void {
  try {
    localStorage.setItem(LAST_MARKET, market.toBase58());
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    // Storage can be unavailable in private browsing.
  }
}

export function subscribeMarket(listener: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === LAST_MARKET || event.key === null) listener();
  };
  window.addEventListener(CHANGED, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(CHANGED, listener);
    window.removeEventListener("storage", storage);
  };
}

/** Offer a new market only when its actual oracle, direction and window match.
 * This is navigation, never migration of the closed market's positions. */
export async function replacementMarket(connection: Connection, oldKey: PublicKey, active: MarketView[]): Promise<MarketView | null> {
  if (!active.length) return null;
  const info = await connection.getAccountInfo(oldKey);
  if (!info || !LEGACY_PROGRAM_IDS.some((program) => info.owner.equals(program))
    || info.data.length !== 1008 || info.data.subarray(0, 8).toString() !== "hookmkt1") return null;
  const { decodeMarket } = await import("./chain");
  const old = decodeMarket(oldKey, info.data);
  return active.find(({ acct }) => acct.oraclePool.equals(old.oraclePool)
    && acct.oracleObs.equals(old.oracleObs)
    && acct.oracleKind === old.oracleKind
    && acct.underlyingIsToken0 === old.underlyingIsToken0
    && acct.windowSecs === old.windowSecs) ?? null;
}
