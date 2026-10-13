// Multi-venue oracle e2e on a surfpool mainnet fork: one ±100x market per oracle_kind 1..4, each on a REAL mainnet
// pool (PumpSwap, Raydium CPMM, Meteora DAMM v2, Meteora DLMM) that the fork clones on first touch. No mock pools.
//
//   full run   : surfpool start on :8899 with the program deployed, then      bun e2e-venues.ts
//   discovery  : RPC="$HELIUS_RPC_URL" DISCOVER_ONLY=1 bun e2e-venues.ts        (mainnet; proves pools + off-chain ticks are real)
//
// Env: RPC (default http://127.0.0.1:8899) | PAYER (default test-payer.json) | KINDS (default 1,2,3,4) | WINDOW_SECS (default 600)
//      NUDGE_BPS (default 100: after the flat-price settle window the coin is pushed up 1% on the fork and the loser vault must pay;
//      0 skips that phase) | PUMP_MINT / CPMM_POOL / DAMM_POOL / DLMM_POOL force a specific pool instead of the API pick.
//
// Per kind:  discover pool via the venue's API -> fetch + decode the account (offsets documented below, mints asserted against the
// API) -> DBC hook config + UP/DOWN curves -> create_market(kind byte, slot accounts, trailing venue pool) -> read back oracle_kind,
// last_twap_q32 vs the tick computed here -> warp one window (surfnet_timeTravel) -> poke -> ckpt_head advanced, TWAP sane ->
// [NUDGE] push price 1%, warp, poke, vault transfer matches 1-1.0001^(-100·Δ) -> kind 1 only: buy through the hook (extras list
// resolves) and run the settle sandwich for the losing curve.
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  MigrationOption,
  SwapMode,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithMarketCap,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
// @ts-ignore scripts/ ships bn.js without @types/bn.js (e2e.ts has the same untyped import); only used to box SDK amounts
import BN from "bn.js";
import fs from "fs";
import os from "os";
import {
  DBC,
  PROGRAM_ID,
  PUMPSWAP,
  RFSTACC,
  WSOL_MINT,
  createMarketIx,
  cu,
  marketPda,
  memeVenue,
  pokeIx,
  readMarket,
  send,
  settleBeginIx,
  settleEndIx,
  sideAccounts,
  tokenBalance,
  type Market,
} from "./lib";

// ---------------------------------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------------------------------
const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const DISCOVER_ONLY = process.env.DISCOVER_ONLY === "1";
const WINDOW = Number(process.env.WINDOW_SECS ?? 600);
const NUDGE_BPS = Number(process.env.NUDGE_BPS ?? 100);
const KINDS = (process.env.KINDS ?? "1,2,3,4").split(",").map((s) => Number(s.trim())).filter((k) => k >= 1 && k <= 4) as Kind[];
const conn = new Connection(RPC, "confirmed");
const E9 = 1_000_000_000n;
const LN_TICK = Math.log(1.0001);

const RAYDIUM_CPMM = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const METEORA_DAMM_V2 = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const METEORA_DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const USD1 = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB";
const STABLES = new Set([USDC, USDT, USD1]);

// ---------------------------------------------------------------------------------------------------------------------
// ON-CHAIN CONTRACT — the only block to touch if the program's final spec differs from the one this test was written to.
// ---------------------------------------------------------------------------------------------------------------------
type Kind = 1 | 2 | 3 | 4;
const KIND_NAME: Record<Kind, string> = { 1: "PumpSwap", 2: "Raydium CPMM", 3: "Meteora DAMM v2", 4: "Meteora DLMM" };

/** Market.oracle_kind: the byte right after ckpt_head (state.rs ORACLE_KIND_OFFSET = 493, layout-tested; app/src/lib/chain.ts agrees). */
const MARKET_ORACLE_KIND_OFFSET = 493;
const MARKET_CKPT_HEAD_OFFSET = 492;
const CKPT_COUNT = 32;
const CKPT_SPACING_SECS = 150;
/** Market account size (unchanged by the upgrade: oracle_kind lives in old padding). */
const MARKET_LEN = 1008;

/** create_market instruction data: existing bytes (tag 0 | window_secs u32 LE | underlying_is_token0 u8) + ONE trailing oracle_kind byte. */
function encodeCreateMarketData(windowSecs: number, underlyingIsToken0: number, kind: Kind): Buffer {
  const d = Buffer.alloc(7);
  d[0] = 0;
  d.writeUInt32LE(windowSecs, 1);
  d[5] = underlyingIsToken0;
  d[6] = kind;
  return d;
}

/** Accounts appended after the 21 existing create_market accounts (lib.ts order). kinds 1/2: the venue pool whose two token
 *  accounts sit in the oracle slots; kinds 3/4: nothing (both slots already are the pool). */
function createMarketTrailingAccounts(kind: Kind, venuePool: PublicKey) {
  return kind === 1 || kind === 2 ? [{ pubkey: venuePool, isSigner: false, isWritable: false }] : [];
}

/** Local, parametrised create_market builder: lib.ts' account list + kind byte + trailing venue account. */
function createMarketVenueIx(payer: PublicKey, m: Market, kind: Kind, venuePool: PublicKey): TransactionInstruction {
  const base = createMarketIx(payer, m);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [...base.keys, ...createMarketTrailingAccounts(kind, venuePool)],
    data: encodeCreateMarketData(m.windowSecs, m.underlyingIsToken0, kind),
  });
}

/** Market.oracle_obs / oracle_pool per kind. The market PDA uses `obs` exactly as today. */
function oracleSlots(kind: Kind, p: { pool: PublicKey; reserve0: PublicKey; reserve1: PublicKey }) {
  switch (kind) {
    case 1: return { obs: p.reserve0, pool: p.reserve1 }; // PumpSwap: base_ata, quote_ata
    case 2: return { obs: p.reserve0, pool: p.reserve1 }; // CPMM: token_0_vault, token_1_vault
    case 3: return { obs: p.pool, pool: p.pool };          // DAMM v2: the pool twice
    case 4: return { obs: p.pool, pool: p.pool };          // DLMM: the LbPair twice
  }
}

/** Trailing read-only accounts after the oracle_pool slot on poke (idx 5 = quote vault, idx 6 = Pool), settle_begin (11/12) and
 *  redeem (13/14). lib.ts already passes the oracle_pool slot; kind 1 additionally needs the PumpSwap Pool (virtual_quote_reserves).
 *  Kind 2's first trailing (token_1_vault) is required; kinds 3/4 optional. Execute reads all of them from the meta list. */
function venueTrailing(kind: Kind, venuePool: PublicKey) {
  return kind === 1 ? [{ pubkey: venuePool, isSigner: false, isWritable: false }] : [];
}
const withVenueTrailing = (ix: TransactionInstruction, kind: Kind, venuePool: PublicKey) =>
  new TransactionInstruction({ programId: ix.programId, keys: [...ix.keys, ...venueTrailing(kind, venuePool)], data: ix.data });

