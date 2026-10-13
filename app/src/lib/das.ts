// Underlying-token identity, derived server-side from Helius DAS (never user-supplied).
export type Underlying = { mint: string; name: string; symbol: string; image: string | null; decimals: number };
const cache = new Map<string, Promise<Underlying | null>>();

export function getUnderlying(mint: string): Promise<Underlying | null> {
  let p = cache.get(mint);
  if (!p) {
    p = fetch(`/api/asset?mint=${mint}`)
      .then((r) => (r.ok ? (r.json() as Promise<Underlying>) : null))
      .then((u) => (u ? { ...u, image: u.image ? `/api/icon?mint=${mint}` : null } : null))
      .catch(() => null);
    cache.set(mint, p);
  }
  return p;
}

export type DerivedMeta = { name: string; symbol: string; image: string };
export async function getDerivedMeta(mint: string, side: "up" | "down"): Promise<DerivedMeta> {
  const r = await fetch(`/api/meta?mint=${mint}&s=${side}`);
  if (!r.ok) throw new Error("Could not resolve the underlying token's metadata.");
  return r.json();
}

export const metaUri = (mint: string, side: "up" | "down") => `${window.location.origin}/api/meta?mint=${mint}&s=${side}`;
