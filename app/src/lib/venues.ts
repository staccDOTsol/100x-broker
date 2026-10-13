// Oracle venues beyond Raydium CLMM: PumpSwap, Raydium CPMM, Meteora DAMM v2, Meteora DLMM.
// Everything venue-specific (program ids, account layouts, price convention, pool discovery) lives here so the
// on-chain contract can be adjusted in one place. Dependency-light on purpose: api/_lib/og.ts imports it too.
//
// On-chain contract (programs/hooked): Market.oracle_kind u8 at byte 493 (0 = CLMM, existing markets read 0).
//   kind 1 PumpSwap    oracle_obs = pool.base_ata      oracle_pool = pool.quote_ata     (SPL token accounts)
//   kind 2 Raydium CPMM oracle_obs = token_0_vault     oracle_pool = token_1_vault
//   kind 3 DAMM v2      both slots = the pool
//   kind 4 DLMM         both slots = the LbPair
// Price: tick with 1.0001^tick = raw token1 per raw token0 (same convention as the CLMM tick); `underlying_is_token0`
// decides the sign. kind 1: log1.0001((quote_vault + Pool.virtual_quote_reserves) / base_vault) — PumpSwap prices with
// its virtual quote (i128 at byte 245 of the Pool, 0 on accounts shorter than 261; negative values are netted, a
// non-positive effective quote is invalid); kind 2: log1.0001(amount1/amount0) from the two vaults; kind 3:
// 2*log1.0001(sqrt_price/2^64); kind 4: active_id*log1.0001(1+bin_step/1e4). For kinds 1-4 the program samples the
// price itself on every rebalance and stores checkpoints in Market.ckpts; the series comes from those, not from a ring.
// Trailing accounts on poke / settle_begin / redeem: the oracle_pool slot (optional for kind 0 — dead-ring sampling —
// and kinds 3/4, required for 1/2) and, for kind 1 only, the PumpSwap Pool (read for virtual_quote_reserves). Kind-1
// markets carry that Pool as the 7th entry of their ExtraAccountMetaList so Execute gets it automatically.
import { Buffer } from "buffer";
import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, RAYDIUM_CLMM, WSOL } from "../config.js";

export type Venue = "clmm" | "pumpswap" | "cpmm" | "dammv2" | "dlmm";
export const VENUES: Venue[] = ["clmm", "pumpswap", "cpmm", "dammv2", "dlmm"];
export const venueOfKind = (kind: number): Venue => VENUES[kind] ?? "clmm";
export const kindOfVenue = (v: Venue): number => VENUES.indexOf(v);
/** Short badge text (≤3 words). */
export const VENUE_LABEL: Record<Venue, string> = { clmm: "Raydium CLMM", pumpswap: "PumpSwap", cpmm: "Raydium CPMM", dammv2: "Meteora DAMM v2", dlmm: "Meteora DLMM" };

export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMPSWAP_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const RAYDIUM_CPMM_PROGRAM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
export const METEORA_DAMM_V2_PROGRAM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const METEORA_DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

/** Market account: oracle_kind sits in what used to be `_pad[0]`, right after ckpt_head. */
export const MARKET_ORACLE_KIND = 493;

