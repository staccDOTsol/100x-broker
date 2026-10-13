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
/** Reads worth caching for a moment: many tabs ask for the same accounts; the proxy answers once per instance per window.
 *  Live state (accounts, program scans, slot, blockhash) is never held longer than a second; sendTransaction, simulateTransaction and
 *  getSignatureStatuses are never cached or coalesced from a stored answer. */
const CACHE_TTL: Record<string, number> = {
  getAccountInfo: 1000, getMultipleAccounts: 1000, getProgramAccounts: 1000, getTokenAccountBalance: 1000, getTokenAccountsByOwner: 1000,
  getBalance: 1000, getLatestBlockhash: 1000, getSlot: 1000, getEpochInfo: 5000, getMinimumBalanceForRentExemption: 60_000, getAsset: 60_000,
  getRecentPrioritizationFees: 1000, getGenesisHash: 600_000, getVersion: 600_000, isBlockhashValid: 1000, getFeeForMessage: 1000,
  getBlockTime: 600_000, getTransaction: 60_000,
};
/** Never share even an in-flight answer: a resend is the caller's intent, and a simulation runs against the caller's exact state. */
const NO_COALESCE = new Set(["sendTransaction", "simulateTransaction"]);
type Upstream = { status: number; text: string; via: string };
const cache = new Map<string, { at: number; ttl: number; body: string; ids: unknown[] }>();
const inflight = new Map<string, { p: Promise<Upstream>; ids: unknown[] }>();
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
        const declined = /"code":\s*-32429|Too Many Requests|not supported|Method not found|excluded from account secondary indexes|too many accounts|-32601|invalid api key|unauthorized/i.test(text);
        // an upstream's own auth/quota failure (401/403) is not an answer to the caller: try the next one
        const rejected = r.status === 401 || r.status === 403;
        if (r.status !== 429 && r.status < 500 && !declined && !rejected) return { status: r.status, text, via: u.via };
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
  // identical bodies (ids aside) share one upstream call: the window cache for safe reads, the in-flight promise for the rest
  const ids = calls.map((c) => c.id);
  const key = `${Array.isArray(body) ? "b" : "s"}:${calls.map((c) => `${c.method}:${JSON.stringify(c.params ?? [])}`).join("|")}`;
  const ttl = calls.every((c) => CACHE_TTL[c.method]) ? Math.min(...calls.map((c) => CACHE_TTL[c.method])) : 0;
  const coalesce = !calls.some((c) => NO_COALESCE.has(c.method));
  // POST responses are not stored by Vercel's edge; the header documents intent and bounds any shared cache that would: a second
  // for safe reads, nothing for anything that sends, simulates or polls a signature
  res.setHeader("cache-control", ttl ? "public, s-maxage=1" : "no-store");
  if (ttl) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return res.setHeader("x-rpc-cache", "hit").status(200).send(withIds(hit.body, hit.ids, ids));
  }
  let run = coalesce ? inflight.get(key) : undefined;
  const joined = !!run;
  if (!run) {
    run = { p: forward(payload, historical), ids };
    if (coalesce) {
      inflight.set(key, run);
      run.p.finally(() => inflight.delete(key)).catch(() => {});
    }
  }
  const out = await run.p;
  if (ttl && out.status === 200 && !/"error"\s*:/.test(out.text)) {
    cache.set(key, { at: Date.now(), ttl, body: out.text, ids: run.ids });
    if (cache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of cache) if (now - v.at > v.ttl) cache.delete(k);
      for (const k of cache.keys()) {
        if (cache.size <= 1500) break;
        cache.delete(k); // oldest first: Map keeps insertion order
      }
    }
  }
  // the caller who made the upstream call gets the bytes as they came; anyone who joined it gets their own request ids back
  res.setHeader("x-rpc-upstream", out.via).status(out.status).send(joined ? withIds(out.text, run.ids, ids) : out.text);
}

/** Re-stamp a JSON-RPC response with the caller's request ids. `from` are the ids the stored answer was made for, `to` the caller's,
 *  position for position. Falls back to the text untouched if it is not JSON-RPC we can read. */
function withIds(text: string, from: unknown[], to: unknown[]): string {
  if (from.length === to.length && from.every((f, i) => f === to[i])) return text;
  try {
    const j = JSON.parse(text);
    const map = (r: any) => {
      if (!r || typeof r !== "object") return r;
      const i = from.findIndex((f) => f === r.id);
      return i >= 0 ? { ...r, id: to[i] } : r;
    };
    return JSON.stringify(Array.isArray(j) ? j.map(map) : map(j));
  } catch {
    return text;
  }
}