/** ExtraAccountMetaList for Execute: [market(w), obs slot, vault_bull(w), vault_bear(w), Tokenkeg, pool slot] + kind 1: [PumpSwap Pool].
 *  Account size = 8 + 4 + 4 + 35·n (6 -> 226 bytes, 7 -> 261 bytes). */
function expectedExtraMetas(kind: Kind, market: PublicKey, slots: { obs: PublicKey; pool: PublicKey }, vaultBull: PublicKey, vaultBear: PublicKey, venuePool: PublicKey) {
  const base = [market, slots.obs, vaultBull, vaultBear, TOKEN_PROGRAM_ID, slots.pool];
  return kind === 1 ? [...base, venuePool] : base;
}
const metaListLen = (n: number) => 8 + 4 + 4 + 35 * n;

// ---------------------------------------------------------------------------------------------------------------------
// Venue account layouts (byte offsets per each venue's IDL; the same numbers as programs/hooked/src/consts.rs)
// ---------------------------------------------------------------------------------------------------------------------
// PumpSwap `Pool` (pump-amm IDL, Anchor disc f1 9a 6d 04 11 b1 6d bc): disc 8 | pool_bump u8 @8 | index u16 @9 | creator @11 |
//   base_mint @43 | quote_mint @75 | lp_mint @107 | pool_base_token_account @139 | pool_quote_token_account @171 | lp_supply u64 @203 |
//   coin_creator @211 | is_mayhem_mode u8 @243 | virtual_sol_reserves... virtual_quote_reserves i128 @245 (price-only liquidity, no
//   token backing) | ... (live accounts are 211..=301 bytes long depending on when the program last wrote them; the virtual field
//   exists only when len >= 261 and reads 0 otherwise). Oracle price = (quote_vault + virtual_quote_reserves) / base_vault.
const PS = { BASE_MINT: 43, QUOTE_MINT: 75, BASE_ATA: 139, QUOTE_ATA: 171, MIN_LEN: 211, VIRTUAL_QUOTE: 245, VIRTUAL_MIN_LEN: 261 };
const i128 = (d: Uint8Array, o: number) => BigInt.asIntN(128, u128(d, o));
/** PumpSwap Pool.virtual_quote_reserves, 0 for pools written before the field existed. */
const virtualQuote = (poolData: Uint8Array) => (poolData.length >= PS.VIRTUAL_MIN_LEN ? i128(poolData, PS.VIRTUAL_QUOTE) : 0n);
// Raydium CP-Swap `PoolState` (637 bytes): disc 8 | amm_config @8 | pool_creator @40 | token_0_vault @72 | token_1_vault @104 |
//   lp_mint @136 | token_0_mint @168 | token_1_mint @200 | token_0_program @232 | token_1_program @264 | observation_key @296 |
//   auth_bump u8 @328 | status u8 @329 | lp_mint_decimals @330 | mint_0_decimals @331 | mint_1_decimals @332 | lp_supply u64 @333 | ...
const CP = { VAULT0: 72, VAULT1: 104, MINT0: 168, MINT1: 200, DEC0: 331, DEC1: 332, LEN: 637 };
// Meteora DAMM v2 `Pool` (1112 bytes): disc 8 | pool_fees 160 @8 | token_a_mint @168 | token_b_mint @200 | token_a_vault @232 |
//   token_b_vault @264 | whitelisted_vault @296 | partner @328 | liquidity u128 @360 | _padding u128 @376 | protocol_a_fee u64 @392 |
//   protocol_b_fee @400 | partner_a_fee @408 | partner_b_fee @416 | sqrt_min_price u128 @424 | sqrt_max_price u128 @440 |
//   sqrt_price u128 @456 (Q64.64, sqrt(raw token_b per raw token_a)) | activation_point u64 @472 | ...
const DM = { MINT_A: 168, MINT_B: 200, VAULT_A: 232, VAULT_B: 264, SQRT_PRICE: 456, LEN: 1112 };
// Meteora DLMM `LbPair` (904 bytes): disc 8 | StaticParameters 32 @8 | VariableParameters 32 @40 | bump_seed @72 | bin_step_seed [2] @73 |
//   pair_type @75 | active_id i32 @76 | bin_step u16 @80 | status @82 | require_base_factor_seed @83 | base_factor_seed [2] @84 |
//   activation_type @86 | creator_pool_on_off_control @87 | token_x_mint @88 | token_y_mint @120 | reserve_x @152 | reserve_y @184 | ...
//   price of x in y = (1 + bin_step/10_000)^active_id (raw units)
const LB = { ACTIVE_ID: 76, BIN_STEP: 80, MINT_X: 88, MINT_Y: 120, RESERVE_X: 152, RESERVE_Y: 184, LEN: 904 };
// SPL token account (Tokenkeg and Token-2022 share the base layout): mint @0 | owner @32 | amount u64 @64
const TA = { MINT: 0, AMOUNT: 64 };
// SPL mint: decimals u8 @44
const MINT_DECIMALS = 44;

const pk = (d: Uint8Array, o: number) => new PublicKey(d.subarray(o, o + 32));
const u64 = (d: Uint8Array, o: number) => Buffer.from(d).readBigUInt64LE(o);
const u128 = (d: Uint8Array, o: number) => u64(d, o) + (u64(d, o + 8) << 64n);
const i32 = (d: Uint8Array, o: number) => Buffer.from(d).readInt32LE(o);
const u16 = (d: Uint8Array, o: number) => Buffer.from(d).readUInt16LE(o);