// Account layouts, byte offsets verified against mainnet accounts (2026-10-13).
// PumpSwap Pool: disc 8 | bump 1 | index u16 | creator 32 | base_mint | quote_mint | lp_mint | base_ata | quote_ata | lp_supply u64 @203 |
// coin_creator @211 | ... | virtual_quote_reserves i128 @245 (only on accounts of >= 261 bytes; older writes stop before it)
const PS = { BASE_MINT: 43, QUOTE_MINT: 75, BASE_ATA: 139, QUOTE_ATA: 171, VIRTUAL_QUOTE: 245 };
/** Pool length at which `virtual_quote_reserves` exists; same number as a 7-entry ExtraAccountMetaList (16 + 7·35). */
export const PS_POOL_WITH_VIRTUAL_LEN = PS.VIRTUAL_QUOTE + 16;
// Raydium CPMM PoolState: disc 8 | amm_config | pool_creator | token_0_vault | token_1_vault | lp_mint | token_0_mint | token_1_mint | ... | mint_0_decimals u8 @331 | mint_1_decimals u8 @332
const CP = { VAULT0: 72, VAULT1: 104, MINT0: 168, MINT1: 200, DEC0: 331, DEC1: 332 };
// Meteora DAMM v2 Pool: disc 8 | pool_fees 160 | token_a_mint | token_b_mint | token_a_vault | token_b_vault | ... | sqrt_price u128 @456
const DM = { MINT_A: 168, MINT_B: 200, VAULT_A: 232, VAULT_B: 264, SQRT_PRICE: 456 };
// Meteora DLMM LbPair: disc 8 | parameters 32 | v_parameters 32 | bump 1 | bin_step_seed 2 | pair_type 1 | active_id i32 @76 | bin_step u16 @80 | ... | token_x_mint @88 | token_y_mint @120 | reserve_x @152 | reserve_y @184
const LB = { ACTIVE_ID: 76, BIN_STEP: 80, MINT_X: 88, MINT_Y: 120, RESERVE_X: 152, RESERVE_Y: 184 };
// Raydium CLMM PoolState (what chain.ts already reads): mint0 @73, mint1 @105, observation_key @201, decimals @233/234, tick_current @269
const CL = { MINT0: 73, MINT1: 105, OBS: 201, DEC0: 233, DEC1: 234, TICK: 269 };

const pk = (d: Uint8Array, o: number) => new PublicKey(d.subarray(o, o + 32));
const u64 = (d: Uint8Array, o: number) => Buffer.from(d).readBigUInt64LE(o);
const u128 = (d: Uint8Array, o: number) => u64(d, o) + (u64(d, o + 8) << 64n);
const i128 = (d: Uint8Array, o: number) => u64(d, o) + (Buffer.from(d).readBigInt64LE(o + 8) << 64n);
const LN_TICK = Math.log(1.0001);

/** PumpSwap `Pool.virtual_quote_reserves` (may be negative on non-boost pools); 0 when the account predates the field. */
export const pumpSwapVirtualQuote = (poolData: Uint8Array): bigint => (poolData.length >= PS_POOL_WITH_VIRTUAL_LEN ? i128(poolData, PS.VIRTUAL_QUOTE) : 0n);
/** What PumpSwap prices against: quote vault + virtual quote. null when that is not positive (the program rejects it). */
export function pumpSwapEffectiveQuote(quoteAmount: bigint, virtualQuote: bigint): bigint | null {
  const eff = quoteAmount + virtualQuote;
  return eff > 0n ? eff : null;
}
/** SPL token account: amount at 64 (Tokenkeg and Token-2022 share the base layout). */
export const tokenAmount = (d: Uint8Array) => u64(d, 64);
const tokenMint = (d: Uint8Array) => pk(d, 0);

export type OracleQuote = "SOL" | "USDC" | "USDT" | "?";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const quoteSymbolOf = (mint: PublicKey): OracleQuote =>
  mint.equals(WSOL) ? "SOL" : mint.toBase58() === USDC ? "USDC" : mint.toBase58() === USDT ? "USDT" : "?";
export const QUOTE_DECIMALS: Record<Exclude<OracleQuote, "?">, number> = { SOL: 9, USDC: 6, USDT: 6 };

/** A venue pool account, decoded to the parts the market needs. token0/token1 follow the venue's own order. */
export type VenuePool = {
  venue: Venue;
  kind: number;
  /** The venue's pool account (PumpSwap pool, CPMM pool, DAMM v2 pool, LbPair, CLMM pool). */
  pool: PublicKey;
  mint0: PublicKey;
  mint1: PublicKey;
  /** What goes in Market.oracle_obs / Market.oracle_pool (and the market PDA seed = slotObs). */
  slotObs: PublicKey;
  slotPool: PublicKey;
  /** Token accounts holding the two reserves (kind 0: none we read). */
  reserve0: PublicKey | null;
  reserve1: PublicKey | null;
  /** PumpSwap: `virtual_quote_reserves` at decode time (added to the quote vault when pricing). 0n for every other venue. */
  virtualQuote: bigint;
};

