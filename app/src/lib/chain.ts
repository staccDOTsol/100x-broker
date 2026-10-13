import { Buffer } from "buffer";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  DynamicBondingCurveClient,
  Rounding,
  SwapMode,
  getDeltaAmountBaseUnsigned,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { ALT_AUTHORITY, ALT_FALLBACK, LEVERAGE, PROGRAM_ID, RFSTACC, RPC_URL } from "../config.js";
import { type MarketKeys, cu, settleBeginIx, settleEndIx, settleSwapIx, sideAccounts } from "./hooked.js";
import { MARKET_ORACLE_KIND, type OracleQuote, type Venue, pumpSwapPoolOf, quoteSymbolOf, slotMints, slotSpotTick, venueOfKind } from "./venues.js";

export { quoteSymbolOf, type OracleQuote };

export const conn = new Connection(RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: false });
export const dbc = DynamicBondingCurveClient.create(conn, "confirmed");

const MARKET_LEN = 1008;
const ONE_Q63 = 1n << 63n;

// ---------- decoding ----------
const pk = (d: Uint8Array, o: number) => new PublicKey(d.subarray(o, o + 32));
const u64 = (d: Uint8Array, o: number) => Buffer.from(d).readBigUInt64LE(o);
const i64 = (d: Uint8Array, o: number) => Buffer.from(d).readBigInt64LE(o);
const u32 = (d: Uint8Array, o: number) => Buffer.from(d).readUInt32LE(o);
const u128 = (d: Uint8Array, o: number) => u64(d, o) + (u64(d, o + 8) << 64n);

export type Ckpt = { ts: number; tc: bigint };
export type MarketAccount = {
  key: PublicKey;
  bullMint: PublicKey;
  bearMint: PublicKey;
  oraclePool: PublicKey;
  oracleObs: PublicKey;
  vaultBull: PublicKey;
  vaultBear: PublicKey;
  poolBull: PublicKey;
  poolBear: PublicKey;
  baseVaultBull: PublicKey;
  baseVaultBear: PublicKey;
  lastTwapQ32: bigint;
  keepQ63: [bigint, bigint];
  windowSecs: number;
  lastObsTs: number;
  underlyingIsToken0: number;
  settling: boolean;
  /** 0 = Raydium CLMM (every market before venues existed), 1 PumpSwap, 2 Raydium CPMM, 3 Meteora DAMM v2, 4 Meteora DLMM. */
  oracleKind: number;
  ckpts: Ckpt[];
};

export function decodeMarket(key: PublicKey, d: Uint8Array): MarketAccount {
  const ckpts: Ckpt[] = [];
  for (let i = 0; i < 32; i++) ckpts.push({ ts: u32(d, 496 + i * 16), tc: i64(d, 496 + i * 16 + 8) });
  return {
    key,
    bullMint: pk(d, 8),
    bearMint: pk(d, 40),
    oraclePool: pk(d, 104),
    oracleObs: pk(d, 136),
    vaultBull: pk(d, 168),
    vaultBear: pk(d, 200),
    poolBull: pk(d, 232),
    poolBear: pk(d, 264),
    baseVaultBull: pk(d, 296),
    baseVaultBear: pk(d, 328),
    lastTwapQ32: i64(d, 424),
    keepQ63: [u64(d, 432), u64(d, 440)],
    windowSecs: u32(d, 480),
    lastObsTs: u32(d, 484),
    underlyingIsToken0: d[489],
    settling: d[490] === 1,
    oracleKind: d[MARKET_ORACLE_KIND],
    ckpts,
  };
}

export async function listMarketKeys(): Promise<PublicKey[]> {
  const res = await conn.getProgramAccounts(PROGRAM_ID, {
    dataSlice: { offset: 0, length: 0 },
    // "hookmkt1" in base58: some upstreams (FluxRPC) reject base64 memcmp filters
    filters: [{ dataSize: MARKET_LEN }, { memcmp: { offset: 0, bytes: "JU9tGcfh7on" } }],
  });
  return res.map((r) => r.pubkey);
}