// ---------------------------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------------------------
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
  return ok;
}
const fmt9 = (x: bigint) => (Number(x) / 1e9).toFixed(9);
const sleep = (ms: number) => Bun.sleep(ms);
/** programs/hooked/src/error.rs, in order from 0x1000, so a FAIL line names the program error instead of `Custom: 4098`. */
const HOOKED_ERRORS = [
  "InvalidInstruction", "InvalidMarket", "InvalidOracle", "OracleWindowEmpty", "InvalidMint", "InvalidPool", "InvalidVault", "InvalidEscrow",
  "InvalidProgram", "InvalidPda", "MissingSigner", "SettleInProgress", "NotSettling", "NothingOwed", "SettleSandwich", "EscrowNotEmpty",
  "Overshoot", "NoProceeds", "ZeroAmount", "ExceedsCirculating", "MathOverflow", "MemeNotSet", "InvalidVenue", "BurnCooldown", "BurnTooLarge",
  "InvalidBurnAccounts", "InvalidOracleKind", "UnderlyingFlagMismatch",
];
const explainError = (msg: string) =>
  msg.replace(/"Custom":(\d+)/g, (s, n) => (Number(n) >= 0x1000 && HOOKED_ERRORS[Number(n) - 0x1000] ? `${s} (HookedError::${HOOKED_ERRORS[Number(n) - 0x1000]})` : s));

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j: any = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}
/** First URL that answers; the Meteora legacy hosts (dammv2-api / dlmm-api .meteora.ag) now 404 and redirect to *.datapi.meteora.ag. */
async function getJsonFirst(urls: string[]): Promise<{ url: string; json: any }> {
  let last: unknown;
  for (const url of urls) {
    try {
      return { url, json: await getJson(url) };
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`all endpoints failed: ${urls.join(" | ")} :: ${String(last)}`);
}
async function accounts(keys: PublicKey[]) {
  const out: ({ owner: PublicKey; data: Buffer } | null)[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = await conn.getMultipleAccountsInfo(keys.slice(i, i + 100));
    for (const a of chunk) out.push(a ? { owner: a.owner, data: Buffer.from(a.data) } : null);
  }
  return out;
}
async function mintDecimals(mint: PublicKey) {
  const a = await conn.getAccountInfo(mint);
  if (!a) throw new Error(`mint ${mint.toBase58()} not found`);
  return a.data[MINT_DECIMALS]!;
}

// ---------------------------------------------------------------------------------------------------------------------
// Venue model
// ---------------------------------------------------------------------------------------------------------------------
type Venue = {
  kind: Kind;
  name: string;
  /** The venue's own pool account (PumpSwap pool, CPMM pool, DAMM v2 pool, LbPair). */
  pool: PublicKey;
  mint0: PublicKey;
  mint1: PublicKey;
  dec0: number;
  dec1: number;
  /** Token accounts holding the two reserves, in the venue's token0/token1 order. */
  reserve0: PublicKey;
  reserve1: PublicKey;
  /** underlying_is_token0: 1 when the coin is token0 (WSOL is token1), else 0. */
  flag: 0 | 1;
  symbol: string;
  /** What the venue API says the price is (quote per coin, human units) at discovery time, when it publishes one. */
  apiPrice: number | null;
  apiTvl: number | null;
  source: string;
};
/** The price the program should see, computed off-chain from the same bytes it reads. */
type Spot = { tick: number; price: number; detail: string; quantum?: number };

const coinOf = (v: Venue) => (v.flag ? v.mint0 : v.mint1);
/** 1.0001^tick = raw token1 per raw token0 -> human quote per coin. */
function tickToPrice(v: Venue, tick: number) {
  return v.flag ? Math.pow(1.0001, tick) * 10 ** (v.dec0 - v.dec1) : Math.pow(1.0001, -tick) * 10 ** (v.dec1 - v.dec0);
}
function flagFor(mint0: PublicKey, mint1: PublicKey): 0 | 1 {
  if (mint1.equals(WSOL_MINT)) return 1;
  if (mint0.equals(WSOL_MINT)) return 0;
  throw new Error("pool has no WSOL side");
}

/** Tick per kind from the two slot accounts, exactly the convention the program uses:
 *  kind 1: log1.0001((quote_vault + Pool.virtual_quote_reserves)/base_vault); kind 2: log1.0001(amount1/amount0) from the vaults;
 *  kind 3: 2·log1.0001(sqrt_price/2^64); kind 4: active_id·log1.0001(1 + bin_step/1e4). `venuePool` is the PumpSwap Pool (kind 1). */
function spotFromSlots(v: Venue, obs: Buffer, pool: Buffer, venuePool?: Buffer): Spot {
  switch (v.kind) {
    case 1: {
      const b = u64(obs, TA.AMOUNT);
      const q = u64(pool, TA.AMOUNT);
      if (!venuePool) throw new Error("kind 1 needs the PumpSwap Pool account");
      const vq = virtualQuote(venuePool);
      if (b === 0n || q + vq <= 0n) throw new Error("empty reserve");
      const tick = Math.log(Number(q + vq) / Number(b)) / LN_TICK;
      return { tick, price: tickToPrice(v, tick), detail: `base=${b} quote=${q} virtual_quote=${vq} (pool len ${venuePool.length})` };
    }
    case 2: {
      const a0 = u64(obs, TA.AMOUNT);
      const a1 = u64(pool, TA.AMOUNT);
      if (a0 === 0n || a1 === 0n) throw new Error("empty reserve");
      const tick = Math.log(Number(a1) / Number(a0)) / LN_TICK;
      return { tick, price: tickToPrice(v, tick), detail: `amount0=${a0} amount1=${a1}` };
    }
    case 3: {
      const sq = u128(pool, DM.SQRT_PRICE);
      const sqrt = Number(sq) / 2 ** 64;
      const tick = (2 * Math.log(sqrt)) / LN_TICK;
      return { tick, price: tickToPrice(v, tick), detail: `sqrt_price=${sq}` };
    }
    case 4: {
      const id = i32(pool, LB.ACTIVE_ID);
      const bs = u16(pool, LB.BIN_STEP);
      const binTicks = Math.log(1 + bs / 1e4) / LN_TICK;
      const tick = id * binTicks;
      return { tick, price: tickToPrice(v, tick), detail: `active_id=${id} bin_step=${bs}`, quantum: binTicks };
    }
  }
}
async function readSpot(v: Venue): Promise<Spot> {
  const s = oracleSlots(v.kind, v);
  const [obs, pool, venuePool] = await accounts([s.obs, s.pool, v.pool]);
  if (!obs || !pool || !venuePool) throw new Error("oracle slot account missing");
  return spotFromSlots(v, obs.data, pool.data, venuePool.data);
}

// ---------------------------------------------------------------------------------------------------------------------
// Discovery: one real mainnet pool per venue, WSOL-quoted, deepest liquidity, decoded + asserted against the API
// ---------------------------------------------------------------------------------------------------------------------
/** kind 1: top pump.fun coins by market cap; the canonical PumpSwap pool is the PDA the program's burn path derives
 *  (["pool", 0u16, pool-authority(mint), mint, WSOL] under pAMM..., pool-authority = ["pool-authority", mint] under pump). */
async function discoverPumpSwap(): Promise<Venue> {
  type Coin = { mint: string; symbol?: string; complete?: boolean; pump_swap_pool?: string | null; token_program?: string };
  const override = process.env.PUMP_MINT;
  const url = override
    ? `https://frontend-api-v3.pump.fun/coins/${override}`
    : "https://frontend-api-v3.pump.fun/coins?offset=0&limit=100&sort=market_cap&order=DESC&includeNsfw=false";
  const raw = await getJson(url).catch((e) => {
    if (!override) throw e;
    return { mint: override, symbol: "PUMP", complete: true, pump_swap_pool: memeVenue(new PublicKey(override)).pool.toBase58() };
  });
  const coins: Coin[] = Array.isArray(raw) ? raw : [raw];
  const cands = coins
    .filter((c) => c?.mint && c.complete && c.pump_swap_pool)
    .map((c) => ({ c, mint: new PublicKey(c.mint), derived: memeVenue(new PublicKey(c.mint)).pool }))
    // the API must agree that the canonical PDA is the live pool (coins that graduated to Raydium pre-PumpSwap have none)
    .filter((x) => x.derived.toBase58() === x.c.pump_swap_pool);
  if (!cands.length) throw new Error("no pump coin whose canonical PumpSwap PDA matches the API");
  const pools = await accounts(cands.map((x) => x.derived));
  const live = cands
    .map((x, i) => {
      const a = pools[i];
      if (!a || !a.owner.equals(PUMPSWAP) || a.data.length < PS.MIN_LEN) return null;
      const baseMint = pk(a.data, PS.BASE_MINT);
      const quoteMint = pk(a.data, PS.QUOTE_MINT);
      if (!baseMint.equals(x.mint) || !quoteMint.equals(WSOL_MINT)) return null;
      return { ...x, baseMint, quoteMint, baseAta: pk(a.data, PS.BASE_ATA), quoteAta: pk(a.data, PS.QUOTE_ATA) };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (!live.length) throw new Error("no live WSOL-quoted canonical PumpSwap pool among candidates");
  const atas = await accounts(live.flatMap((x) => [x.baseAta, x.quoteAta]));
  const ranked = live
    .map((x, i) => {
      const b = atas[2 * i];
      const q = atas[2 * i + 1];
      if (!b || !q) return null;
      if (!pk(b.data, TA.MINT).equals(x.baseMint) || !pk(q.data, TA.MINT).equals(WSOL_MINT)) return null;
      return { ...x, wsol: u64(q.data, TA.AMOUNT), classic: b.owner.equals(TOKEN_PROGRAM_ID) };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    // deepest WSOL reserve; a classic-SPL base (Tokenkeg ATA) wins over a Token-2022 one at equal depth class
    .sort((a, b) => Number(b.classic) - Number(a.classic) || (b.wsol > a.wsol ? 1 : b.wsol < a.wsol ? -1 : 0));
  const best = ranked[0]!;
  check("kind 1 API mints match decoded pool (base = coin, quote = WSOL)", best.baseMint.equals(best.mint) && best.quoteMint.equals(WSOL_MINT));
  check("kind 1 canonical PDA == API pump_swap_pool", best.derived.toBase58() === best.c.pump_swap_pool, best.derived.toBase58());
  const [dec0, dec1] = await Promise.all([mintDecimals(best.baseMint), mintDecimals(WSOL_MINT)]);
  return {
    kind: 1, name: KIND_NAME[1], pool: best.derived, mint0: best.baseMint, mint1: WSOL_MINT, dec0, dec1,
    reserve0: best.baseAta, reserve1: best.quoteAta, flag: 1, symbol: best.c.symbol ?? "PUMP", apiPrice: null, apiTvl: null,
    source: `frontend-api-v3.pump.fun (${ranked.length} canonical WSOL pools, ${best.classic ? "Tokenkeg" : "Token-2022"} base, ${fmt9(best.wsol)} WSOL)`,
  };
}

/** kind 2: Raydium v3 API, standard pools against WSOL, filtered to the CP-Swap program id. */
async function discoverCpmm(): Promise<Venue> {
  const override = process.env.CPMM_POOL;
  const url = override
    ? `https://api-v3.raydium.io/pools/info/ids?ids=${override}`
    : `https://api-v3.raydium.io/pools/info/mint?mint1=${WSOL_MINT.toBase58()}&poolType=standard&poolSortField=liquidity&sortType=desc&pageSize=100&page=1`;
  const j = await getJson(url);
  const rows: any[] = (override ? j?.data : j?.data?.data) ?? [];
  const cp = rows.filter(
    (p) => p?.programId === RAYDIUM_CPMM.toBase58() && [p.mintA?.address, p.mintB?.address].includes(WSOL_MINT.toBase58()) &&
      !STABLES.has(p.mintA?.address) && !STABLES.has(p.mintB?.address),
  );
  if (!cp.length) throw new Error("no WSOL-quoted CPMM pool in the Raydium API response");
  const row = cp[0];
  const pool = new PublicKey(row.id);
  const [a] = await accounts([pool]);
  if (!a || !a.owner.equals(RAYDIUM_CPMM) || a.data.length !== CP.LEN) throw new Error(`CPMM pool ${row.id} not a ${CP.LEN}-byte CP-Swap PoolState`);
  const mint0 = pk(a.data, CP.MINT0);
  const mint1 = pk(a.data, CP.MINT1);
  const apiMints = new Set([row.mintA.address, row.mintB.address]);
  check("kind 2 API mints match decoded token_0_mint/token_1_mint", apiMints.has(mint0.toBase58()) && apiMints.has(mint1.toBase58()), `${mint0.toBase58()} / ${mint1.toBase58()}`);
  const reserve0 = pk(a.data, CP.VAULT0);
  const reserve1 = pk(a.data, CP.VAULT1);
  const [v0, v1] = await accounts([reserve0, reserve1]);
  check("kind 2 vault mints match pool mints", !!v0 && !!v1 && pk(v0.data, TA.MINT).equals(mint0) && pk(v1.data, TA.MINT).equals(mint1));
  const flag = flagFor(mint0, mint1);
  const coinIsA = row.mintA.address === coinOfMints(flag, mint0, mint1).toBase58();
  const coinAmt = Number(coinIsA ? row.mintAmountA : row.mintAmountB);
  const quoteAmt = Number(coinIsA ? row.mintAmountB : row.mintAmountA);
  const sym = coinIsA ? row.mintA.symbol : row.mintB.symbol;
  return {
    kind: 2, name: KIND_NAME[2], pool, mint0, mint1, dec0: a.data[CP.DEC0]!, dec1: a.data[CP.DEC1]!, reserve0, reserve1, flag,
    symbol: String(sym || "COIN"), apiPrice: coinAmt > 0 ? quoteAmt / coinAmt : null, apiTvl: Number(row.tvl ?? 0) || null,
    source: `api-v3.raydium.io (${cp.length} CPMM/WSOL pools)`,
  };
}
const coinOfMints = (flag: 0 | 1, m0: PublicKey, m1: PublicKey) => (flag ? m0 : m1);

/** kinds 3/4: Meteora data API (`damm-v2` / `dlmm` .datapi.meteora.ag/pools?query=<mint>` matches either side). */
async function discoverMeteora(kind: 3 | 4): Promise<Venue> {
  const host = kind === 3 ? "damm-v2" : "dlmm";
  const override = kind === 3 ? process.env.DAMM_POOL : process.env.DLMM_POOL;
  const q = override ?? WSOL_MINT.toBase58();
  const { url, json } = await getJsonFirst([
    `https://${host}.datapi.meteora.ag/pools?query=${q}&sort_by=tvl:desc&page_size=50&page=1`,
    // documented predecessors (both 404 as of 2026-10; kept so the script self-heals if they come back)
    kind === 3 ? `https://dammv2-api.meteora.ag/pools?query=${q}` : `https://dlmm-api.meteora.ag/pair/all_by_groups?search_term=${q}`,
  ]);
  const rows: any[] = (json?.data ?? json?.groups?.flatMap((g: any) => g.pairs) ?? []).filter((p: any) => {
    const x = p?.token_x?.address ?? p?.mint_x;
    const y = p?.token_y?.address ?? p?.mint_y;
    if (override) return p?.address === override;
    const wsol = WSOL_MINT.toBase58();
    return (x === wsol || y === wsol) && !STABLES.has(x) && !STABLES.has(y) && !p?.is_blacklisted;
  });
  if (!rows.length) throw new Error(`no WSOL-quoted ${KIND_NAME[kind]} pool from ${url}`);
  const row = rows[0];
  const pool = new PublicKey(row.address);
  const [a] = await accounts([pool]);
  const program = kind === 3 ? METEORA_DAMM_V2 : METEORA_DLMM;
  const len = kind === 3 ? DM.LEN : LB.LEN;
  if (!a || !a.owner.equals(program) || a.data.length !== len) throw new Error(`${row.address} is not a ${len}-byte ${KIND_NAME[kind]} account`);
  const mint0 = pk(a.data, kind === 3 ? DM.MINT_A : LB.MINT_X);
  const mint1 = pk(a.data, kind === 3 ? DM.MINT_B : LB.MINT_Y);
  const reserve0 = pk(a.data, kind === 3 ? DM.VAULT_A : LB.RESERVE_X);
  const reserve1 = pk(a.data, kind === 3 ? DM.VAULT_B : LB.RESERVE_Y);
  const apiX = row.token_x?.address ?? row.mint_x;
  const apiY = row.token_y?.address ?? row.mint_y;
  check(`kind ${kind} API token_x/token_y match decoded mints`, mint0.toBase58() === apiX && mint1.toBase58() === apiY, `${mint0.toBase58()} / ${mint1.toBase58()}`);
  const apiR0 = kind === 3 ? row.vault_x : row.reserve_x;
  const apiR1 = kind === 3 ? row.vault_y : row.reserve_y;
  if (apiR0 && apiR1) check(`kind ${kind} API reserve accounts match decoded vaults`, reserve0.toBase58() === apiR0 && reserve1.toBase58() === apiR1);
  if (kind === 4 && row.pool_config?.bin_step !== undefined) check("kind 4 API bin_step matches decoded bin_step", u16(a.data, LB.BIN_STEP) === Number(row.pool_config.bin_step), `bin_step=${u16(a.data, LB.BIN_STEP)}`);
  const flag = flagFor(mint0, mint1);
  const [dec0, dec1] = await Promise.all([mintDecimals(mint0), mintDecimals(mint1)]);
  const px = Number(row.current_price); // y per x (human)
  const coinTok = flag ? row.token_x : row.token_y;
  return {
    kind, name: KIND_NAME[kind], pool, mint0, mint1, dec0, dec1, reserve0, reserve1, flag,
    symbol: String(coinTok?.symbol ?? "COIN"), apiPrice: Number.isFinite(px) && px > 0 ? (flag ? px : 1 / px) : null,
    apiTvl: Number(row.tvl ?? 0) || null, source: `${new URL(url).host} (${rows.length} WSOL pools)`,
  };
}

async function discover(kind: Kind): Promise<Venue> {
  switch (kind) {
    case 1: return discoverPumpSwap();
    case 2: return discoverCpmm();
    case 3: return discoverMeteora(3);
    case 4: return discoverMeteora(4);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Fork helpers
// ---------------------------------------------------------------------------------------------------------------------
async function chainNow(): Promise<number> {
  const d = (await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY))!.data;
  return Number(Buffer.from(d).readBigInt64LE(32)); // Clock.unix_timestamp
}
let timeTravel: boolean | null = null;
/** Advance the fork clock by `secs` (surfnet_timeTravel, absoluteTimestamp in MILLISECONDS); real wait when the cheatcode is missing. */
async function warp(secs: number) {
  const t0 = await chainNow();
  if (timeTravel !== false) {
    try {
      await rpc("surfnet_timeTravel", [{ absoluteTimestamp: (t0 + secs) * 1000 }]);
      for (let i = 0; i < 40 && (await chainNow()) < t0 + secs; i++) await sleep(250);
      if ((await chainNow()) >= t0 + secs) {
        timeTravel = true;
        return;
      }
      console.log("warp: surfnet_timeTravel accepted but Clock did not move; falling back to real time");
    } catch (e) {
      console.log(`warp: surfnet_timeTravel unavailable (${(e as Error).message.slice(0, 80)}); waiting ${secs}s for real`);
    }
    timeTravel = false;
  }
  while ((await chainNow()) < t0 + secs) await sleep(2_000);
}
async function setAccountData(key: PublicKey, data: Buffer) {
  await rpc("surfnet_setAccount", [key.toBase58(), { data: data.toString("hex") }]);
}
/** Push the coin's price up by `bps` on the fork by editing the one field of the REAL cloned pool the oracle reads. */
async function nudgePrice(v: Venue, bps: number) {
  const f = 1 + bps / 1e4;
  if (v.kind === 1) {
    // price = (q + virtual)/b: move the *effective* quote by f, i.e. q' = q + bps/1e4 · (q + virtual)
    const [qa, pa] = await accounts([v.reserve1, v.pool]);
    const d = qa!.data;
    const q = u64(d, TA.AMOUNT);
    const vq = virtualQuote(pa!.data);
    d.writeBigUInt64LE(q + ((q + vq) * BigInt(bps)) / 10_000n, TA.AMOUNT);
    await setAccountData(v.reserve1, d);
  } else if (v.kind === 2) {
    // constant product: a bigger quote reserve = pricier coin, whichever side the quote sits on
    const quoteSlot = v.flag ? v.reserve1 : v.reserve0;
    const d = (await accounts([quoteSlot]))[0]!.data;
    d.writeBigUInt64LE((u64(d, TA.AMOUNT) * BigInt(10_000 + bps)) / 10_000n, TA.AMOUNT);
    await setAccountData(quoteSlot, d);
  } else if (v.kind === 3) {
    // sqrt_price = sqrt(raw b per raw a): coin = a -> ×sqrt(f); coin = b -> ÷sqrt(f)
    const d = (await accounts([v.pool]))[0]!.data;
    const k = BigInt(Math.round(Math.sqrt(f) * 2 ** 32));
    const s = u128(d, DM.SQRT_PRICE);
    const ns = v.flag ? (s * k) >> 32n : (s << 32n) / k;
    d.writeBigUInt64LE(ns & ((1n << 64n) - 1n), DM.SQRT_PRICE);
    d.writeBigUInt64LE(ns >> 64n, DM.SQRT_PRICE + 8);
    await setAccountData(v.pool, d);
  } else {
    // price of x in y = (1+bin_step/1e4)^active_id: coin = x -> more bins; coin = y -> fewer
    const d = (await accounts([v.pool]))[0]!.data;
    const bins = Math.max(1, Math.round(Math.log(f) / Math.log(1 + u16(d, LB.BIN_STEP) / 1e4)));
    d.writeInt32LE(i32(d, LB.ACTIVE_ID) + (v.flag ? bins : -bins), LB.ACTIVE_ID);
    await setAccountData(v.pool, d);
  }
}
const keepOf = (duQ32: bigint) => Math.pow(1.0001, (-100 * Number(duQ32 < 0n ? -duQ32 : duQ32)) / 2 ** 32);

async function readMarketFull(key: PublicKey) {
  const info = await conn.getAccountInfo(key);
  if (!info) throw new Error("market missing");
  const base = await readMarket(conn, key);
  return { ...base, len: info.data.length, oracleKind: info.data[MARKET_ORACLE_KIND_OFFSET]!, ckptHead: info.data[MARKET_CKPT_HEAD_OFFSET]! };
}
/** Addresses in an ExtraAccountMetaList (disc 8 | len u4 | count u4 | [discriminator 1 | address 32 | is_signer 1 | is_writable 1]*). */
function metaListAddresses(d: Uint8Array) {
  const n = Buffer.from(d).readUInt32LE(12);
  const out: PublicKey[] = [];
  for (let i = 0; i < n; i++) out.push(pk(d, 16 + 35 * i + 1));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-kind fork run
// ---------------------------------------------------------------------------------------------------------------------
type Row = { v: Venue; spot: Spot | null; onTick: number | null; ok: boolean; note: string };

async function runKind(v: Venue, payer: Keypair, client: DynamicBondingCurveClient, row: Row) {
  const K = `[${v.kind} ${v.name}]`;
  const failuresBefore = failures;
  const payerQuote = getAssociatedTokenAddressSync(RFSTACC, payer.publicKey);
  const slots = oracleSlots(v.kind, v);

  // ---- keys ----
  const bull = Keypair.generate();
  const bear = Keypair.generate();
  const configKp = Keypair.generate();
  const key = marketPda(bull.publicKey, bear.publicKey, slots.obs, WINDOW, v.flag);
  const m: Market = {
    key, bullMint: bull.publicKey, bearMint: bear.publicKey, oraclePool: slots.pool, oracleObs: slots.obs,
    windowSecs: WINDOW, underlyingIsToken0: v.flag, config: configKp.publicKey,
  };
  const B = sideAccounts(m, 0);
  const R = sideAccounts(m, 1);
  console.log(`${K} market ${key.toBase58()} obs=${slots.obs.toBase58()} pool=${slots.pool.toBase58()} flag=${v.flag}`);

  // ---- DBC hook config + UP/DOWN curves (fee_claimer = market PDA -> mint authority) ----
  const curve = buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.Token2022, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 9,
      tokenAuthorityOption: TokenAuthorityOption.PartnerUpdateAndMintAuthority, totalTokenSupply: 1_000_000_000, leftover: 0,
    },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 400, endingFeeBps: 400, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps25, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp, initialMarketCap: 10, migrationMarketCap: 1_000_000,
  });
  const cfgTx = await client.partner.createConfigWithTransferHook({
    ...curve, config: configKp.publicKey, feeClaimer: key, leftoverReceiver: payer.publicKey, quoteMint: RFSTACC,
    payer: payer.publicKey, transferHookProgram: PROGRAM_ID,
  });
  await send(conn, cfgTx, [payer, configKp]);
  const sym = v.symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 7) || "COIN";
  for (const [kp, name, symbol] of [[bull, `${sym} 100x UP`, `${sym}UP`], [bear, `${sym} 100x DOWN`, `${sym}DN`]] as const) {
    const tx = await client.creator.createPoolWithTransferHook({
      name, symbol, uri: "https://100x.broker", payer: payer.publicKey, poolCreator: payer.publicKey,
      config: configKp.publicKey, baseMint: kp.publicKey, transferHookProgram: PROGRAM_ID,
    });
    await send(conn, tx, [payer, kp]);
  }
  check(`${K} DBC handed UP mint authority to market PDA`, new PublicKey((await conn.getAccountInfo(bull.publicKey))!.data.subarray(4, 36)).equals(key));

  // ---- create_market with the kind byte + per-kind accounts ----
  await send(conn, new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, B.escrow, key, bull.publicKey, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, R.escrow, key, bear.publicKey, TOKEN_2022_PROGRAM_ID),
  ), [payer]);
  const spot0 = await readSpot(v); // same fork state the program reads
  const cm = await send(conn, new Transaction().add(cu(600_000), createMarketVenueIx(payer.publicKey, m, v.kind, v.pool)), [payer]);
  let st = await readMarketFull(key);
  check(`${K} create_market (kind byte ${v.kind}, ${createMarketTrailingAccounts(v.kind, v.pool).length} trailing acct)`, st.len === MARKET_LEN, `cu=${cm.cu}`);
  check(`${K} Market.oracle_kind == ${v.kind} @${MARKET_ORACLE_KIND_OFFSET}`, st.oracleKind === v.kind, `got ${st.oracleKind}`);
  const onTick0 = Number(st.lastTwapQ32) / 2 ** 32;
  row.onTick = onTick0;
  const tickOk = (on: number, off: number) => Math.abs(on - off) <= Math.max(0.01 * Math.abs(off), 1);
  const priceOk = (on: number, off: number) => Math.abs(tickToPrice(v, on) / tickToPrice(v, off) - 1) <= 0.01;
  check(`${K} last_twap_q32 nonzero and within 1% of off-chain tick`, st.lastTwapQ32 !== 0n && tickOk(onTick0, spot0.tick) && priceOk(onTick0, spot0.tick),
    `on-chain=${onTick0.toFixed(2)} off-chain=${spot0.tick.toFixed(2)} (${spot0.detail})`);
  check(`${K} creation seeded last_obs_ts and a checkpoint`, st.lastObsTs > 0 && st.ckptHead >= 1, `last_obs_ts=${st.lastObsTs} ckpt_head=${st.ckptHead}`);
  const metas = await accounts([B.meta, R.meta]);
  const wantMetas = expectedExtraMetas(v.kind, key, slots, B.vault, R.vault, v.pool);
  const want = wantMetas.map((k) => k.toBase58()).join(",");
  check(`${K} ExtraAccountMetaList = [market, obs slot, vaults, token program, pool slot${v.kind === 1 ? ", PumpSwap Pool" : ""}] (${wantMetas.length} entries, ${metaListLen(wantMetas.length)} bytes)`,
    metas.every((a) => !!a && a.data.length === metaListLen(wantMetas.length) && metaListAddresses(a.data).map((k) => k.toBase58()).join(",") === want
      && (v.kind !== 1 || a.data[16 + 35 * 6 + 34] === 0)),
    metas.map((a) => (a ? `${a.data.length}b/${metaListAddresses(a.data).length}` : "missing")).join(" "));

  // ---- seed vaults 10 r-freestacc each (so a rebalance has something to move) ----
  await send(conn, new Transaction().add(
    createTransferInstruction(payerQuote, B.vault, payer.publicKey, 10n * E9),
    createTransferInstruction(payerQuote, R.vault, payer.publicKey, 10n * E9),
  ), [payer]);

  // ---- kind 1: a real buy through the DBC hook swap proves the extras list resolves inside Execute ----
  if (v.kind === 1) {
    for (const [side, pool] of [[0, B.pool], [1, R.pool]] as const) {
      const tx = await client.pool.swap2WithTransferHook({
        owner: payer.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null, payer: payer.publicKey,
        swapMode: SwapMode.ExactIn, amountIn: new BN(2_000_000_000), minimumAmountOut: new BN(0),
      });
      const res = await send(conn, tx, [payer]);
      const hooked = res.logs.some((l) => l.includes(`Program ${PROGRAM_ID.toBase58()} invoke`));
      check(`${K} buy ${side === 0 ? "UP" : "DOWN"} via swap2_with_transfer_hook runs the hook (extras resolved)`, hooked, `cu=${res.cu}`);
    }
    const upAta = getAssociatedTokenAddressSync(bull.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    check(`${K} received UP tokens`, (await tokenBalance(conn, upAta)) > 0n);
  }

  // ---- one settle window later: poke = the program's sample; checkpoint advances, TWAP unchanged on a flat price ----
  const vb0 = { bull: await tokenBalance(conn, B.vault), bear: await tokenBalance(conn, R.vault) };
  await warp(WINDOW + 5);
  const poke = () => withVenueTrailing(pokeIx(m), v.kind, v.pool); // kind 1: idx 5 = quote vault, idx 6 = PumpSwap Pool
  const pk1 = await send(conn, new Transaction().add(poke()), [payer]);
  const st1 = await readMarketFull(key);
  const onTick1 = Number(st1.lastTwapQ32) / 2 ** 32;
  row.onTick = onTick1;
  check(`${K} poke after one window: ckpt_head advanced`, st1.ckptHead === (st.ckptHead + 1) % CKPT_COUNT && st1.lastObsTs >= st.lastObsTs + WINDOW,
    `ckpt_head ${st.ckptHead}->${st1.ckptHead} last_obs_ts +${st1.lastObsTs - st.lastObsTs}s cu=${pk1.cu}`);
  check(`${K} TWAP after the window still within 1% of the pool tick`, tickOk(onTick1, spot0.tick) && priceOk(onTick1, spot0.tick), `twap=${onTick1.toFixed(2)}`);
  check(`${K} flat price moved nothing between vaults`, (await tokenBalance(conn, B.vault)) === vb0.bull && (await tokenBalance(conn, R.vault)) === vb0.bear);

  // ---- push the coin up NUDGE_BPS on the fork, one more window, the DOWN vault pays the UP vault ----
  if (NUDGE_BPS > 0) {
    await nudgePrice(v, NUDGE_BPS);
    const spotN = await readSpot(v);
    // DLMM prices are quantized per bin (bin_step 80 ≈ 79.96 ticks): a +1% push can only land on a whole bin, so the
    // realizable move is the nearest multiple of the bin width; the on-chain TWAP must then track that exact move.
    const wantTicks = Math.log(1 + NUDGE_BPS / 1e4) / LN_TICK;
    const quantum = spotN.quantum ?? 0;
    const expTicks = quantum > 0 ? Math.max(1, Math.round(wantTicks / quantum)) * quantum : wantTicks;
    check(`${K} fork nudge: off-chain tick moved by ~${expTicks.toFixed(1)}`, Math.abs(Math.abs(spotN.tick - spot0.tick) - expTicks) < 0.15 * expTicks + 1,
      `${spot0.tick.toFixed(2)} -> ${spotN.tick.toFixed(2)} (${spotN.detail})`);
    const before = { bull: await tokenBalance(conn, B.vault), bear: await tokenBalance(conn, R.vault) };
    await warp(WINDOW + 5);
    const pk2 = await send(conn, new Transaction().add(poke()), [payer]);
    const st2 = await readMarketFull(key);
    const dTick = st2.lastTwapQ32 - st1.lastTwapQ32;
    const du = v.flag ? dTick : -dTick; // underlying up => DOWN pays UP
    const after = { bull: await tokenBalance(conn, B.vault), bear: await tokenBalance(conn, R.vault) };
    const paid = before.bear - after.bear;
    const keep = keepOf(du);
    const expectedLoss = BigInt(Math.floor(Number(before.bear) * (1 - keep)));
    const tol = before.bear / 1_000_000n + 2n;
    check(`${K} nudge: TWAP moved the underlying up by ~${expTicks.toFixed(1)} ticks`, du > 0n && Math.abs(Number(du) / 2 ** 32 - expTicks) <= 0.15 * expTicks + 1,
      `Δtwap=${(Number(dTick) / 2 ** 32).toFixed(3)} ckpt_head=${st2.ckptHead} cu=${pk2.cu}`);
    check(`${K} nudge: DOWN vault paid UP vault 1 - 1.0001^(-100·|Δtwap|)`, paid > 0n && after.bull - before.bull === paid && paid >= expectedLoss - tol && paid <= expectedLoss + tol,
      `paid=${fmt9(paid)} expected=${fmt9(expectedLoss)} keep=${keep.toFixed(6)}`);
    check(`${K} nudge: DOWN curve now owes settlement (keep_bear < 1)`, st2.keepBearQ63 < 1n << 63n, `keep_bear=${(Number(st2.keepBearQ63) / 2 ** 63).toFixed(6)}`);
    row.onTick = Number(st2.lastTwapQ32) / 2 ** 32;

    // ---- kind 1: settle sandwich sells DOWN from escrow into its curve, proceeds to the UP vault ----
    if (v.kind === 1) await settleSandwich(K, m, 1, payer, client, v);
  }

  row.ok = failures === failuresBefore;
}

/** [settle_begin, DBC swap2_with_transfer_hook (escrow -> curve, proceeds -> winner vault), settle_end]; amount found by simulation. */
async function settleSandwich(K: string, m: Market, side: 0 | 1, payer: Keypair, client: DynamicBondingCurveClient, v: Venue) {
  const L = sideAccounts(m, side);
  const W = sideAccounts(m, 1 - side);
  const swapTx = await client.pool.swap2WithTransferHook({
    owner: payer.publicKey, pool: L.pool, swapBaseForQuote: true, referralTokenAccount: null, payer: payer.publicKey,
    swapMode: SwapMode.ExactIn, amountIn: new BN(1), minimumAmountOut: new BN(0),
  });
  const dbcIx = swapTx.instructions.find((ix) => ix.programId.equals(DBC))!;
  const ixs = (amount: bigint) => {
    const keys = dbcIx.keys.map((k) => ({ ...k }));
    keys[3] = { pubkey: L.escrow, isSigner: false, isWritable: true };
    keys[4] = { pubkey: W.vault, isSigner: false, isWritable: true };
    const data = Buffer.from(dbcIx.data);
    data.writeBigUInt64LE(amount, 8);
    data.writeBigUInt64LE(0n, 16);
    // settle_begin: idx 11 = oracle_pool slot (lib.ts), idx 12 = PumpSwap Pool for kind 1
    return [cu(1_000_000), withVenueTrailing(settleBeginIx(m, payer.publicKey, side, amount), v.kind, v.pool), new TransactionInstruction({ programId: DBC, keys, data }), settleEndIx(m, side)];
  };
  const build = async (amount: bigint) =>
    new VersionedTransaction(new TransactionMessage({
      payerKey: payer.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: ixs(amount),
    }).compileToV0Message());
  const simulate = async (amount: bigint) => {
    const sim = await conn.simulateTransaction(await build(amount), { sigVerify: false, replaceRecentBlockhash: true });
    return !sim.value.err;
  };
  let lo = 0n;
  let hi = 10n ** 15n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await simulate(mid)) lo = mid;
    else hi = mid;
  }
  if (!check(`${K} settle amount found by simulation`, lo > 0n, `amount=${lo}`)) return;
  const win0 = await tokenBalance(conn, W.vault);
  const vtx = await build(lo);
  vtx.sign([payer]);
  const sig = await conn.sendTransaction(vtx, { skipPreflight: true });
  await conn.confirmTransaction(sig, "confirmed");
  const got = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  check(`${K} settle sandwich lands on a kind-${(await readMarketFull(m.key)).oracleKind} market`, !got?.meta?.err, `amount=${lo} cu=${got?.meta?.computeUnitsConsumed}`);
  const st = await readMarketFull(m.key);
  check(`${K} settle proceeds landed in the winning vault, escrow empty, settling cleared`,
    (await tokenBalance(conn, W.vault)) > win0 && (await tokenBalance(conn, L.escrow)) === 0n && st.settling === 0,
    `+${fmt9((await tokenBalance(conn, W.vault)) - win0)}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------------
function printTable(rows: Row[]) {
  const cols = ["kind", "venue", "pool", "coin/quote", "flag", "decoded price (SOL/coin)", "api price", "off-chain tick", "on-chain tick", "result"];
  const data = rows.map((r) => [
    String(r.v.kind), r.v.name, r.v.pool.toBase58(), `${r.v.symbol}/SOL`, String(r.v.flag),
    r.spot ? r.spot.price.toPrecision(6) : "-", r.v.apiPrice ? r.v.apiPrice.toPrecision(6) : "-",
    r.spot ? r.spot.tick.toFixed(2) : "-", r.onTick === null ? "-" : r.onTick.toFixed(2), r.ok ? "PASS" : `FAIL ${r.note}`.trim(),
  ]);
  const w = cols.map((c, i) => Math.max(c.length, ...data.map((d) => d[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i]!)).join("  ");
  console.log("\n" + line(cols));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const d of data) console.log(line(d));
}

async function main() {
  if (WINDOW < CKPT_SPACING_SECS) throw new Error(`WINDOW_SECS must be >= ${CKPT_SPACING_SECS} so a window pushes a checkpoint`);
  console.log(`rpc=${RPC.replace(/api-key=[^&]+/, "api-key=***")} kinds=${KINDS.join(",")} window=${WINDOW}s ${DISCOVER_ONLY ? "(discovery only)" : ""}`);

  // ---- discovery + decode (mainnet or fork; the fork clones each account from mainnet on first read) ----
  const rows: Row[] = [];
  for (const kind of KINDS) {
    const row: Row = { v: null as unknown as Venue, spot: null, onTick: null, ok: false, note: "" };
    try {
      row.v = await discover(kind);
      row.spot = await readSpot(row.v);
      const coin = coinOf(row.v);
      console.log(`[${kind} ${row.v.name}] ${row.v.symbol}/SOL pool=${row.v.pool.toBase58()} coin=${coin.toBase58()} obs=${oracleSlots(kind, row.v).obs.toBase58()} pool-slot=${oracleSlots(kind, row.v).pool.toBase58()}`);
      console.log(`    ${row.v.source}; tvl=${row.v.apiTvl ? "$" + Math.round(row.v.apiTvl).toLocaleString() : "n/a"}; ${row.spot.detail}; tick=${row.spot.tick.toFixed(2)} price=${row.spot.price.toPrecision(6)} SOL${row.v.apiPrice ? ` (api ${row.v.apiPrice.toPrecision(6)})` : ""}`);
      check(`kind ${kind} decoded reserves/price are real (finite, nonzero)`, Number.isFinite(row.spot.tick) && row.spot.price > 0);
      if (row.v.apiPrice) {
        const dev = Math.abs(row.spot.price / row.v.apiPrice - 1);
        check(`kind ${kind} decoded price agrees with the venue API (<10%; the API lags the chain)`, dev < 0.1, `dev=${(dev * 100).toFixed(2)}%`);
      }
      row.ok = true;
    } catch (e) {
      row.note = (e as Error).message;
      check(`kind ${kind} discovery`, false, row.note);
    }
    rows.push(row);
  }
  const live = rows.filter((r) => r.v && r.spot);
  if (DISCOVER_ONLY) {
    printTable(live);
    console.log(failures === 0 ? "\nALL PASS (discovery)" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  }

  // ---- fork preflight ----
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync((process.env.PAYER ?? "test-payer.json").replace("~", os.homedir()), "utf8"))));
  const client = DynamicBondingCurveClient.create(conn, "confirmed");
  const progInfo = await conn.getAccountInfo(PROGRAM_ID);
  if (!check("program deployed on fork", !!progInfo?.executable, PROGRAM_ID.toBase58())) process.exit(1);
  if ((await conn.getBalance(payer.publicKey)) < 5 * Number(E9)) {
    const sig = await conn.requestAirdrop(payer.publicKey, 50 * Number(E9));
    await conn.confirmTransaction(sig, "confirmed");
  }
  await rpc("surfnet_setTokenAccount", [payer.publicKey.toBase58(), RFSTACC.toBase58(), { amount: 1_000 * Number(E9) }, TOKEN_PROGRAM_ID.toBase58()]);
  check("payer funded with r-freestacc", (await tokenBalance(conn, getAssociatedTokenAddressSync(RFSTACC, payer.publicKey))) >= 1_000n * E9);

  for (const row of live) {
    row.ok = false;
    try {
      await runKind(row.v, payer, client, row);
    } catch (e) {
      row.note = explainError((e as Error).message).slice(0, 160);
      check(`[${row.v.kind} ${row.v.name}] run`, false, row.note);
    }
  }
  printTable(live);
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
