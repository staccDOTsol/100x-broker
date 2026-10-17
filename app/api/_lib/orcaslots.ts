// What an Orca launch can open against (GET /api/launch?orca=1): the fee tiers listed in the launch lookup table (configs
// 12Nqk2 controls, tick spacing 128..16384, permissionless; scripts/orca-admin.mjs creates them), and the quotes: the good list plus Birdeye's trending
// tokens that Orca will pool without a badge, each with its decimals, token program (read from chain) and USD price.
import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { WHIRLPOOL, type Quote, type Slot } from "../../src/lib/orcalaunch.js";
import { GOOD_QUOTES, QUOTE_100XBRO } from "../../src/lib/orcaquotes.js";

const AUTH = "12Nqk2jyA3XNe3rPxAaLFixytmohnMrBfCsdwrCfWNm2";
const NONE = PublicKey.default.toBuffer();
export type OrcaSlot = Slot & { protocolFee: number };

const ADAPTIVE_DISC = Buffer.from([147, 16, 144, 116, 47, 146, 149, 46]);
let tableSlotCache: { at: number; key: string; v: OrcaSlot[] } | null = null;
/** The menu straight from the launch lookup table: it lists every config and tier a launch may use, so reading those accounts
 *  (getMultipleAccounts, no program scan) gives exactly the slots whose pools fit one transaction. */
export async function orcaSlotsFromTable(conn: Connection, alt: string): Promise<OrcaSlot[]> {
  if (tableSlotCache && tableSlotCache.key === alt && Date.now() - tableSlotCache.at < 5 * 60_000) return tableSlotCache.v;
  const addrs = (await conn.getAddressLookupTable(new PublicKey(alt))).value?.state.addresses ?? [];
  const infos: (import("@solana/web3.js").AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < addrs.length; i += 100) infos.push(...(await conn.getMultipleAccountsInfo(addrs.slice(i, i + 100))));
  const fee = new Map<string, number>();
  addrs.forEach((a, i) => {
    const d = infos[i];
    if (d?.owner.equals(WHIRLPOOL) && d.data.length === 108 && new PublicKey(d.data.subarray(8, 40)).toBase58() === AUTH) fee.set(a.toBase58(), d.data.readUInt16LE(104));
  });
  const slots: OrcaSlot[] = [];
  addrs.forEach((a, i) => {
    const d = infos[i];
    if (!d?.owner.equals(WHIRLPOOL)) return;
    const config = new PublicKey(d.data.subarray(8, 40)).toBase58();
    if (!fee.has(config)) return;
    if (d.data.length === 44) {
      const spacing = d.data.readUInt16LE(40);
      if (spacing >= 128 && spacing <= 16384) slots.push({ config, tier: a.toBase58(), kind: "fixed", index: spacing, tickSpacing: spacing, fee: d.data.readUInt16LE(42), protocolFee: fee.get(config)! });
    } else if (d.data.subarray(0, 8).equals(ADAPTIVE_DISC)) {
      const spacing = d.data.readUInt16LE(42);
      if (spacing >= 128 && spacing <= 16384 && d.data.subarray(44, 76).equals(NONE)) slots.push({ config, tier: a.toBase58(), kind: "adaptive", index: d.data.readUInt16LE(40), tickSpacing: spacing, fee: d.data.readUInt16LE(108), protocolFee: fee.get(config)! });
    }
  });
  slots.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "adaptive" ? -1 : 1) || b.fee - a.fee || b.tickSpacing - a.tickSpacing);
  tableSlotCache = { at: Date.now(), key: alt, v: slots };
  return slots;
}

type Trend = { address: string; symbol: string; liquidity?: number; volume24hUSD?: number };
async function birdeye<T>(path: string): Promise<T | null> {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) return null;
  const r = await fetch(`https://public-api.birdeye.so${path}`, { headers: { "X-API-KEY": key, "x-chain": "solana" }, signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!r?.ok) return null;
  return ((await r.json()) as { data?: T }).data ?? null;
}

let quoteCache: { at: number; v: (Quote & { trending: boolean })[] } | null = null;
export async function orcaQuotes(conn: Connection): Promise<(Quote & { trending: boolean })[]> {
  if (quoteCache && Date.now() - quoteCache.at < 60_000) return quoteCache.v;
  const trend = await birdeye<{ tokens?: Trend[] }>("/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20");
  // trending, but only what has real depth behind it
  const hot = (trend?.tokens ?? []).filter((t) => (t.liquidity ?? 0) >= 250_000 && (t.volume24hUSD ?? 0) >= 1_000_000 && !GOOD_QUOTES.some((g) => g.mint === t.address));
  const all = [...GOOD_QUOTES.map((g) => ({ ...g, trending: false })), ...hot.map((t) => ({ mint: t.address, symbol: t.symbol, trending: true }))];
  const infos = await conn.getMultipleParsedAccounts(all.map((q) => new PublicKey(q.mint)));
  const prices = await birdeye<Record<string, { value?: number } | null>>(`/defi/multi_price?list_address=${all.map((q) => q.mint).join(",")}`);
  const out: (Quote & { trending: boolean })[] = [];
  all.forEach((q, i) => {
    const a = infos.value[i];
    const parsed = a && "parsed" in a.data ? (a.data.parsed as { info?: { decimals?: number; freezeAuthority?: string | null; extensions?: { extension: string }[] } }) : null;
    if (!a || !parsed?.info) return;
    const t22 = a.owner.equals(TOKEN_2022_PROGRAM_ID);
    if (!t22 && !a.owner.equals(TOKEN_PROGRAM_ID)) return;
    // Orca pools a Token-2022 mint without a badge only if it carries just the metadata extensions and can't be frozen
    if (t22 && ((parsed.info.extensions ?? []).some((e) => !["metadataPointer", "tokenMetadata"].includes(e.extension)) || parsed.info.freezeAuthority)) return;
    const usd = prices?.[q.mint]?.value ?? null;
    if (!usd) return;
    out.push({ mint: q.mint, symbol: q.symbol, decimals: parsed.info.decimals ?? 0, program: a.owner.toBase58(), usd, trending: q.trending });
  });
  // $100XBRO always leads
  out.sort((a, b) => (a.mint === QUOTE_100XBRO ? -1 : b.mint === QUOTE_100XBRO ? 1 : 0));
  quoteCache = { at: Date.now(), v: out };
  return out;
}