/** Token-2022 TokenMetadata extension (type 19): name/symbol/uri. */
export function tokenMetadata(mintData: Uint8Array): { name: string; symbol: string; decimals: number } {
  const b = Buffer.from(mintData);
  const decimals = b[44];
  let o = 166;
  while (o + 4 <= b.length) {
    const t = b.readUInt16LE(o);
    const l = b.readUInt16LE(o + 2);
    if (t === 0) break;
    if (t === 19) {
      let p = o + 4 + 64;
      const str = () => {
        const n = b.readUInt32LE(p);
        const s = b.subarray(p + 4, p + 4 + n).toString("utf8");
        p += 4 + n;
        return s;
      };
      const name = str();
      const symbol = str();
      return { name, symbol, decimals };
    }
    o += 4 + l;
  }
  return { name: "", symbol: "", decimals };
}

// ---------- oracle model (mirrors programs/hooked/src/oracle.rs) ----------
type Pt = { ts: number; tc: bigint };
function ring(d: Uint8Array) {
  const idx = Buffer.from(d).readUInt16LE(17);
  const pts: Pt[] = [];
  for (let i = 0; i < 100; i++) pts.push({ ts: u32(d, 51 + i * 44), tc: i64(d, 51 + i * 44 + 4) });
  return { idx, pts };
}
/** Dead rings (no observation for an hour) switch the market to sampling the pool's own tick; mirror that here. */
export const RING_STALE_SECS = 3600;
export function twapNow(obs: Uint8Array, ckpts: Ckpt[], window: number, sample?: { now: number; tick: number }) {
  const { idx, pts } = ring(obs);
  let end = pts[idx];
  if (sample && end.ts + RING_STALE_SECS < sample.now) {
    const newest = ckpts.filter((c) => c.ts > 0).sort((a, b) => b.ts - a.ts)[0];
    const base = newest && newest.ts >= end.ts ? newest : end;
    const dt = BigInt(Math.max(0, sample.now - base.ts));
    end = { ts: sample.now, tc: base.tc + BigInt(sample.tick) * dt };
  }
  const target = Math.max(0, end.ts - window);
  let best: Pt | undefined;
  let oldest = end;
  for (const p of [...pts, ...ckpts]) {
    if (p.ts === 0 || p.ts > end.ts) continue;
    if (p.ts <= target && (!best || p.ts > best.ts)) best = p;
    if (p.ts < oldest.ts) oldest = p;
  }
  const start = best ?? oldest;
  if (start.ts === end.ts) return { endTs: end.ts, twapQ32: null as bigint | null };
  return { endTs: end.ts, twapQ32: ((end.tc - start.tc) << 32n) / BigInt(end.ts - start.ts) };
}

/** TWAP for a market that samples the venue itself (kinds 1-4, or a CLMM with a dead ring): the newest checkpoint extended
 *  with the live tick to `now`, averaged back to the newest checkpoint at or before now - window (else the oldest). Mirrors
 *  oracle.rs `read_sampled` with no ring. */
export function ckptTwapNow(ckpts: Ckpt[], window: number, now: number, tick: number) {
  const valid = ckpts.filter((c) => c.ts > 0);
  const newest = valid.sort((a, b) => b.ts - a.ts)[0];
  if (!newest || !Number.isFinite(tick)) return { endTs: now, twapQ32: null as bigint | null };
  const end: Pt = { ts: now, tc: newest.tc + BigInt(Math.round(tick)) * BigInt(Math.max(0, now - newest.ts)) };
  const target = Math.max(0, end.ts - window);
  let best: Pt | undefined;
  let oldest: Pt = end;
  for (const p of valid) {
    if (p.ts > end.ts) continue;
    if (p.ts <= target && (!best || p.ts > best.ts)) best = p;
    if (p.ts < oldest.ts) oldest = p;
  }
  const start = best ?? oldest;
  if (start.ts === end.ts) return { endTs: end.ts, twapQ32: null as bigint | null };
  return { endTs: end.ts, twapQ32: ((end.tc - start.tc) << 32n) / BigInt(end.ts - start.ts) };
}

