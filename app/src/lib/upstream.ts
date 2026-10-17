// Server-side RPC routing, shared by the /api/rpc proxy and every server function's Connection. FluxRPC (paid, fast, no deep
// history) serves live state, alternating its keys; Helius serves history and big program scans; each backs the other up, then
// the public endpoints. Only server code calls this (it reads process.env at call time); the browser goes through /api/rpc.
import { Connection, type Commitment } from "@solana/web3.js";

// Helius-first: history, and getProgramAccounts (Flux refuses scans of big programs such as the lookup-table program, which the
// site and the keeper need to find our tables; without them every hooked transaction is over 1232 bytes)
export const HISTORICAL = new Set(["getSignaturesForAddress", "getTransaction", "getBlockTime", "getAsset", "getConfirmedSignaturesForAddress2", "getConfirmedTransaction", "getProgramAccounts"]);

export type Upstream = { status: number; text: string; via: string };
let fluxTurn = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = (k: string) => (typeof process !== "undefined" ? process.env[k] : undefined);

// ---- lag: a provider can answer promptly from a bank minutes old. On 2026-10-13 Flux EU sat ~400 slots behind, so every
// blockhash it handed out had already expired and every send failed BlockhashNotFound. Each answer's context.slot is remembered
// per upstream (plus a getSlot probe of all of them every 10 s); one more than LAG_SLOTS behind the freshest goes to the back of
// the line until it catches up. Finalized reads trail confirmed by ~32 slots, so the bar sits above that. ----
const LAG_SLOTS = 75;
const slots = new Map<string, { slot: number; at: number }>();
let probedAt = 0;
function note(url: string, slot: number) {
  if (slot > 0) slots.set(url, { slot, at: Date.now() });
}
const contextSlot = (text: string) => Number(text.match(/"context"\s*:\s*\{[^}]*?"slot"\s*:\s*(\d+)/)?.[1] ?? 0);
function freshest() {
  let top = 0;
  for (const s of slots.values()) if (Date.now() - s.at < 30_000 && s.slot > top) top = s.slot;
  return top;
}
export function lagging(url: string) {
  const s = slots.get(url);
  return !!s && Date.now() - s.at < 30_000 && freshest() - s.slot > LAG_SLOTS;
}
function probe(urls: string[]) {
  if (Date.now() - probedAt < 10_000) return;
  probedAt = Date.now();
  for (const url of urls) {
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"confirmed"}]}', signal: AbortSignal.timeout(1_500) })
      .then((r) => r.json())
      .then((j: { result?: number }) => note(url, Number(j.result ?? 0)))
      .catch(() => null);
  }
}

