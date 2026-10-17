// Vanity mint keypairs from the sexicurves-grind stockpile (POST /take-key, Bearer GRINDER_TOKEN).
// Every mint we create — UP/DOWN curves, pump companions, vault tokens — starts with `1oox`. Mint keypairs are single-use
// (the mint authority moves to the curve/pump program at creation), so handing the secret to the creating client is fine.
// When the stockpile is empty or the grinder is unreachable we fall back to a plain keypair rather than block a listing.
import { Keypair } from "@solana/web3.js";

const GRINDER = (process.env.GRINDER_URL ?? "https://sexicurves-grind.fly.dev").replace(/\/$/, "");
export const VANITY_PREFIX = process.env.VANITY_PREFIX ?? "1oox";

export type Vanity = { pubkey: string; secret: number[]; vanity: boolean };

async function takeOne(prefix: string): Promise<Vanity | null> {
  const token = process.env.GRINDER_TOKEN;
  if (!token) return null;
  try {
    const r = await fetch(`${GRINDER}/take-key?prefix=${encodeURIComponent(prefix)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4_000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const secret: number[] | undefined = Array.isArray(j?.secret) ? j.secret.map(Number) : undefined;
    if (!secret || secret.length !== 64) return null;
    const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
    const pubkey = kp.publicKey.toBase58();
    if (pubkey !== j.pubkey || !pubkey.startsWith(prefix)) return null;
    return { pubkey, secret, vanity: true };
  } catch {
    return null;
  }
}

/** `n` keypairs, vanity when the stockpile has them, plain otherwise (flagged so callers can say so). */
export async function vanityKeypairs(n: number, prefix = VANITY_PREFIX): Promise<Vanity[]> {
  const got = await Promise.all(Array.from({ length: n }, () => takeOne(prefix)));
  return got.map((v) => {
    if (v) return v;
    const kp = Keypair.generate();
    return { pubkey: kp.publicKey.toBase58(), secret: [...kp.secretKey], vanity: false };
  });
}

/** Stockpile status for /api/vanity?stock — counts only, never secrets. */
export async function vanityStock(): Promise<unknown> {
  try {
    const r = await fetch(`${GRINDER}/stock`, { signal: AbortSignal.timeout(4_000) });
    return r.ok ? await r.json() : { error: `grinder ${r.status}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
