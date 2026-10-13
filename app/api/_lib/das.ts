// Server-side Helius DAS lookup. The key lives only in HELIUS_RPC_URL.
export type Asset = { mint: string; name: string; symbol: string; image: string | null; decimals: number };

export async function getAsset(mint: string): Promise<Asset> {
  const upstream = process.env.HELIUS_RPC_URL;
  if (!upstream) throw new Error("HELIUS_RPC_URL not configured");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error("bad mint");
  const r = await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: mint } }),
  });
  const j: any = await r.json();
  if (j.error || !j.result) throw new Error(j.error?.message ?? "asset not found");
  const a = j.result;
  const meta = a.content?.metadata ?? {};
  const files: any[] = a.content?.files ?? [];
  const image: string | null =
    files.find((f) => (f.mime ?? "").startsWith("image/"))?.cdn_uri ??
    files.find((f) => (f.mime ?? "").startsWith("image/"))?.uri ??
    a.content?.links?.image ??
    null;
  const symbol = String(meta.symbol ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 7) || "TOKEN";
  const name = String(meta.name ?? symbol).trim().slice(0, 20) || symbol;
  return { mint, name, symbol, image, decimals: Number(a.token_info?.decimals ?? 0) };
}

export const CACHE = "public, max-age=3600, s-maxage=2592000, stale-while-revalidate=604800";
export const sideOf = (s: unknown) => (String(s ?? "up").toLowerCase() === "down" ? "down" : "up");
export const derived = (a: Asset, side: "up" | "down") => ({
  name: `${a.name} 100x ${side.toUpperCase()}`,
  symbol: `${a.symbol}${side === "up" ? "UP" : "DN"}`,
});
