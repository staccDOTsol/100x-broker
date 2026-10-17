// Server-side classification: the dependency-free rules in src/lib/category.ts, plus the two live sources they fall back to —
// Jupiter Tokens API v2 tags (memoized) and the issuer invariant read off the mint account over RPC (memoized). Also the
// stonk / major source lists for /api/runners?cat=…: Jupiter's `verified` list carries tags and 24 h stats for every token, and
// `tag?query=stocks` (documented) answers 400 today, so stocks are read out of `verified` by tag.
import { PublicKey } from "@solana/web3.js";
import { MAJORS, STONK_TAGS, categoryOf, stonkIssuerOfMintAccount, type Category } from "../../src/lib/category.js";
import { memo, peek } from "./memo.js";
import { serverConnection } from "../../src/lib/upstream.js";

const JUP = "https://lite-api.jup.ag/tokens/v2";
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** One row of the Jupiter token API, trimmed to what the lists and the classifier use. */
export type JupTok = {
  mint: string;
  symbol: string;
  name: string;
  icon: string | null;
  tags: string[];
  price: number | null;
  mc: number | null;
  liq: number | null;
  vol24: number | null; // buy + sell volume, USD, 24 h
  chg24: number | null; // percent
  verified: boolean;
};
function row(t: any): JupTok | null {
  const mint = typeof t?.id === "string" ? t.id : null;
  if (!mint) return null;
  const buy = num(t.stats24h?.buyVolume), sell = num(t.stats24h?.sellVolume);
  return {
    mint,
    symbol: String(t.symbol ?? "").trim(),
    name: String(t.name ?? "").trim(),
    icon: typeof t.icon === "string" && /^https?:\/\//.test(t.icon) ? t.icon : null,
    tags: Array.isArray(t.tags) ? t.tags.filter((g: unknown) => typeof g === "string") : [],
    price: num(t.usdPrice),
    mc: num(t.mcap) ?? num(t.fdv),
    liq: num(t.liquidity),
    vol24: buy === null && sell === null ? null : (buy ?? 0) + (sell ?? 0),
    chg24: num(t.stats24h?.priceChange),
    verified: t.isVerified === true,
  };
}
const headers = { accept: "application/json" };

/** Every Jupiter-verified token with its tags and 24 h stats (~4k rows, ~5 MB): 10 min fresh, an hour stale. */
export const jupVerified = (): Promise<Map<string, JupTok>> =>
  memo("jup:verified", 600_000, 3_600_000, async () => {
    const r = await fetch(`${JUP}/tag?query=verified`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`jupiter tag ${r.status}`);
    const j: any = await r.json();
    const m = new Map<string, JupTok>();
    for (const t of Array.isArray(j) ? j : []) {
      const x = row(t);
      if (x) m.set(x.mint, x);
    }
    if (m.size === 0) throw new Error("jupiter verified list empty");
    return m;
  });

