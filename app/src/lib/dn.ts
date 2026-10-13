// dnvault (delta-neutral LP vaults) client: state, valuation (mirrors the program), deposit / in-kind withdraw.
import { Buffer } from "buffer";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, getExtraAccountMetas } from "@solana/spl-token";
import { conn } from "./chain.js";
import { metaPda } from "./hooked.js";
import { STAKE_POOL } from "./zap.js";
import { PROGRAM_ID as HOOKED, RFSTACC, WSOL } from "../config.js";
import { positionAmounts, priceX64, sqrtPriceAtTick } from "./clmm-math.js";

export const DN_PROGRAM = new PublicKey("2ZbjE44nSh3AmpREg4sdNMViBLAzAEtFKYDn1XdqMzEj");
export const RAYDIUM_CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const VAULT_DISC = Buffer.from("dnvault1");
const VAULT_LEN = 488;
export const SOL_FLOOR = 890_880n;
const LEVERAGE = 100n;
const REDEEM_FEE_BPS = 400n;

const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const s = (pubkey: PublicKey, isWritable = true): AccountMeta => ({ pubkey, isSigner: true, isWritable });
const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32));
const optPk = (d: Buffer, o: number) => {
  const k = pk(d, o);
  return k.equals(PublicKey.default) ? null : k;
};
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const i32be = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};

export type Vault = {
  key: PublicKey; market: PublicKey; pool: PublicKey; xMint: PublicKey; downMint: PublicKey; shareMint: PublicKey;
  wsolAta: PublicKey; xAta: PublicKey; quoteAta: PublicKey; downAta: PublicKey; position: PublicKey | null; positionNft: PublicKey | null;
  creator: PublicKey; solPda: PublicKey; tickLower: number; tickUpper: number; bandBps: number; maxLossBps: number; keeperBps: number;
  xIsToken0: boolean; snapActive: boolean; xIsT22: boolean; xProgram: PublicKey;
};
export function decodeVault(key: PublicKey, d: Buffer): Vault {
  if (d.length !== VAULT_LEN || !d.subarray(0, 8).equals(VAULT_DISC)) throw new Error("not a vault");
  return {
    key, market: pk(d, 8), pool: pk(d, 40), xMint: pk(d, 72), downMint: pk(d, 104), shareMint: pk(d, 136),
    wsolAta: pk(d, 168), xAta: pk(d, 200), quoteAta: pk(d, 232), downAta: pk(d, 264), position: optPk(d, 296), positionNft: optPk(d, 328),
    creator: pk(d, 360), solPda: pk(d, 392), tickLower: d.readInt32LE(464), tickUpper: d.readInt32LE(468),
    bandBps: d.readUInt16LE(472), maxLossBps: d.readUInt16LE(474), keeperBps: d.readUInt16LE(476),
    xIsToken0: d[479] === 1, snapActive: d[480] === 1, xIsT22: d[482] === 1, xProgram: d[482] === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
  };
}
export async function listVaults(): Promise<Vault[]> {
  // "dnvault1" in base58, precomputed so the bundle needs no bs58 dependency
  const res = await conn.getProgramAccounts(DN_PROGRAM, { filters: [{ memcmp: { offset: 0, bytes: "HoK4CZtz9b6" } }] });
  return res.map((a) => decodeVault(a.pubkey, Buffer.from(a.account.data)));
}

export type MarketBits = { bullVault: PublicKey; bearVault: PublicKey; bearMint: PublicKey; baseVaultBear: PublicKey; obs: PublicKey; oraclePool: PublicKey; poolBear: PublicKey; lastTwapQ32: bigint; underlyingIsToken0: boolean };
const decodeMarket = (d: Buffer): MarketBits => ({
  bearMint: pk(d, 40), obs: pk(d, 136), oraclePool: pk(d, 104), bullVault: pk(d, 168), bearVault: pk(d, 200), poolBear: pk(d, 264), baseVaultBear: pk(d, 328), lastTwapQ32: d.readBigInt64LE(424), underlyingIsToken0: d[489] === 1,
});