/** Tick steps between the market's own checkpoints (what a sampled market records), oldest first. */
export function ckptSeries(ckpts: Ckpt[]) {
  const sorted = ckpts.filter((c) => c.ts > 0).sort((a, b) => a.ts - b.ts);
  const out: { ts: number; tick: number }[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const dt = sorted[i].ts - sorted[i - 1].ts;
    if (dt > 0) out.push({ ts: sorted[i].ts, tick: Number(sorted[i].tc - sorted[i - 1].tc) / dt });
  }
  return out;
}

/** Spot-tick steps between stored observations, oldest first. */
export function oracleSeries(obs: Uint8Array) {
  const { pts } = ring(obs);
  const sorted = pts.filter((p) => p.ts > 0).sort((a, b) => a.ts - b.ts);
  const out: { ts: number; tick: number }[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const dt = sorted[i].ts - sorted[i - 1].ts;
    if (dt > 0) out.push({ ts: sorted[i].ts, tick: Number(sorted[i].tc - sorted[i - 1].tc) / dt });
  }
  return out;
}

export const keepFactor = (duQ32: bigint) =>
  Math.pow(1.0001, (-LEVERAGE * Number(duQ32 < 0n ? -duQ32 : duQ32)) / 2 ** 32);

// ---------- full market view ----------
export type MarketView = {
  acct: MarketAccount;
  keys: MarketKeys;
  ticker: string;
  underlyingMint: string;
  side: [SideView, SideView];
  oracle: {
    series: { ts: number; price: number }[];
    spot: number;
    twap: number | null;
    lastTwap: number;
    updatedTs: number;
    quote: OracleQuote;
    /** Which kind of pool the market reads its price from. */
    venue: Venue;
  };
  /** Transfer the next poke/transfer would make, from `payer` side. */
  pending: { payer: 0 | 1; amount: bigint; keep: number } | null;
};
export type SideView = {
  name: string;
  symbol: string;
  decimals: number;
  vault: bigint;
  supply: bigint;
  circulating: bigint;
  curvePrice: number; // r-fstacc per token
  nav: number; // r-fstacc per token if redeemed (before fee)
  leverage: number; // effective leverage if this side wins next move
  owed: number; // fraction of curve price still owed to settle (0 = none)
  keepQ63: bigint;
  unclaimed: bigint; // partner trading fees (r-fstacc) still inside the DBC pool
  reserve: bigint; // quote inside the curve (what sells can extract)
  atFloor: boolean; // curve sits at its launch price: nothing left to extract, sells return nothing
};