export function upstreams(historical: boolean) {
  const flux = (env("FLUX_RPC_URLS") ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const helius = env("HELIUS_RPC_URL") ? [env("HELIUS_RPC_URL")!] : [];
  const pub = (env("RPC_FALLBACK_URLS") ?? "https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com").split(",").map((u) => u.trim()).filter(Boolean);
  if (flux.length) fluxTurn = (fluxTurn + 1) % flux.length;
  const fluxOrdered = flux.length ? [...flux.slice(fluxTurn), ...flux.slice(0, fluxTurn)] : [];
  // live state: flux (alternating keys) -> helius -> public; history: helius -> flux -> public
  const order = historical ? [...helius, ...fluxOrdered, ...pub] : [...fluxOrdered, ...helius, ...pub];
  probe(order);
  // a lagging provider keeps its turn, just after every caught-up one
  const ranked = [...order.filter((u) => !lagging(u)), ...order.filter((u) => lagging(u))];
  return ranked.map((url, i) => ({ url, via: flux.includes(url) ? "flux" : helius.includes(url) ? "helius" : "public", primary: i === 0 }));
}

// JSON-RPC errors that are the provider's problem rather than an answer: internal error, node unhealthy or behind, slot or block
// not available, minimum context slot not reached, a blockhash that node hasn't seen yet. Another provider answers these. Real answers pass through untouched, e.g.
// -32002 (preflight simulation failed) and -32003 (bad signature).
// -32017: "Transaction not available in cache" (a node without that history; Flux answers this for anything older than its window)
const FAULT_CODES = new Set([-32603, -32001, -32004, -32005, -32007, -32009, -32014, -32016, -32017, -32019]);
export function upstreamFault(text: string): boolean {
  if (!/"error"\s*:/.test(text)) return false;
  try {
    const j = JSON.parse(text);
    // some nodes word a lagging blockhash as -32002 "Transaction simulation failed" with data.err "BlockhashNotFound"
    return (Array.isArray(j) ? j : [j]).some((r) => r?.error && (FAULT_CODES.has(r.error.code) || /internal error|unhealthy|is behind|timed? ?out|blockhash ?not ?found/i.test(String(r.error.message ?? "")) || /BlockhashNotFound/.test(JSON.stringify(r.error.data ?? null))));
  } catch {
    return false;
  }
}

export async function forward(payload: string, historical: boolean): Promise<Upstream> {
  const post = (url: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
  const list = upstreams(historical);
  // a blockhash must come from the freshest bank: ask every provider at once and keep the highest slot's answer
  if (/^\s*\{[^]*"method"\s*:\s*"getLatestBlockhash"/.test(payload)) {
    const answers = await Promise.all(list.map(async (u) => {
      const r = await fetch(u.url, { method: "POST", headers: { "content-type": "application/json" }, body: payload, signal: AbortSignal.timeout(2_500) }).catch(() => null);
      if (!r || r.status !== 200) return null;
      const text = await r.text().catch(() => "");
      const slot = contextSlot(text);
      note(u.url, slot);
      return slot && !upstreamFault(text) && !/"error"\s*:/.test(text) ? { status: 200, text, via: u.via, slot } : null;
    }));
    const best = answers.filter((a): a is NonNullable<typeof a> => !!a).sort((a, b) => b.slot - a.slot)[0];
    if (best) return { status: best.status, text: best.text, via: best.via };
  }
  let last: Upstream | null = null;
  for (const u of list) {
    // the primary gets two tries with a breath between; the rest one each
    for (let i = 0; i < (u.primary ? 2 : 1); i++) {
      const r = await post(u.url).catch(() => null);
      if (r) {
        const text = await r.text();
        note(u.url, contextSlot(text));
        const declined = /"code":\s*-32429|Too Many Requests|not supported|Method not found|excluded from account secondary indexes|too many accounts|-32601|invalid api key|unauthorized/i.test(text);
        // an upstream's own auth/quota failure (401/403) is not an answer to the caller: try the next one
        const rejected = r.status === 401 || r.status === 403;
        if (r.status !== 429 && r.status < 500 && !declined && !rejected && !upstreamFault(text)) return { status: r.status, text, via: u.via };
        last = { status: r.status, text, via: u.via };
      }
      if (u.primary && i === 0) await sleep(200);
    }
  }
  return last ?? { status: 502, text: JSON.stringify({ error: "every upstream failed" }), via: "none" };
}

/** fetch for web3.js: every call takes the same routes and failover as /api/rpc. */
export const failoverFetch = async (_input: unknown, init?: { body?: unknown }): Promise<Response> => {
  const payload = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
  let methods: string[] = [];
  try {
    const j = JSON.parse(payload);
    methods = (Array.isArray(j) ? j : [j]).map((c) => c?.method);
  } catch {
    /* not JSON-RPC we can read: live-state order */
  }
  const out = await forward(payload, methods.some((m) => HISTORICAL.has(m)));
  return new Response(out.text, { status: out.status, headers: { "content-type": "application/json" } });
};

/** A server Connection on the shared routing. The endpoint only names the websocket host (Helius, as before); HTTP goes through
 *  failoverFetch. Rate-limit retries are ours (the next provider), not web3.js's 500 ms sleeps. */
export function serverConnection(commitment: Commitment = "confirmed") {
  const endpoint = env("HELIUS_RPC_URL") || (env("FLUX_RPC_URLS") ?? "").split(",")[0]?.trim() || "https://solana-rpc.publicnode.com";
  return new Connection(endpoint, { commitment, fetch: failoverFetch as never, disableRetryOnRateLimit: true });
}