export type Valuation = {
  nav: bigint; d: bigint; dStar: bigint; errBps: bigint; free: bigint; wsol: bigint; quoteSol: bigint; xTotal: bigint; xVal: bigint; solPos: bigint;
  pot: bigint; potUp: bigint; held: bigint; supply: bigint; sharePrice: number; liquidity: bigint; feesOwed: [bigint, bigint]; poolTick: number; twapTick: number;
  /** the legs behind xTotal / solPos: principal in the position, loose X in the ATA, fees the position has earned but not collected */
  xInPos: bigint; xLoose: bigint; solInPos: bigint; feeX: bigint; feeSol: bigint;
  /** DOWN's circulating supply (mint supply − the curve's unsold stock) and its decimals; the hedge math needs both */
  circulating: bigint; downDecimals: number;
  /** X's decimals, straight from its mint */
  xDecimals: number;
  /** the market's TWAP as a Q64 token1-per-token0 price — value any X amount with xValueAt() */
  twapPriceX64: bigint;
};
const amt = (d: Buffer | undefined | null) => (d && d.length >= 165 ? d.readBigUInt64LE(64) : 0n);
/** X -> SOL at a Q64 token1/token0 price, the way the program rounds it. */
export const xValueAt = (x: bigint, priceX64: bigint, xIsToken0: boolean) => (x === 0n || priceX64 === 0n ? 0n : xIsToken0 ? (x * priceX64) >> 64n : (x << 64n) / priceX64);
/** SOL per whole X at a tick (floating, for labels only): the pool's raw token1/token0 price, flipped if X is token1, scaled by decimals. */
export const xPriceAtTick = (tick: number, xIsToken0: boolean, xDecimals: number) => Math.pow(1.0001, xIsToken0 ? tick : -tick) * Math.pow(10, xDecimals - 9);

export type VaultView = { v: Vault; m: MarketBits; x: Valuation; underlying: string; createdTs: number | null };

/** Vaults built on one market (memcmp on the market field at offset 8); usually zero or one. */
export async function vaultsForMarket(market: PublicKey): Promise<Vault[]> {
  const res = await conn.getProgramAccounts(DN_PROGRAM, {
    filters: [{ memcmp: { offset: 0, bytes: "HoK4CZtz9b6" } }, { memcmp: { offset: 8, bytes: market.toBase58() } }],
  });
  return res.map((a) => decodeVault(a.pubkey, Buffer.from(a.account.data)));
}

/** One vault by address (null when the account is not a vault). */
export async function findVault(key: PublicKey): Promise<Vault | null> {
  const info = await conn.getAccountInfo(key);
  if (!info || !info.owner.equals(DN_PROGRAM)) return null;
  try {
    return decodeVault(key, Buffer.from(info.data));
  } catch {
    return null;
  }
}