export async function loadMarketView(key: PublicKey): Promise<MarketView | null> {
  const mi = await conn.getAccountInfo(key);
  if (!mi) return null;
  const a = decodeMarket(key, mi.data);
  const accts = await conn.getMultipleAccountsInfo([
    a.vaultBull, a.vaultBear, a.poolBull, a.poolBear, a.bullMint, a.bearMint, a.baseVaultBull, a.baseVaultBear,
    a.oracleObs, a.oraclePool,
  ]);
  const [vB, vR, pB, pR, mB, mR, bvB, bvR, obs, opool] = accts;
  if (!vB || !vR || !pB || !pR || !mB || !mR || !bvB || !bvR || !obs || !opool) return null;
  const cfg = await dbc.state.getPoolConfig(pk(pB.data, 72));
  const startSqrt = cfg ? BigInt(cfg.sqrtStartPrice.toString()) : 0n;
  const keys: MarketKeys = {
    key, bullMint: a.bullMint, bearMint: a.bearMint, oraclePool: a.oraclePool, oracleObs: a.oracleObs,
    windowSecs: a.windowSecs, underlyingIsToken0: a.underlyingIsToken0, config: pk(pB.data, 72),
    // kind 0 keys stay exactly what they were (the builders only look at these for kinds >= 1)
    ...(a.oracleKind ? { oracleKind: a.oracleKind } : {}),
  };
  const venue = venueOfKind(a.oracleKind);
  const nowTs = Math.floor(Date.now() / 1000);
  // kind 0: decimals and mints come from the CLMM pool; kinds 1-4: mints from the slot accounts, decimals from the mints
  let d0: number, d1: number, underlyingMint: string, oracleQuote: OracleQuote;
  // kind 1: the PumpSwap Pool (virtual_quote_reserves for the price; trailing account for poke/settle/redeem)
  let venuePoolData: Uint8Array | undefined;
  if (venue === "clmm") {
    d0 = opool.data[233];
    d1 = opool.data[234];
    underlyingMint = pk(opool.data, a.underlyingIsToken0 ? 73 : 105).toBase58();
    oracleQuote = quoteSymbolOf(pk(opool.data, a.underlyingIsToken0 ? 105 : 73));
  } else {
    const { mint0, mint1 } = slotMints(venue, obs.data, opool.data);
    const [[m0, m1], psPool] = await Promise.all([
      conn.getMultipleAccountsInfo([mint0, mint1]),
      venue === "pumpswap" ? pumpSwapPoolOf(conn, a.bullMint, a.oracleObs, a.oraclePool, obs.data) : null,
    ]);
    if (!m0 || !m1) return null;
    if (psPool) {
      keys.venuePool = psPool.key;
      venuePoolData = psPool.data;
    }
    d0 = m0.data[44];
    d1 = m1.data[44];
    underlyingMint = (a.underlyingIsToken0 ? mint0 : mint1).toBase58();
    oracleQuote = quoteSymbolOf(a.underlyingIsToken0 ? mint1 : mint0);
  }
  const tickToPrice = (tick: number) =>
    a.underlyingIsToken0
      ? Math.pow(1.0001, tick) * 10 ** (d0 - d1)
      : Math.pow(1.0001, -tick) * 10 ** (d1 - d0);

  const vaults = [u64(vB.data, 64), u64(vR.data, 64)];
  const mk = (i: 0 | 1, mint: typeof mB, pool: typeof pB, bv: typeof bvB): SideView => {
    const meta = tokenMetadata(mint.data);
    const supply = u64(mint.data, 36);
    const circulating = supply - u64(bv.data, 64);
    const sqrt = Number(u128(pool.data, 280)) / 2 ** 64;
    const curvePrice = sqrt * sqrt * 10 ** (meta.decimals - 9);
    const nav = circulating > 0n ? Number(vaults[i]) / 1e9 / (Number(circulating) / 10 ** meta.decimals) : 0;
    const other = vaults[1 - i];
    return {
      ...meta, supply, circulating, curvePrice, nav, vault: vaults[i],
      leverage: vaults[i] > 0n ? (LEVERAGE * Number(other)) / Number(vaults[i]) : other > 0n ? Infinity : NaN,
      owed: 1 - Number(a.keepQ63[i]) / 2 ** 63,
      keepQ63: a.keepQ63[i],
      unclaimed: u64(pool.data, 272),
      reserve: u64(pool.data, 240),
      atFloor: u128(pool.data, 280) <= startSqrt + startSqrt / 1_000_000_000n, // a hair above the floor is still empty (InsufficientLiquidity on any sell)
    };
  };
  const side: [SideView, SideView] = [mk(0, mB, pB, bvB), mk(1, mR, pR, bvR)];

  let rawSeries: { ts: number; tick: number }[];
  let now: { endTs: number; twapQ32: bigint | null };
  if (venue === "clmm") {
    // a dead ring means the market samples the pool itself: chart its checkpoints + the live tick instead
    const poolTick = Buffer.from(opool.data).readInt32LE(269);
    const { idx: ringIdx, pts: ringPts } = ring(obs.data);
    const sampled = ringPts[ringIdx].ts + RING_STALE_SECS < nowTs;
    rawSeries = sampled ? [...ckptSeries(a.ckpts), { ts: nowTs, tick: poolTick }] : oracleSeries(obs.data);
    now = twapNow(obs.data, a.ckpts, a.windowSecs, { now: Math.floor(Date.now() / 1000), tick: Buffer.from(opool.data).readInt32LE(269) });
  } else {
    // AMM venues have no ring: the program samples the pool every settle; its checkpoints + the live spot are the series
    const spotTick = slotSpotTick(venue, obs.data, opool.data, venuePoolData);
    rawSeries = [...ckptSeries(a.ckpts), ...(Number.isFinite(spotTick) ? [{ ts: nowTs, tick: spotTick }] : [])];
    now = ckptTwapNow(a.ckpts, a.windowSecs, nowTs, spotTick);
  }
  const series = rawSeries.map((p) => ({ ts: p.ts, price: tickToPrice(p.tick) }));
  let pending: MarketView["pending"] = null;
  if (now.twapQ32 !== null && now.endTs > a.lastObsTs) {
    const dTick = now.twapQ32 - a.lastTwapQ32;
    const du = a.underlyingIsToken0 ? dTick : -dTick;
    if (du !== 0n) {
      const keep = keepFactor(du);
      const payer: 0 | 1 = du > 0n ? 1 : 0;
      pending = { payer, keep, amount: BigInt(Math.floor(Number(vaults[payer]) * (1 - keep))) };
    }
  }
  const ticker = side[0].name.replace(/\s*100x\s*UP$/i, "") || side[0].symbol;
  return {
    acct: a,
    keys,
    ticker,
    underlyingMint,
    side,
    oracle: {
      series,
      spot: series.length ? series[series.length - 1].price : NaN,
      twap: now.twapQ32 === null ? null : tickToPrice(Number(now.twapQ32) / 2 ** 32),
      lastTwap: tickToPrice(Number(a.lastTwapQ32) / 2 ** 32),
      updatedTs: now.endTs,
      quote: oracleQuote,
      venue,
    },
    pending,
  };
}

