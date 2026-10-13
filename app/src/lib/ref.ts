// ?ref=<pubkey> -> referral account for stake-pool deposits. Sticky per browser; house wallet by default.
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { HOUSE_WALLET, RFSTACC, SITE_URL } from "../config";
import { conn } from "./chain";

const KEY = "ref";
export function captureRef(search: string) {
  const ref = new URLSearchParams(search).get(KEY);
  if (!ref) return;
  try {
    new PublicKey(ref);
    localStorage.setItem(KEY, ref);
  } catch {
    /* ignore junk */
  }
}
export function storedRef(): PublicKey | null {
  try {
    const v = localStorage.getItem(KEY);
    return v ? new PublicKey(v) : null;
  } catch {
    return null;
  }
}

/** The r-fstacc account that receives the deposit referral slice: ref's ATA if it exists, else house, else self. */
export async function referralAccount(self: PublicKey, selfAta: PublicKey): Promise<PublicKey> {
  const candidates = [storedRef(), HOUSE_WALLET].filter((k): k is PublicKey => !!k && !k.equals(self));
  if (candidates.length === 0) return selfAta;
  const atas = candidates.map((k) => getAssociatedTokenAddressSync(RFSTACC, k));
  const infos = await conn.getMultipleAccountsInfo(atas);
  const i = infos.findIndex((x) => !!x);
  return i >= 0 ? atas[i] : selfAta;
}

export function shareUrl(path: string, wallet: PublicKey | null) {
  const u = new URL(path, SITE_URL);
  if (wallet) u.searchParams.set(KEY, wallet.toBase58());
  // X caches a link's card forever and never re-reads the page; a 5-minute bucket makes each new share a fresh URL for it
  u.searchParams.set("s", String(Math.floor(Date.now() / 300_000)));
  return u.toString();
}
export function tweetUrl(text: string, url: string) {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}