/** Everything the page needs for one vault, in two RPC round trips. */
export async function loadVault(v: Vault, createdTs: number | null): Promise<VaultView> {
  const md = await conn.getAccountInfo(v.market);
  if (!md) throw new Error("market missing");
  const m = decodeMarket(Buffer.from(md.data));
  const [vaultBear, bearMint, baseVaultBear, downAta, pool, position, wsolAta, xAta, quoteAta, stakePool, sol, shareMint, xMint, vaultBull] = (
    await conn.getMultipleAccountsInfo([m.bearVault, m.bearMint, m.baseVaultBear, v.downAta, v.pool, v.position ?? v.key, v.wsolAta, v.xAta, v.quoteAta, STAKE_POOL, v.solPda, v.shareMint, v.xMint, m.bullVault])
  ).map((a) => (a ? { lamports: a.lamports, data: Buffer.from(a.data) } : null));
  if (!vaultBear || !bearMint || !baseVaultBear || !pool || !stakePool || !shareMint) throw new Error("vault accounts missing");
  const pot = amt(vaultBear.data);
  const potUp = amt(vaultBull?.data); // the DOWN hedge can only ever win what sits in the UP pot
  const circ = bearMint.data.readBigUInt64LE(36) - amt(baseVaultBear.data);
  const held = amt(downAta?.data);
  const d = circ > 0n && held > 0n ? (pot * held) / circ : 0n;
  const poolSqrt = pool.data.readBigUInt64LE(253) + (pool.data.readBigUInt64LE(261) << 64n);
  const poolTick = pool.data.readInt32LE(269);
  let amt0 = 0n, amt1 = 0n, liquidity = 0n;
  let prin0 = 0n, prin1 = 0n;
  const feesOwed: [bigint, bigint] = [0n, 0n];
  if (v.position && position && position.data.length >= 145) {
    liquidity = position.data.readBigUInt64LE(81) + (position.data.readBigUInt64LE(89) << 64n);
    feesOwed[0] = position.data.readBigUInt64LE(129);
    feesOwed[1] = position.data.readBigUInt64LE(137);
    [prin0, prin1] = positionAmounts(liquidity, poolSqrt, sqrtPriceAtTick(v.tickLower), sqrtPriceAtTick(v.tickUpper));
    amt0 = prin0 + feesOwed[0];
    amt1 = prin1 + feesOwed[1];
  }
  const xRaw = amt(xAta?.data);
  const [xPos, solPos] = v.xIsToken0 ? [amt0, amt1] : [amt1, amt0];
  const [xInPos, solInPos] = v.xIsToken0 ? [prin0, prin1] : [prin1, prin0];
  const [feeX, feeSol] = v.xIsToken0 ? feesOwed : [feesOwed[1], feesOwed[0]];
  const xTotal = xPos + xRaw;
  const twapTick = Number(m.lastTwapQ32 >> 32n);
  const price = priceX64(sqrtPriceAtTick(twapTick));
  const xVal = xValueAt(xTotal, price, v.xIsToken0);
  const free = sol && BigInt(sol.lamports) > SOL_FLOOR ? BigInt(sol.lamports) - SOL_FLOOR : 0n;
  const wsol = amt(wsolAta?.data);
  const quote = amt(quoteAta?.data);
  const total = stakePool.data.readBigUInt64LE(258);
  const supplyLst = stakePool.data.readBigUInt64LE(266);
  const quoteSol = quote === 0n ? 0n : supplyLst === 0n ? quote : (quote * total) / supplyLst;
  const nav = free + wsol + quoteSol + xVal + solPos + (d * (10_000n - REDEEM_FEE_BPS)) / 10_000n;
  const dStar = xVal / LEVERAGE;
  const errBps = dStar === 0n ? (d === 0n ? 0n : 10_000n) : ((d > dStar ? d - dStar : dStar - d) * 10_000n) / dStar;
  const supply = shareMint.data.readBigUInt64LE(36);
  const underlying = pk(pool.data, v.xIsToken0 ? 73 : 105).toBase58();
  return {
    v, m, underlying, createdTs,
    x: {
      nav, d, dStar, errBps, free, wsol, quoteSol, xTotal, xVal, solPos, pot, potUp, held, supply, sharePrice: supply > 0n ? Number(nav) / Number(supply) : 1, liquidity, feesOwed, poolTick, twapTick,
      xInPos, xLoose: xRaw, solInPos, feeX, feeSol, circulating: circ, downDecimals: bearMint.data[44], xDecimals: xMint && xMint.data.length > 44 ? xMint.data[44] : 6, twapPriceX64: price,
    },
  };
}

/** DOWN to buy (positive) or sell (negative) so the pot share lands on D*. Buying or selling moves circulating too, hence the solve.
 *  Mirrors scripts/dn/lib.ts hedgeDelta — the keeper's own arithmetic. */
export function hedgeDelta(x: Pick<Valuation, "pot" | "circulating" | "held" | "dStar">): bigint {
  const { pot, circulating: circ, held, dStar } = x;
  if (dStar === 0n) return -held;
  if (pot <= dStar) return 0n; // the whole pot could not hedge this; the keeper caps by budget instead
  // nobody holds DOWN: any buy makes the vault the sole holder (D = whole pot), so buy dust and size on the next pass
  if (circ === 0n) return 1_000_000_000n;
  // sole holder: the share stays 100% whatever is held, so only redeeming (which shrinks the pot) moves D — land it on D*
  if (held === circ) return pot > dStar ? -((circ * (pot - dStar)) / ((pot * 96n) / 100n)) : 0n;
  // (held + t) / (circ + t) * pot = dStar  ->  t = (dStar*circ - held*pot) / (pot - dStar)
  return (dStar * circ - held * pot) / (pot - dStar);
}