/** Decode any supported venue pool from its owner + data; null when the account is not one of ours. */
export function decodeVenuePool(key: PublicKey, owner: PublicKey, d: Uint8Array): VenuePool | null {
  if (owner.equals(RAYDIUM_CLMM) && d.length > CL.TICK + 4) {
    const obs = pk(d, CL.OBS);
    return { venue: "clmm", kind: 0, pool: key, mint0: pk(d, CL.MINT0), mint1: pk(d, CL.MINT1), slotObs: obs, slotPool: key, reserve0: null, reserve1: null, virtualQuote: 0n };
  }
  if (owner.equals(PUMPSWAP_PROGRAM) && d.length >= PS.QUOTE_ATA + 32) {
    const base = pk(d, PS.BASE_ATA), quote = pk(d, PS.QUOTE_ATA);
    return { venue: "pumpswap", kind: 1, pool: key, mint0: pk(d, PS.BASE_MINT), mint1: pk(d, PS.QUOTE_MINT), slotObs: base, slotPool: quote, reserve0: base, reserve1: quote, virtualQuote: pumpSwapVirtualQuote(d) };
  }
  if (owner.equals(RAYDIUM_CPMM_PROGRAM) && d.length > CP.DEC1) {
    const v0 = pk(d, CP.VAULT0), v1 = pk(d, CP.VAULT1);
    return { venue: "cpmm", kind: 2, pool: key, mint0: pk(d, CP.MINT0), mint1: pk(d, CP.MINT1), slotObs: v0, slotPool: v1, reserve0: v0, reserve1: v1, virtualQuote: 0n };
  }
  if (owner.equals(METEORA_DAMM_V2_PROGRAM) && d.length >= DM.SQRT_PRICE + 16) {
    return { venue: "dammv2", kind: 3, pool: key, mint0: pk(d, DM.MINT_A), mint1: pk(d, DM.MINT_B), slotObs: key, slotPool: key, reserve0: pk(d, DM.VAULT_A), reserve1: pk(d, DM.VAULT_B), virtualQuote: 0n };
  }
  if (owner.equals(METEORA_DLMM_PROGRAM) && d.length >= LB.RESERVE_Y + 32) {
    return { venue: "dlmm", kind: 4, pool: key, mint0: pk(d, LB.MINT_X), mint1: pk(d, LB.MINT_Y), slotObs: key, slotPool: key, reserve0: pk(d, LB.RESERVE_X), reserve1: pk(d, LB.RESERVE_Y), virtualQuote: 0n };
  }
  return null;
}

/**
 * The PumpSwap `Pool` behind an existing kind-1 market (poke / settle_begin / redeem must pass it): the 7th entry of the
 * bull mint's ExtraAccountMetaList when the list has one, else the canonical PDA of the underlying (= the base vault's
 * mint); either way the Pool's vault fields must equal the market's two slots. Returns null when nothing checks out.
 */
export async function pumpSwapPoolOf(
  conn: Connection,
  bullMint: PublicKey,
  slotObs: PublicKey,
  slotPool: PublicKey,
  obsData: Uint8Array,
): Promise<{ key: PublicKey; data: Uint8Array } | null> {
  const metaList = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), bullMint.toBuffer()], PROGRAM_ID)[0];
  const canonical = pumpSwapCanonicalPool(tokenMint(obsData));
  const [meta, canon] = await conn.getMultipleAccountsInfo([metaList, canonical]);
  // ExtraAccountMetaList: disc 8 | length u32 | count u32 | entries of 35 bytes (discriminator u8 | address 32 | signer | writable)
  const SEVENTH = 16 + 6 * 35;
  const listed = meta && meta.data.length >= SEVENTH + 35 && meta.data[SEVENTH] === 0 ? pk(meta.data, SEVENTH + 1) : null;
  const matches = (key: PublicKey, info: { owner: PublicKey; data: Uint8Array } | null) => {
    const p = info ? decodeVenuePool(key, info.owner, info.data) : null;
    return p?.venue === "pumpswap" && p.slotObs.equals(slotObs) && p.slotPool.equals(slotPool) ? { key, data: info!.data } : null;
  };
  if (listed && !listed.equals(canonical)) {
    const hit = matches(listed, await conn.getAccountInfo(listed));
    if (hit) return hit;
  }
  return matches(canonical, canon);
}