export type Balances = { sol: bigint; quote: bigint; up: bigint; down: bigint };
export async function userBalances(owner: PublicKey, v: MarketView): Promise<Balances> {
  const atas = [
    owner,
    getAssociatedTokenAddressSync(RFSTACC, owner),
    getAssociatedTokenAddressSync(v.keys.bullMint, owner, false, TOKEN_2022_PROGRAM_ID),
    getAssociatedTokenAddressSync(v.keys.bearMint, owner, false, TOKEN_2022_PROGRAM_ID),
  ];
  const infos = await conn.getMultipleAccountsInfo(atas);
  const bal = (i: number) => (infos[i] ? u64(infos[i]!.data, 64) : 0n);
  // keep 0.01 SOL back for fees/rent
  const sol = BigInt(infos[0]?.lamports ?? 0);
  return { sol: sol > 10_000_000n ? sol - 10_000_000n : 0n, quote: bal(1), up: bal(2), down: bal(3) };
}

// ---------- settle sizing: exact base amount from the DBC curve ----------
function isqrt(n: bigint) {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
function scaleSqrt(s0: bigint, keepQ63: bigint) {
  const k = isqrt(keepQ63 << 65n);
  return (s0 >> 64n) * k + (((s0 & ((1n << 64n) - 1n)) * k) >> 64n);
}

/** Base tokens the curve can still absorb: everything between its launch price and the current price. */
export async function curveCapacity(v: MarketView, sideIdx: 0 | 1): Promise<bigint> {
  const poolKey = sideIdx === 0 ? v.acct.poolBull : v.acct.poolBear;
  const pool = await dbc.state.getPool(poolKey);
  const config = pool && (await dbc.state.getPoolConfig(pool.poolState.config));
  if (!pool || !config) return 0n;
  const s0 = BigInt(pool.poolState.sqrtPrice.toString());
  let lower = BigInt(config.sqrtStartPrice.toString());
  let base = 0n;
  for (const pt of config.curve as { sqrtPrice: BN; liquidity: BN }[]) {
    const upper = BigInt(pt.sqrtPrice.toString());
    if (upper === 0n) break;
    const hi = s0 < upper ? s0 : upper;
    if (hi > lower) base += BigInt(getDeltaAmountBaseUnsigned(new BN(lower.toString()), new BN(hi.toString()), pt.liquidity, Rounding.Down).toString());
    lower = upper;
    if (upper >= s0) break;
  }
  return base;
}

/** Base tokens to sell so the losing curve's sqrt price lands on (not past) its owed target. */
export async function settleAmount(v: MarketView, sideIdx: 0 | 1): Promise<bigint> {
  const poolKey = sideIdx === 0 ? v.acct.poolBull : v.acct.poolBear;
  const pool = await dbc.state.getPool(poolKey);
  const config = pool && (await dbc.state.getPoolConfig(pool.poolState.config));
  if (!pool || !config) throw new Error("pool not found");
  const s0 = BigInt(pool.poolState.sqrtPrice.toString());
  const keep = v.side[sideIdx].keepQ63;
  if (keep >= ONE_Q63) return 0n;
  let target = scaleSqrt(s0, keep);
  const start = BigInt(config.sqrtStartPrice.toString());
  if (target < start) target = start;
  let base = 0n;
  let lower = start;
  for (const pt of config.curve as { sqrtPrice: BN; liquidity: BN }[]) {
    const upper = BigInt(pt.sqrtPrice.toString());
    if (upper === 0n) break;
    const lo = target > lower ? target : lower;
    const hi = s0 < upper ? s0 : upper;
    if (hi > lo) {
      base += BigInt(
        getDeltaAmountBaseUnsigned(new BN(lo.toString()), new BN(hi.toString()), pt.liquidity, Rounding.Down).toString(),
      );
    }
    lower = upper;
  }
  return base;
}

export async function buildSettleTx(v: MarketView, sideIdx: 0 | 1, caller: PublicKey) {
  const est = await settleAmount(v, sideIdx);
  if (est <= 0n) throw new Error("Nothing to collect right now: that curve is sitting at its floor. It gets collected the moment it trades above it.");
  const a = sideAccounts(v.keys, sideIdx);
  const sdk = await dbc.pool.swap2WithTransferHook({
    owner: caller, pool: a.pool, swapBaseForQuote: true, referralTokenAccount: null, payer: caller,
    swapMode: SwapMode.ExactIn, amountIn: new BN(1), minimumAmountOut: new BN(0),
  });
  const swapIx = sdk.instructions.find((ix) => ix.programId.toBase58().startsWith("dbcij"))!;
  const sim = async (amount: bigint) => {
    const vtx = await toV0([cu(1_000_000), settleBeginIx(v.keys, caller, sideIdx, amount), settleSwapIx(swapIx, v.keys, sideIdx, amount), settleEndIx(v.keys, sideIdx)], caller);
    const r = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
    return { vtx, err: r.value.err, logs: r.value.logs ?? [] };
  };
  // the program accepts any amount that lands on or short of its target and rejects a single lamport past it; the estimate is
  // usually a hair over, so search below it for the largest amount that simulates (same approach as the keeper)
  const first = await sim(est);
  if (!first.err) return { tx: first.vtx, amount: est };
  let lo = 0n, hi = est, best: { vtx: VersionedTransaction; amount: bigint } | null = null, lastFail = first;
  for (let i = 0; i < 14 && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n;
    const r = await sim(mid);
    if (!r.err) {
      lo = mid;
      best = { vtx: r.vtx, amount: mid };
    } else {
      hi = mid;
      lastFail = r;
    }
  }
  if (best) return { tx: best.vtx, amount: best.amount };
  const reason = lastFail.logs.filter((l) => /Error Message:|custom program error|failed:/.test(l)).pop()?.replace(/^Program (log: )?/, "") ?? JSON.stringify(lastFail.err);
  const plain = /NoProceeds/.test(reason)
    ? "that curve is empty right now, so there's nothing to collect. It pays the second anyone buys that side."
    : /InsufficientLiquidity/.test(reason)
      ? "that curve has no SOL left in it to pay out. It pays the second anyone buys that side."
      : reason;
  throw new Error(`Couldn't collect: ${plain}`);
}

// Lookup tables keep every tx well under 1232 bytes (a stranger's SOL->Ape is 1234 bytes raw). The keeper opens a new table
// whenever the current ones fill up (256 each), so we load every table it owns; a v0 message only references the ones it uses.
let altCache: { at: number; v: AddressLookupTableAccount[] } | null = null;
async function lookupTables(): Promise<AddressLookupTableAccount[]> {
  if (altCache && Date.now() - altCache.at < 60_000) return altCache.v;
  try {
    const res = await conn.getProgramAccounts(AddressLookupTableProgram.programId, { filters: [{ memcmp: { offset: 22, bytes: ALT_AUTHORITY.toBase58() } }] });
    const live = res
      .map(({ pubkey, account }) => new AddressLookupTableAccount({ key: pubkey, state: AddressLookupTableAccount.deserialize(account.data) }))
      .filter((t) => BigInt(t.state.deactivationSlot.toString()) === 2n ** 64n - 1n);
    // if the scan is ever refused, fall back to the tables we know about by address (never just the first, full one)
    const v = live.length ? live : (await Promise.all(ALT_FALLBACK.map((k) => conn.getAddressLookupTable(k).then((r) => r.value)))).filter((t): t is AddressLookupTableAccount => !!t);
    altCache = { at: Date.now(), v };
    return v;
  } catch {
    // the scan itself failed (rate limit, or an upstream that refuses program scans): the tables we know by address beat none at all
    if (altCache) return altCache.v;
    try {
      const v = (await Promise.all(ALT_FALLBACK.map((k) => conn.getAddressLookupTable(k).then((r) => r.value)))).filter((t): t is AddressLookupTableAccount => !!t);
      if (v.length) altCache = { at: Date.now(), v };
      return v;
    } catch {
      return [];
    }
  }
}

export async function toV0(ixs: TransactionInstruction[], payer: PublicKey, extraTables: AddressLookupTableAccount[] = []) {
  const [{ blockhash }, tables] = await Promise.all([conn.getLatestBlockhash("confirmed"), lookupTables()]);
  return new VersionedTransaction(
    new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message([...tables, ...extraTables]),
  );
}

export async function legacyToV0(tx: Transaction, payer: PublicKey) {
  return toV0(tx.instructions, payer);
}

// ---------- send + confirm by polling (no websockets through the RPC proxy) ----------
export class TxFailed extends Error {
  constructor(public sig: string, public detail: unknown) {
    super(`transaction failed: ${JSON.stringify(detail)}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function sendRaw(raw: Uint8Array): Promise<string> {
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3, preflightCommitment: "confirmed" });
  const until = Date.now() + 75_000;
  while (Date.now() < until) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new TxFailed(sig, st.err);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await sleep(1200);
  }
  throw new Error(`not confirmed in time: ${sig}`);
}

export function explorer(sig: string) {
  return `https://solscan.io/tx/${sig}`;
}

/** How usable a Raydium CLMM pool is as an oracle right now. */
export type OracleHealth = { observations: number; lastAgeSecs: number; spanSecs: number; ok: boolean; sampled: boolean };
export function oracleHealth(obs: Uint8Array, nowTs = Math.floor(Date.now() / 1000)): OracleHealth {
  const { pts } = ring(obs);
  const valid = pts.filter((p) => p.ts > 0).map((p) => p.ts).sort((a, b) => a - b);
  const last = valid.length ? valid[valid.length - 1] : 0;
  const h = {
    observations: valid.length,
    lastAgeSecs: last ? Math.max(0, nowTs - last) : Infinity,
    spanSecs: valid.length > 1 ? last - valid[0] : 0,
  };
  // a dead ring is fine: the market samples the pool's tick itself (see RING_STALE_SECS)
  return { ...h, ok: h.observations >= 1, sampled: h.lastAgeSecs > RING_STALE_SECS };
}

/** Markets already listed on a given oracle_obs slot (CLMM observation ring, PumpSwap base ATA, CPMM token-0 vault, Meteora
 *  pool), any window. */
export async function marketsForOracle(obs: PublicKey): Promise<PublicKey[]> {
  const res = await conn.getProgramAccounts(PROGRAM_ID, {
    dataSlice: { offset: 0, length: 0 },
    filters: [{ dataSize: MARKET_LEN }, { memcmp: { offset: 136, bytes: obs.toBase58() } }],
  });
  return res.map((r) => r.pubkey);
}