/** The keeper's next pass, as the program will judge it: re-hedge only outside the band, direction from hedgeDelta. */
export type KeeperMove =
  | { kind: "nothing"; why: string }
  | { kind: "buy"; down: bigint; dD: bigint }
  | { kind: "sell"; down: bigint; dD: bigint; expect: bigint }
  | { kind: "capped"; dD: bigint };
export function keeperNext(v: Pick<Vault, "bandBps">, x: Valuation): KeeperMove {
  const dD = x.dStar > x.d ? x.dStar - x.d : x.d - x.dStar;
  if (x.dStar === 0n) {
    if (x.held === 0n) return { kind: "nothing", why: "nothing to hedge yet — no coin exposure, no DOWN" };
    const expect = x.circulating > 0n ? (((x.pot * x.held) / x.circulating) * (10_000n - REDEEM_FEE_BPS)) / 10_000n : 0n;
    return { kind: "sell", down: x.held, dD, expect };
  }
  if (x.errBps <= BigInt(v.bandBps)) return { kind: "nothing", why: `hedge is ${x.errBps} bps off target, inside the ${v.bandBps} bps band` };
  const t = hedgeDelta(x);
  if (t > 0n) return { kind: "buy", down: t, dD };
  if (t < 0n) {
    const n = -t > x.held ? x.held : -t;
    const expect = x.circulating > 0n ? (((x.pot * n) / x.circulating) * (10_000n - REDEEM_FEE_BPS)) / 10_000n : 0n;
    return { kind: "sell", down: n, dD, expect };
  }
  return { kind: "capped", dD };
}

// ---------- activity ----------
export type DnEv = {
  sig: string; ts: number; kind: "born" | "deposit" | "withdraw" | "rebalance" | "bound";
  actor?: string; lamports?: string; shares?: string; pct?: number; keeper?: string; bounty?: string; acts?: number; targets?: string[];
};
export async function fetchVaultFeed(vault: string): Promise<DnEv[]> {
  const r = await fetch(`/api/dnfeed?v=${vault}`);
  if (!r.ok) throw new Error("vault feed unavailable");
  return (await r.json()).events as DnEv[];
}

/** The 12 valuation accounts every deposit/withdraw carries (SOL sub-account writable). */
export function valAccounts(v: Vault, m: MarketBits): AccountMeta[] {
  return [r(v.market), r(m.bearVault), r(m.bearMint), r(m.baseVaultBear), w(v.downAta), r(v.pool), r(v.position ?? v.key), w(v.wsolAta), w(v.xAta), w(v.quoteAta), r(STAKE_POOL), w(v.solPda)];
}

export function depositIxs(user: PublicKey, view: VaultView, lamports: bigint) {
  const { v, m } = view;
  const share = getAssociatedTokenAddressSync(v.shareMint, user);
  return [
    createAssociatedTokenAccountIdempotentInstruction(user, share, user, v.shareMint),
    new TransactionInstruction({
      programId: DN_PROGRAM,
      keys: [s(user), w(v.key), w(v.shareMint), w(share), ...valAccounts(v, m), r(SystemProgram.programId), r(TOKEN_PROGRAM_ID)],
      data: Buffer.concat([Buffer.from([1]), u64le(lamports)]),
    }),
  ];
}

/** In-kind withdraw: SOL + WSOL + X + DOWN + the position's share (decrease_liquidity straight to the user). */
/** The hook's extra accounts for a DOWN mint, as the on-chain list says (literal addresses + writability); static fallback if unreadable. */
export async function hookExtras(downMint: PublicKey, market: PublicKey, m: MarketBits): Promise<AccountMeta[]> {
  // six entries is what markets listed after the hook upgrade carry; Token-2022 only checks as many as the mint's list holds,
  // so the longer list also satisfies the older five-entry markets (the hook treats the oracle pool as optional)
  const fallback = [w(market), r(m.obs), w(m.bullVault), w(m.bearVault), r(TOKEN_PROGRAM_ID), r(m.oraclePool)];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const info = await conn.getAccountInfo(metaPda(downMint));
      if (!info) return fallback;
      const metas = getExtraAccountMetas(info);
      if (metas.some((em) => em.discriminator !== 0)) return fallback;
      return metas.map((em) => ({ pubkey: new PublicKey(em.addressConfig), isSigner: false, isWritable: em.isWritable }));
    } catch {
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    }
  }
  return fallback;
}