/** The two mints behind a market's oracle slots (kinds 1-4; kind 0 reads the CLMM pool directly in chain.ts). */
export function slotMints(venue: Venue, obsData: Uint8Array, poolData: Uint8Array): { mint0: PublicKey; mint1: PublicKey } {
  switch (venue) {
    case "pumpswap":
    case "cpmm":
      return { mint0: tokenMint(obsData), mint1: tokenMint(poolData) };
    case "dammv2":
      return { mint0: pk(poolData, DM.MINT_A), mint1: pk(poolData, DM.MINT_B) };
    case "dlmm":
      return { mint0: pk(poolData, LB.MINT_X), mint1: pk(poolData, LB.MINT_Y) };
    default:
      return { mint0: pk(poolData, CL.MINT0), mint1: pk(poolData, CL.MINT1) };
  }
}

/** Spot tick (raw token1 per raw token0 = 1.0001^tick) from the two slot accounts, per kind. PumpSwap (kind 1) also needs
 *  the Pool account's data for `virtual_quote_reserves`; without it the tick is NaN (the program would reject it too). */
export function slotSpotTick(venue: Venue, obsData: Uint8Array, poolData: Uint8Array, venuePoolData?: Uint8Array): number {
  switch (venue) {
    case "pumpswap": {
      if (!venuePoolData) return NaN;
      const eff = pumpSwapEffectiveQuote(tokenAmount(poolData), pumpSwapVirtualQuote(venuePoolData));
      const a0 = Number(tokenAmount(obsData));
      return eff !== null && a0 > 0 ? Math.log(Number(eff) / a0) / LN_TICK : NaN;
    }
    case "cpmm": {
      const a0 = Number(tokenAmount(obsData)), a1 = Number(tokenAmount(poolData));
      return a0 > 0 && a1 > 0 ? Math.log(a1 / a0) / LN_TICK : NaN;
    }
    case "dammv2": {
      const sqrt = Number(u128(poolData, DM.SQRT_PRICE)) / 2 ** 64;
      return sqrt > 0 ? (2 * Math.log(sqrt)) / LN_TICK : NaN;
    }
    case "dlmm": {
      const b = Buffer.from(poolData);
      return (b.readInt32LE(LB.ACTIVE_ID) * Math.log(1 + b.readUInt16LE(LB.BIN_STEP) / 1e4)) / LN_TICK;
    }
    default:
      return Buffer.from(poolData).readInt32LE(CL.TICK);
  }
}

/** Reserves (raw) behind the two slots when the slots are the reserves themselves (kinds 1/2). */
export const slotReserves = (obsData: Uint8Array, poolData: Uint8Array) => ({ amount0: tokenAmount(obsData), amount1: tokenAmount(poolData) });

/** Canonical PumpSwap pool for a pump.fun coin, same seeds as programs/hooked/src/processor.rs (burn venue). */
export function pumpSwapCanonicalPool(mint: PublicKey): PublicKey {
  const [auth] = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mint.toBuffer()], PUMP_PROGRAM);
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), Buffer.alloc(2), auth.toBuffer(), mint.toBuffer(), WSOL.toBuffer()], PUMPSWAP_PROGRAM)[0];
}

/** Constant-product cost of moving the price 1%: buy until y' = y*sqrt(1.01), i.e. ~0.499% of the quote reserve. */
export const MOVE_1PCT = Math.sqrt(1.01) - 1;