/** Jupiter rows for up to 100 mints in one call (`search` accepts comma-separated mint addresses). Memoized per sorted batch. */
export function jupLookup(mints: string[]): Promise<Map<string, JupTok>> {
  const ids = [...new Set(mints)].filter((m) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)).sort().slice(0, 100);
  if (!ids.length) return Promise.resolve(new Map());
  return memo(`jup:lookup:${ids.join(",")}`, 600_000, 86_400_000, async () => {
    const r = await fetch(`${JUP}/search?query=${ids.join(",")}`, { headers, signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new Error(`jupiter search ${r.status}`);
    const j: any = await r.json();
    const m = new Map<string, JupTok>();
    for (const t of Array.isArray(j) ? j : []) {
      const x = row(t);
      if (x && ids.includes(x.mint)) m.set(x.mint, x);
    }
    return m;
  });
}

/** Jupiter name/symbol search, as the user typed it: the tags come along, so stonks surface even when Birdeye ranks them low. */
export const jupSearch = (q: string): Promise<JupTok[]> =>
  memo(`jup:search:${q.toLowerCase()}`, 120_000, 600_000, async () => {
    const r = await fetch(`${JUP}/search?query=${encodeURIComponent(q)}`, { headers, signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new Error(`jupiter search ${r.status}`);
    const j: any = await r.json();
    return (Array.isArray(j) ? j : []).map(row).filter((x): x is JupTok => !!x);
  });

const conn = () => {
  const u = process.env.HELIUS_RPC_URL;
  if (!u) throw new Error("HELIUS_RPC_URL not configured");
  return serverConnection();
};
/** Which stonk issuer's authorities control each mint, from the mint accounts (one getMultipleAccountsInfo per 100). Mint
 *  authorities do not move, so a day is a fine cache. */
export async function issuerByMintAccount(mints: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const todo: string[] = [];
  for (const m of new Set(mints)) {
    const held = peek<string | null>(`mint:issuer:${m}`);
    if (held !== undefined) out.set(m, held);
    else todo.push(m);
  }
  for (let i = 0; i < todo.length; i += 100) {
    const batch = todo.slice(i, i + 100);
    try {
      const infos = await conn().getMultipleAccountsInfo(batch.map((m) => new PublicKey(m)));
      batch.forEach((m, k) => {
        const d = infos[k]?.data;
        const issuer = d ? stonkIssuerOfMintAccount(new Uint8Array(d))?.id ?? null : null;
        out.set(m, issuer);
        void memo(`mint:issuer:${m}`, 86_400_000, 86_400_000, async () => issuer);
      });
    } catch {
      /* unknown this round; the tag lookup may still answer */
    }
  }
  return out;
}

/** Classify many tokens at once: the static rules first; what is still `other` is looked up on Jupiter (tags) and, for mints
 *  only, on chain (issuer authorities). Never throws — an upstream miss leaves a row at `other`. */
export async function classifyMany<T extends { mint: string; symbol?: string | null; name?: string | null; tags?: readonly string[] | null }>(rows: T[]): Promise<Map<string, Category>> {
  const out = new Map<string, Category>();
  const open: T[] = [];
  for (const r of rows) {
    const c = categoryOf(r);
    out.set(r.mint, c);
    if (c === "other") open.push(r);
  }
  if (!open.length) return out;
  const held = peek<Map<string, JupTok>>("jup:verified");
  const need = open.filter((r) => !held?.has(r.mint)).map((r) => r.mint);
  const [jup, issuers] = await Promise.all([need.length ? jupLookup(need).catch(() => new Map<string, JupTok>()) : new Map<string, JupTok>(), issuerByMintAccount(open.map((r) => r.mint)).catch(() => new Map<string, string | null>())]);
  for (const r of open) {
    const j = held?.get(r.mint) ?? jup.get(r.mint);
    // Jupiter's name is the full on-chain one (DAS-derived names are cut at 20 chars), so it wins for the brand-mark rule
    let c = categoryOf({ mint: r.mint, symbol: j?.symbol ?? r.symbol, name: j?.name ?? r.name, tags: [...(r.tags ?? []), ...(j?.tags ?? [])] });
    if (c === "other" && issuers.get(r.mint)) c = "stonk";
    out.set(r.mint, c);
  }
  return out;
}

/** One token. */
export const classify = async (t: { mint: string; symbol?: string | null; name?: string | null }): Promise<Category> => (await classifyMany([t])).get(t.mint) ?? "other";

/** Every Jupiter-verified tokenized stock, biggest 24 h volume first. */
export async function stonkList(): Promise<JupTok[]> {
  const all = await jupVerified();
  return [...all.values()].filter((t) => t.tags.some((g) => STONK_TAGS.has(g))).sort((a, b) => (b.vol24 ?? 0) - (a.vol24 ?? 0));
}
/** The curated majors plus what Jupiter tags `major` / `lst`, biggest 24 h volume first. Curated mints missing from Jupiter's
 *  verified list are still looked up so the list never silently drops one. */
export async function majorList(): Promise<JupTok[]> {
  const all = await jupVerified();
  const rows = new Map<string, JupTok>();
  for (const t of all.values()) if (MAJORS[t.mint] || t.tags.includes("major") || t.tags.includes("lst")) rows.set(t.mint, t);
  const missing = Object.keys(MAJORS).filter((m) => !rows.has(m));
  if (missing.length) for (const [m, t] of await jupLookup(missing).catch(() => new Map<string, JupTok>())) rows.set(m, t);
  return [...rows.values()].sort((a, b) => (b.vol24 ?? 0) - (a.vol24 ?? 0));
}