export async function withdrawIxs(user: PublicKey, view: VaultView, shares: bigint) {
  const { v, m } = view;
  const share = getAssociatedTokenAddressSync(v.shareMint, user);
  const userWsol = getAssociatedTokenAddressSync(WSOL, user);
  const userQuote = getAssociatedTokenAddressSync(RFSTACC, user);
  const userX = getAssociatedTokenAddressSync(v.xMint, user, false, v.xProgram);
  const userDown = getAssociatedTokenAddressSync(v.downMint, user, false, TOKEN_2022_PROGRAM_ID);
  const pre = [
    createAssociatedTokenAccountIdempotentInstruction(user, userWsol, user, WSOL),
    createAssociatedTokenAccountIdempotentInstruction(user, userQuote, user, RFSTACC),
    createAssociatedTokenAccountIdempotentInstruction(user, userX, user, v.xMint, v.xProgram),
    createAssociatedTokenAccountIdempotentInstruction(user, userDown, user, v.downMint, TOKEN_2022_PROGRAM_ID),
  ];
  // transfer-hook accounts for the DOWN leg: hooked's Execute metas, then the hook program and its validation account
  // transfer-hook accounts for the DOWN leg, read from the mint's own ExtraAccountMetaList: markets listed after the hook
  // upgrade carry a sixth entry (the oracle pool), and Token-2022 rejects the transfer if the list sent doesn't match exactly
  const extras: AccountMeta[] = [...(await hookExtras(v.downMint, v.market, m)), r(HOOKED), r(metaPda(v.downMint))];
  const keys: AccountMeta[] = [
    s(user), w(v.key), w(v.shareMint), w(share), ...valAccounts(v, m),
    w(userWsol), w(userQuote), w(userX), w(userDown), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), r(SystemProgram.programId), r(v.xMint), ...extras,
  ];
  if (v.position) {
    const [pd, pos] = await conn.getMultipleAccountsInfo([v.pool, v.position]);
    if (!pd || !pos) throw new Error("position accounts missing");
    const pool = Buffer.from(pd.data);
    const spacing = pool.readUInt16LE(235);
    const span = 60 * spacing;
    const start = (t: number) => Math.floor(t / span) * span;
    const nftMint = pk(Buffer.from(pos.data), 9);
    const [mint0, mint1, vault0, vault1] = [pk(pool, 73), pk(pool, 105), pk(pool, 137), pk(pool, 169)];
    const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, RAYDIUM_CLMM)[0];
    const recip0 = mint0.equals(WSOL) ? userWsol : userX;
    const recip1 = mint1.equals(WSOL) ? userWsol : userX;
    const dec = [
      r(v.solPda), r(getAssociatedTokenAddressSync(nftMint, v.solPda, true, TOKEN_2022_PROGRAM_ID)), w(v.position), w(v.pool),
      w(pda([Buffer.from("position"), v.pool.toBuffer(), i32be(v.tickLower), i32be(v.tickUpper)])),
      w(vault0), w(vault1),
      w(pda([Buffer.from("tick_array"), v.pool.toBuffer(), i32be(start(v.tickLower))])),
      w(pda([Buffer.from("tick_array"), v.pool.toBuffer(), i32be(start(v.tickUpper))])),
      w(recip0), w(recip1), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), r(MEMO), r(mint0), r(mint1),
    ];
    // farming rewards: Raydium wants [reward vault, recipient, mint] for every active reward, or it rejects the decrease (6030)
    const rewards: { mint: PublicKey; vault: PublicKey }[] = [];
    for (let i = 0; i < 3; i++) {
      const o = 397 + i * 169;
      const mint = pk(pool, o + 57);
      if (pool[o] !== 0 && !mint.equals(PublicKey.default)) rewards.push({ mint, vault: pk(pool, o + 89) });
    }
    if (rewards.length) {
      const mints = await conn.getMultipleAccountsInfo(rewards.map((x) => x.mint));
      rewards.forEach((rw, i) => {
        const program = mints[i]?.owner ?? TOKEN_PROGRAM_ID;
        const ata = getAssociatedTokenAddressSync(rw.mint, user, false, program);
        pre.push(createAssociatedTokenAccountIdempotentInstruction(user, ata, user, rw.mint, program));
        dec.push(w(rw.vault), w(ata), r(rw.mint));
      });
    }
    keys.push(r(RAYDIUM_CLMM), ...dec);
  }
  const ix = new TransactionInstruction({ programId: DN_PROGRAM, keys, data: Buffer.concat([Buffer.from([2]), u64le(shares), Buffer.from([extras.length])]) });
  return [...pre, ix];
}