// ---------- discovery: every venue pool for a mint against SOL/USDC/USDT ----------
export type PoolCandidate = VenuePool & {
  quote: Exclude<OracleQuote, "?">;
  /** The coin sits at token0 (underlying_is_token0 = 1) or token1. */
  flag: 0 | 1;
  /** USD figures from the venue's API when it publishes them. */
  tvl: number | null;
  volume24h: number | null;
  /** Raw quote-token units inside the pool (depth = manipulation cost for AMMs). */
  quoteReserve: bigint | null;
  quoteDecimals: number;
  /** Raw CLMM observation account (kind 0 only) for oracle health. */
  obsData: Uint8Array | null;
};

const QUOTE_MINTS = [WSOL.toBase58(), USDC, USDT];
const fetchJson = async (u: string): Promise<any> => {
  const r = await fetch(u, { signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new Error(`${new URL(u).host} ${r.status}`);
  return r.json();
};
type ApiRow = { id: PublicKey; venue: Venue; tvl: number | null; volume24h: number | null };

/** Raydium v3, one query per quote so a coin with many meme/meme pairs keeps its SOL/USDC pools on the first page. */
async function raydiumRows(mint: PublicKey, poolType: "concentrated" | "standard", program: PublicKey, venue: Venue): Promise<ApiRow[]> {
  const pages = await Promise.all(
    QUOTE_MINTS.map((q) =>
      fetchJson(`https://api-v3.raydium.io/pools/info/mint?mint1=${mint.toBase58()}&mint2=${q}&poolType=${poolType}&poolSortField=liquidity&sortType=desc&pageSize=12&page=1`)
        .then((j) => (j?.data?.data ?? []) as any[])
        .catch(() => [] as any[]),
    ),
  );
  const out: ApiRow[] = [];
  for (const p of pages.flat()) {
    if (p?.programId !== program.toBase58()) continue;
    out.push({ id: new PublicKey(p.id), venue, tvl: Number(p.tvl ?? 0), volume24h: Number(p.day?.volume ?? 0) });
  }
  return out;
}
/** Meteora data API (damm-v2 / dlmm .datapi.meteora.ag): `query=<mint>` matches the mint on either side. */
async function meteoraRows(mint: PublicKey, host: "damm-v2" | "dlmm", venue: Venue): Promise<ApiRow[]> {
  const j = await fetchJson(`https://${host}.datapi.meteora.ag/pools?query=${mint.toBase58()}&sort_by=tvl:desc&page_size=50&page=1`).catch(() => null);
  const m = mint.toBase58();
  return ((j?.data ?? []) as any[])
    .filter((p) => p?.address && (p.token_x?.address === m || p.token_y?.address === m) && !p.is_blacklisted)
    .map((p) => ({ id: new PublicKey(p.address), venue, tvl: Number(p.tvl ?? 0), volume24h: Number(p.volume?.["24h"] ?? 0) }));
}
/** PumpSwap: the canonical pool is a PDA; swap-api adds liquidityUSD when reachable (it publishes no volume). */
async function pumpSwapRows(mint: PublicKey): Promise<ApiRow[]> {
  const pool = pumpSwapCanonicalPool(mint);
  const j = await fetchJson(`https://swap-api.pump.fun/v1/pools/pair?mintA=${mint.toBase58()}&mintB=${WSOL.toBase58()}`).catch(() => null);
  const hit = Array.isArray(j) ? j.find((p: any) => p?.address === pool.toBase58()) : null;
  const tvl = hit ? Number(hit.liquidityUSD) : NaN;
  return [{ id: pool, venue: "pumpswap", tvl: Number.isFinite(tvl) ? tvl : null, volume24h: null }];
}

/**
 * Every oracle-capable pool for `mint` across the five venues, with slots, reserves and API figures. Two RPC round
 * trips: the pool accounts, then the CLMM observations + quote reserve accounts. `only` restricts the venues queried.
 */
export async function discoverPools(conn: Connection, mint: PublicKey, only?: Venue[]): Promise<PoolCandidate[]> {
  const want = (v: Venue) => !only || only.includes(v);
  const lists = await Promise.all([
    want("clmm") ? raydiumRows(mint, "concentrated", RAYDIUM_CLMM, "clmm") : [],
    want("cpmm") ? raydiumRows(mint, "standard", RAYDIUM_CPMM_PROGRAM, "cpmm") : [],
    want("pumpswap") ? pumpSwapRows(mint) : [],
    want("dammv2") ? meteoraRows(mint, "damm-v2", "dammv2") : [],
    want("dlmm") ? meteoraRows(mint, "dlmm", "dlmm") : [],
  ]);
  const seen = new Set<string>();
  const rows = lists.flat().filter((r) => (seen.has(r.id.toBase58()) ? false : (seen.add(r.id.toBase58()), true)));
  if (!rows.length) return [];
  const infos = await conn.getMultipleAccountsInfo(rows.map((r) => r.id));
  const decoded = rows.map((r, i) => (infos[i] ? decodeVenuePool(r.id, infos[i]!.owner, infos[i]!.data) : null));
  // second pass: CLMM observation rings + the quote-side reserve accounts
  const need: PublicKey[] = [];
  const at = decoded.map((p) => {
    if (!p) return null;
    const flag: 0 | 1 = p.mint0.equals(mint) ? 1 : 0;
    const other = flag ? p.mint1 : p.mint0;
    const quote = quoteSymbolOf(other);
    if (quote === "?" || !(flag ? p.mint0 : p.mint1).equals(mint)) return null;
    // CLMM: its observation ring (health); AMMs: the quote-side reserve account (depth)
    const second = p.venue === "clmm" ? p.slotObs : flag ? p.reserve1 : p.reserve0;
    const idx = second ? need.push(second) - 1 : -1;
    return { flag, quote, idx };
  });
  const extra = need.length ? await conn.getMultipleAccountsInfo(need) : [];
  const out: PoolCandidate[] = [];
  decoded.forEach((p, i) => {
    const a = at[i];
    if (!p || !a) return;
    const ex = a.idx >= 0 ? extra[a.idx] : null;
    out.push({
      ...p,
      quote: a.quote,
      flag: a.flag,
      tvl: rows[i].tvl,
      volume24h: rows[i].volume24h,
      quoteReserve: p.venue !== "clmm" && ex ? tokenAmount(ex.data) : null,
      quoteDecimals: QUOTE_DECIMALS[a.quote],
      obsData: p.venue === "clmm" && ex ? ex.data : null,
    });
  });
  return out;
}

/** The quote the venue actually prices against: the reserve, plus PumpSwap's virtual quote. null = unusable (none, or
 *  PumpSwap's effective quote is not positive). */
export function candidateEffectiveQuote(c: PoolCandidate): bigint | null {
  if (c.quoteReserve === null) return null;
  return c.venue === "pumpswap" ? pumpSwapEffectiveQuote(c.quoteReserve, c.virtualQuote) : c.quoteReserve;
}
/** USD value of a candidate's TVL: the API figure, else twice the quote reserve (constant-product pools split evenly). */
export function candidateTvlUsd(c: PoolCandidate, solUsd: number | null): number | null {
  if (c.tvl !== null) return c.tvl;
  const q = c.quote === "SOL" ? solUsd : 1;
  if (c.quoteReserve === null || !q) return null;
  return (2 * Number(c.quoteReserve) * q) / 10 ** c.quoteDecimals;
}
/** Quote it takes to move an AMM's price 1% right now, in the quote's own units (depth = the effective quote). */
export function candidateMove1PctQuote(c: PoolCandidate): number | null {
  const eff = candidateEffectiveQuote(c);
  return c.venue === "clmm" || eff === null ? null : (Number(eff) * MOVE_1PCT) / 10 ** c.quoteDecimals;
}
/** USD it takes to move an AMM's price 1% right now (null for CLMM: that oracle is judged by its ring instead). */
export function candidateMove1PctUsd(c: PoolCandidate, solUsd: number | null): number | null {
  const q = c.quote === "SOL" ? solUsd : 1;
  const mv = candidateMove1PctQuote(c);
  return mv === null || !q ? null : mv * q;
}
