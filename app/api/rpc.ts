// Server-side JSON-RPC proxy so the Helius key never ships in the bundle.
import type { VercelRequest, VercelResponse } from "@vercel/node";

const ALLOWED = new Set([
  "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getLatestBlockhash", "isBlockhashValid",
  "sendTransaction", "simulateTransaction", "getSignatureStatuses", "getBalance", "getTokenAccountBalance", "getSignaturesForAddress",
  "getTokenAccountsByOwner", "getMinimumBalanceForRentExemption", "getSlot", "getBlockTime", "getEpochInfo",
  "getFeeForMessage", "getRecentPrioritizationFees", "getGenesisHash", "getVersion", "getTransaction", "getAsset",
]);
const PROGRAM_ID = process.env.VITE_PROGRAM_ID ?? "T8EKHG9mJhwWNAYWisFKvbYynGMvSHP5Fb7kxSDh7cb";
const DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";

// ---- routing: FluxRPC for live state (fast, no deep history), Helius for anything historical; both back each other up ----
// Helius-first: history, and getProgramAccounts (Flux refuses scans of big programs such as the lookup-table program, which the site
// and the keeper need to find our tables — without them every hooked transaction is over 1232 bytes)
const HISTORICAL = new Set(["getSignaturesForAddress", "getTransaction", "getBlockTime", "getAsset", "getConfirmedSignaturesForAddress2", "getConfirmedTransaction", "getProgramAccounts"]);
/** Reads worth caching for a moment: many tabs ask for the same accounts; the proxy answers once per instance per window. */
const CACHE_TTL: Record<string, number> = {
  getAccountInfo: 2000, getMultipleAccounts: 2000, getProgramAccounts: 3000, getTokenAccountBalance: 2000, getTokenAccountsByOwner: 2000,
  getBalance: 2000, getLatestBlockhash: 1500, getSlot: 1000, getEpochInfo: 5000, getMinimumBalanceForRentExemption: 60_000, getAsset: 60_000,
  getRecentPrioritizationFees: 3000, getGenesisHash: 600_000, getVersion: 600_000, isBlockhashValid: 1000, getFeeForMessage: 1500,
};
const cache = new Map<string, { at: number; ttl: number; body: string }>();
const inflight = new Map<string, Promise<{ status: number; text: string; via: string }>>();
let fluxTurn = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function upstreams(historical: boolean) {
  const flux = (process.env.FLUX_RPC_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const helius = process.env.HELIUS_RPC_URL ? [process.env.HELIUS_RPC_URL] : [];
  const pub = (process.env.RPC_FALLBACK_URLS ?? "https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com").split(",").map((u) => u.trim()).filter(Boolean);
  if (flux.length) fluxTurn = (fluxTurn + 1) % flux.length;
  const fluxOrdered = flux.length ? [...flux.slice(fluxTurn), ...flux.slice(0, fluxTurn)] : [];
  // live state: flux (alternating keys) -> helius -> public; history: helius -> flux -> public
  const order = historical ? [...helius, ...fluxOrdered, ...pub] : [...fluxOrdered, ...helius, ...pub];
  return order.map((url, i) => ({ url, via: flux.includes(url) ? "flux" : helius.includes(url) ? "helius" : "public", primary: i === 0 }));
}

async function forward(payload: string, historical: boolean): Promise<{ status: number; text: string; via: string }> {
  const post = (url: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
  let last: { status: number; text: string; via: string } | null = null;
  for (const u of upstreams(historical)) {
    // the primary gets two tries with a breath between; the rest one each
    for (let i = 0; i < (u.primary ? 2 : 1); i++) {
      const r = await post(u.url).catch(() => null);
      if (r) {
        const text = await r.text();
        const declined = /"code":\s*-32429|Too Many Requests|not supported|Method not found|excluded from account secondary indexes|too many accounts|-32601/i.test(text);
        if (r.status !== 429 && r.status < 500 && !declined) return { status: r.status, text, via: u.via };
        last = { status: r.status, text, via: u.via };
      }
      if (u.primary && i === 0) await sleep(200);
    }
  }
  return last ?? { status: 502, text: JSON.stringify({ error: "every upstream failed" }), via: "none" };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.HELIUS_RPC_URL && !process.env.FLUX_RPC_URLS) return res.status(500).json({ error: "no RPC upstream configured" });
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > 40) return res.status(400).json({ error: "batch too large" });
  for (const c of calls) {
    if (!c || !ALLOWED.has(c.method)) return res.status(400).json({ error: `method not allowed: ${c?.method}` });
    const altScan =
      c.params?.[0] === "AddressLookupTab1e1111111111111111111111111" &&
      Array.isArray(c.params?.[1]?.filters) &&
      c.params[1].filters.some((f: any) => f?.memcmp?.offset === 22 && f?.memcmp?.bytes === "EGa3ng1xcuB5X9tkK7czYczhD4PpAYAJF52Vo9F2Cn7");
    if (c.method === "getProgramAccounts" && !altScan && ![PROGRAM_ID, DBC, "2ZbjE44nSh3AmpREg4sdNMViBLAzAEtFKYDn1XdqMzEj"].includes(c.params?.[0])) {
      return res.status(400).json({ error: "getProgramAccounts limited to 100x programs" });
    }
  }
  const historical = calls.some((c) => HISTORICAL.has(c.method));
  const payload = JSON.stringify(body);
  res.setHeader("content-type", "application/json");
  // single cacheable read: answer from the window cache, or join the identical request already in flight
  const single = !Array.isArray(body) ? body : null;
  const ttl = single ? CACHE_TTL[single.method] : undefined;
  if (single && ttl) {
    const key = `${single.method}:${JSON.stringify(single.params ?? [])}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) {
      // keep the caller's request id so web3 matches the response
      return res.setHeader("x-rpc-cache", "hit").status(200).send(hit.body.replace(/"id":\s*("[^"]*"|\d+)/, `"id":${JSON.stringify(single.id)}`));
    }
    let p = inflight.get(key);
    if (!p) {
      p = forward(payload, historical).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const out = await p;
    if (out.status === 200 && !/"error"\s*:/.test(out.text)) cache.set(key, { at: Date.now(), ttl, body: out.text });
    if (cache.size > 2000) for (const [k, v] of cache) if (Date.now() - v.at > v.ttl) cache.delete(k);
    return res.setHeader("x-rpc-upstream", out.via).status(out.status).send(out.text.replace(/"id":\s*("[^"]*"|\d+)/, `"id":${JSON.stringify(single.id)}`));
  }
  const out = await forward(payload, historical);
  res.setHeader("x-rpc-upstream", out.via).status(out.status).send(out.text);
}