export async function shareBalance(user: PublicKey, v: Vault): Promise<bigint> {
  const info = await conn.getAccountInfo(getAssociatedTokenAddressSync(v.shareMint, user));
  return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
}

/** Oldest signature on the vault account = when it was created (through the RPC proxy). */
export async function vaultCreatedTs(vault: PublicKey): Promise<number | null> {
  const sigs = await conn.getSignaturesForAddress(vault, { limit: 1000 });
  const last = sigs[sigs.length - 1];
  return last?.blockTime ?? null;
}

/** Raydium's fee APR for the pool, via our cached proxy. */
export async function poolApr(pool: PublicKey): Promise<{ day: number; week: number; tvl: number; feeRate: number } | null> {
  try {
    const res = await fetch(`/api/raypool?id=${pool.toBase58()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export const YEAR = 31_557_600;
export const DAY = 86_400;
/** Share-price growth since birth. Under 30 min it's noise ("warming"); under 7 days it's the raw change plus the
 *  straight-line projection ("if it kept this up"), always shown — the owner wants the pace visible from hour one, the
 *  label carries the caveat; from day 7 the compounded figure is the headline APY. */
export type Growth = { kind: "warming"; age: number } | { kind: "raw"; change: number; age: number; apr: number; apy: number } | { kind: "apy"; apy: number; change: number; age: number };
export function growthSince(sharePrice: number, createdTs: number | null): Growth | null {
  if (!createdTs || sharePrice <= 0) return null;
  const age = Date.now() / 1000 - createdTs;
  if (age < 1800) return { kind: "warming", age };
  const change = sharePrice - 1;
  const apr = change * (YEAR / age);
  const apy = Math.pow(sharePrice, YEAR / age) - 1; // Infinity for a young, hot vault is the honest answer
  if (age < 7 * DAY) return { kind: "raw", change, age, apr, apy };
  return { kind: "apy", apy, change, age };
}
/** Annualised share-price growth — only once the vault is a week old (see growthSince). */
export function realizedApy(sharePrice: number, createdTs: number | null): number | null {
  const g = growthSince(sharePrice, createdTs);
  return g?.kind === "apy" ? g.apy : null;
}
/** "1 h old", "3 d old" */
export function ageLabel(seconds: number) {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min old`;
  if (seconds < 2 * DAY) return `${Math.round(seconds / 3600)} h old`;
  return `${Math.round(seconds / DAY)} d old`;
}
/** Years until the bag is `mult`× at `apy`. */
export const yearsToMultiple = (apy: number, mult: number) => (apy > 0 ? Math.log(mult) / Math.log(1 + apy) : Infinity);

/**
 * How much of a move the hedge actually offsets, per direction. DOWN loses at 100× when the coin pumps (it pays a slice of its own pot),
 * but when the coin dumps it only wins a slice of the UP pot — so dump coverage scales with UP pot ÷ DOWN pot. Tight only on a balanced book.
 */
export function hedgeCoverage(x: Pick<Valuation, "d" | "dStar" | "pot" | "potUp">): { up: number; down: number; balance: number } {
  const ratio = x.dStar > 0n ? Number(x.d) / Number(x.dStar) : 0;
  const balance = x.pot > 0n ? Number(x.potUp) / Number(x.pot) : 0; // UP pot ÷ DOWN pot
  return { up: Math.min(1, ratio), down: Math.min(1, ratio * balance), balance };
}
