// dnvault client: PDAs, state decoding, instruction builders, and the same valuation the program does on-chain.
import { Buffer } from "buffer";
import fs from "fs";
import BN from "bn.js";
import bs58 from "bs58";
import { type AccountMeta, Connection, Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  addExtraAccountMetasForExecute,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { positionAmounts, priceX64, sqrtPriceAtTick } from "./clmm-math";
import { PROGRAM_ID as HOOKED, RFSTACC } from "../lib";
import { STAKE_POOL } from "../stakepool";

export const DN_PROGRAM = new PublicKey(
  process.env.DN_PROGRAM_ID ?? "HQ7oEm6WqZVmA8PSZVXC1mX28Xnbhq3kky4QhFixdNzC",
);
export const RAYDIUM_CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
export const LEVERAGE = 100n;
export const REDEEM_FEE_BPS = 400n;
export const VAULT_DISC = Buffer.from("dnvault1");
export const VAULT_LEN = 488;

const i32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
};
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const s = (pubkey: PublicKey, isWritable = true): AccountMeta => ({ pubkey, isSigner: true, isWritable });

export const vaultPda = (market: PublicKey, tickLower: number, tickUpper: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer(), i32le(tickLower), i32le(tickUpper)], DN_PROGRAM)[0];
export const sharesPda = (vault: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("shares"), vault.toBuffer()], DN_PROGRAM)[0];
export const solPda = (vault: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("sol"), vault.toBuffer()], DN_PROGRAM)[0];
/** WSOL + X belong to the SOL sub-account (it is the Raydium LP identity); DOWN + quote to the vault. */
export function vaultAtas(vault: PublicKey, xMint: PublicKey, downMint: PublicKey, xIsT22: boolean) {
  const sol = solPda(vault);
  return {
    wsol: getAssociatedTokenAddressSync(WSOL, sol, true),
    x: getAssociatedTokenAddressSync(xMint, sol, true, xIsT22 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID),
    quote: getAssociatedTokenAddressSync(RFSTACC, vault, true),
    down: getAssociatedTokenAddressSync(downMint, vault, true, TOKEN_2022_PROGRAM_ID),
  };
}

export type VaultState = {
  key: PublicKey;
  market: PublicKey;
  pool: PublicKey;
  xMint: PublicKey;
  downMint: PublicKey;
  shareMint: PublicKey;
  wsolAta: PublicKey;
  xAta: PublicKey;
  quoteAta: PublicKey;
  downAta: PublicKey;
  position: PublicKey | null;
  positionNft: PublicKey | null;
  creator: PublicKey;
  solPda: PublicKey;
  snapNav: bigint;
  snapErrBps: bigint;
  snapSlot: bigint;
  snapD: bigint;
  snapFees: bigint;
  tickLower: number;
  tickUpper: number;
  bandBps: number;
  maxLossBps: number;
  keeperBps: number;
  xIsToken0: boolean;
  snapActive: boolean;
  xIsT22: boolean;
  xProgram: PublicKey;
};
const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32));
const optPk = (d: Buffer, o: number) => {
  const k = pk(d, o);
  return k.equals(PublicKey.default) ? null : k;
};
export function decodeVault(key: PublicKey, d: Buffer): VaultState {
  if (d.length !== VAULT_LEN || !d.subarray(0, 8).equals(VAULT_DISC)) throw new Error("not a vault");
  return {
    key,
    market: pk(d, 8), pool: pk(d, 40), xMint: pk(d, 72), downMint: pk(d, 104), shareMint: pk(d, 136),
    wsolAta: pk(d, 168), xAta: pk(d, 200), quoteAta: pk(d, 232), downAta: pk(d, 264),
    position: optPk(d, 296), positionNft: optPk(d, 328), creator: pk(d, 360), solPda: pk(d, 392),
    snapNav: d.readBigUInt64LE(424), snapErrBps: d.readBigUInt64LE(432), snapSlot: d.readBigUInt64LE(440),
    snapD: d.readBigUInt64LE(448), snapFees: d.readBigUInt64LE(456),
    tickLower: d.readInt32LE(464), tickUpper: d.readInt32LE(468), bandBps: d.readUInt16LE(472), maxLossBps: d.readUInt16LE(474), keeperBps: d.readUInt16LE(476),
    xIsToken0: d[479] === 1, snapActive: d[480] === 1, xIsT22: d[482] === 1, xProgram: d[482] === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
  };
}
export async function readVault(conn: Connection, key: PublicKey): Promise<VaultState> {
  const info = await conn.getAccountInfo(key);
  if (!info) throw new Error(`vault ${key.toBase58()} not found`);
  return decodeVault(key, Buffer.from(info.data));
}
export async function listVaults(conn: Connection): Promise<VaultState[]> {
  const res = await conn.getProgramAccounts(DN_PROGRAM, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(VAULT_DISC) } }] });
  return res.map((a) => decodeVault(a.pubkey, Buffer.from(a.account.data)));
}

/** The bits of a hooked market the vault cares about. */
export type MarketBits = { key: PublicKey; bearMint: PublicKey; oraclePool: PublicKey; vaultBear: PublicKey; poolBear: PublicKey; baseVaultBear: PublicKey; lastTwapQ32: bigint; underlyingIsToken0: boolean };
export function decodeMarketBits(key: PublicKey, d: Buffer): MarketBits {
  return { key, bearMint: pk(d, 40), oraclePool: pk(d, 104), vaultBear: pk(d, 200), poolBear: pk(d, 264), baseVaultBear: pk(d, 328), lastTwapQ32: d.readBigInt64LE(424), underlyingIsToken0: d[489] === 1 };
}

/** The 12 valuation accounts every deposit/withdraw/act/settle carries. */
export async function valAccounts(conn: Connection, v: VaultState, solWritable = false): Promise<AccountMeta[]> {
  const md = await conn.getAccountInfo(v.market);
  if (!md) throw new Error("market not found");
  const m = decodeMarketBits(v.market, Buffer.from(md.data));
  return [
    r(v.market), r(m.vaultBear), r(m.bearMint), r(m.baseVaultBear), r(v.downAta), r(v.pool), r(v.position ?? v.key),
    r(v.wsolAta), r(v.xAta), r(v.quoteAta), r(STAKE_POOL), solWritable ? w(v.solPda) : r(v.solPda),
  ];
}
/** Same list but with the vault's token accounts writable (for acts that move them). */
export const writableVal = (val: AccountMeta[]) => val.map((k, i) => ([4, 7, 8, 9, 11].includes(i) ? { ...k, isWritable: true } : k));

// ---------- instructions ----------
export function createVaultIx(creator: PublicKey, market: PublicKey, pool: PublicKey, xMint: PublicKey, xIsT22: boolean, downMint: PublicKey, tickLower: number, tickUpper: number, bandBps: number, maxLossBps: number, keeperBps: number) {
  const vault = vaultPda(market, tickLower, tickUpper);
  const atas = vaultAtas(vault, xMint, downMint, xIsT22);
  const data = Buffer.alloc(15);
  data[0] = 0;
  data.writeInt32LE(tickLower, 1);
  data.writeInt32LE(tickUpper, 5);
  data.writeUInt16LE(bandBps, 9);
  data.writeUInt16LE(maxLossBps, 11);
  data.writeUInt16LE(keeperBps, 13);
  const ix = new TransactionInstruction({
    programId: DN_PROGRAM,
    keys: [
      s(creator), w(vault), w(sharesPda(vault)), w(solPda(vault)), r(market), r(pool), r(xMint), r(downMint),
      r(atas.wsol), r(atas.x), r(atas.quote), r(atas.down), r(SystemProgram.programId), r(TOKEN_PROGRAM_ID),
    ],
    data,
  });
  return { ix, vault, shareMint: sharesPda(vault), solPda: solPda(vault), atas };
}

export function depositIx(user: PublicKey, v: VaultState, val: AccountMeta[], lamports: bigint) {
  const userShare = getAssociatedTokenAddressSync(v.shareMint, user);
  return new TransactionInstruction({
    programId: DN_PROGRAM,
    keys: [s(user), w(v.key), w(v.shareMint), w(userShare), ...val.map((k, i) => (i === 11 ? { ...k, isWritable: true } : k)), r(SystemProgram.programId), r(TOKEN_PROGRAM_ID)],
    data: Buffer.concat([Buffer.from([1]), u64le(lamports)]),
  });
}

/** Hook accounts Token-2022 needs appended to a DOWN transfer_checked out of the vault. */
export async function downHookExtras(conn: Connection, v: VaultState, dest: PublicKey, amount: bigint, decimals: number): Promise<AccountMeta[]> {
  const ix = createTransferCheckedInstruction(v.downAta, v.downMint, dest, v.key, amount, decimals, [], TOKEN_2022_PROGRAM_ID);
  await addExtraAccountMetasForExecute(conn, ix, HOOKED, v.downAta, v.downMint, dest, v.key, amount, "confirmed");
  return ix.keys.slice(4).map((k) => ({ ...k, isSigner: false }));
}

const demote = (keys: AccountMeta[], pdas: PublicKey[]) => keys.map((k) => (pdas.some((p) => p.equals(k.pubkey)) ? { ...k, isSigner: false } : k));

export function withdrawIx(user: PublicKey, v: VaultState, val: AccountMeta[], shares: bigint, hookExtras: AccountMeta[], decrease: TransactionInstruction | null) {
  const userShare = getAssociatedTokenAddressSync(v.shareMint, user);
  const keys = [
    s(user), w(v.key), w(v.shareMint), w(userShare), ...writableVal(val),
    w(getAssociatedTokenAddressSync(WSOL, user)), w(getAssociatedTokenAddressSync(RFSTACC, user)), w(getAssociatedTokenAddressSync(v.xMint, user, false, v.xProgram)),
    w(getAssociatedTokenAddressSync(v.downMint, user, false, TOKEN_2022_PROGRAM_ID)),
    r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), r(SystemProgram.programId), r(v.xMint), ...hookExtras,
  ];
  if (decrease) keys.push(r(decrease.programId), ...demote(decrease.keys, [v.key, v.solPda]));
  const data = Buffer.concat([Buffer.from([2]), u64le(shares), Buffer.from([hookExtras.length])]);
  return new TransactionInstruction({ programId: DN_PROGRAM, keys, data });
}

/** Wrap an inner instruction (Raydium / DBC / hooked / stake pool) so the vault signs it. */
export function actIx(v: VaultState, val: AccountMeta[], inner: TransactionInstruction) {
  return new TransactionInstruction({
    programId: DN_PROGRAM,
    keys: [w(v.key), r(SYSVAR_INSTRUCTIONS_PUBKEY), r(inner.programId), ...writableVal(val), ...demote(inner.keys, [v.key, v.solPda])],
    data: Buffer.concat([Buffer.from([3]), inner.data]),
  });
}
/** `keeper` signs and receives the bounty (keeper_bps of |ΔD| + harvested fees) from the vault's SOL. */
export const settleIx = (v: VaultState, val: AccountMeta[], keeper: PublicKey) =>
  new TransactionInstruction({ programId: DN_PROGRAM, keys: [w(v.key), s(keeper), r(SystemProgram.programId), ...writableVal(val)], data: Buffer.from([4]) });
export const wrapIx = (v: VaultState, lamports: bigint) =>
  new TransactionInstruction({ programId: DN_PROGRAM, keys: [r(v.key), w(v.solPda), w(v.wsolAta), r(SystemProgram.programId), r(TOKEN_PROGRAM_ID)], data: Buffer.concat([Buffer.from([5]), u64le(lamports)]) });
export const unwrapIx = (v: VaultState) =>
  new TransactionInstruction({ programId: DN_PROGRAM, keys: [r(v.key), w(v.solPda), w(v.wsolAta), r(TOKEN_PROGRAM_ID)], data: Buffer.from([6]) });
export const bindPositionIx = (v: VaultState, position: PublicKey, nftAccount: PublicKey) =>
  new TransactionInstruction({ programId: DN_PROGRAM, keys: [w(v.key), r(position), r(nftAccount)], data: Buffer.from([7]) });

// ---------- valuation (mirrors programs/dnvault/src/value.rs) ----------
export type Valuation = {
  nav: bigint; d: bigint; dStar: bigint; errBps: bigint;
  free: bigint; wsol: bigint; quote: bigint; quoteSol: bigint; xRaw: bigint; xPos: bigint; xTotal: bigint; xVal: bigint; solPos: bigint;
  pot: bigint; circulating: bigint; held: bigint; twapTick: number; poolSqrt: bigint; poolTick: number; liquidity: bigint; feesOwed: [bigint, bigint];
  rate: number;
};
const amt = (d: Buffer | undefined) => (d && d.length >= 165 ? d.readBigUInt64LE(64) : 0n);
export const SOL_FLOOR = 890_880n;

export async function valuation(conn: Connection, v: VaultState): Promise<Valuation> {
  const md = await conn.getAccountInfo(v.market);
  if (!md) throw new Error("market not found");
  const m = decodeMarketBits(v.market, Buffer.from(md.data));
  const [vaultBear, bearMint, baseVaultBear, downAta, pool, position, wsolAta, xAta, quoteAta, stakePool, sol] = (
    await conn.getMultipleAccountsInfo([m.vaultBear, m.bearMint, m.baseVaultBear, v.downAta, v.pool, v.position ?? v.key, v.wsolAta, v.xAta, v.quoteAta, STAKE_POOL, v.solPda])
  ).map((a) => (a ? { ...a, data: Buffer.from(a.data) } : null));
  if (!vaultBear || !bearMint || !baseVaultBear || !pool || !stakePool) throw new Error("valuation accounts missing");
  const pot = amt(vaultBear.data);
  const circulating = bearMint.data.readBigUInt64LE(36) - amt(baseVaultBear.data);
  const held = amt(downAta?.data);
  const dGross = circulating > 0n && held > 0n ? (pot * held) / circulating : 0n;
  const dNet = (dGross * (10_000n - REDEEM_FEE_BPS)) / 10_000n;

  const poolSqrt = BigInt(pool.data.readBigUInt64LE(253).toString()) + (BigInt(pool.data.readBigUInt64LE(261).toString()) << 64n);
  const poolTick = pool.data.readInt32LE(269);
  let amt0 = 0n, amt1 = 0n, liquidity = 0n;
  const feesOwed: [bigint, bigint] = [0n, 0n];
  if (v.position && position && position.data.length >= 145) {
    liquidity = BigInt(position.data.readBigUInt64LE(81).toString()) + (BigInt(position.data.readBigUInt64LE(89).toString()) << 64n);
    feesOwed[0] = position.data.readBigUInt64LE(129);
    feesOwed[1] = position.data.readBigUInt64LE(137);
    const [a0, a1] = positionAmounts(liquidity, poolSqrt, sqrtPriceAtTick(v.tickLower), sqrtPriceAtTick(v.tickUpper));
    amt0 = a0 + feesOwed[0];
    amt1 = a1 + feesOwed[1];
  }
  const xRaw = amt(xAta?.data);
  const [xPos, solPos] = v.xIsToken0 ? [amt0, amt1] : [amt1, amt0];
  const xTotal = xPos + xRaw;
  const twapTick = Number(m.lastTwapQ32 >> 32n);
  const price = priceX64(sqrtPriceAtTick(twapTick)); // token1 per token0, Q64
  const xVal = xTotal === 0n ? 0n : v.xIsToken0 ? (xTotal * price) >> 64n : (xTotal << 64n) / price;

  const free = sol ? (sol.lamports > Number(SOL_FLOOR) ? BigInt(sol.lamports) - SOL_FLOOR : 0n) : 0n;
  const wsol = amt(wsolAta?.data);
  const quote = amt(quoteAta?.data);
  const total = stakePool.data.readBigUInt64LE(258);
  const supply = stakePool.data.readBigUInt64LE(266);
  const quoteSol = quote === 0n ? 0n : supply === 0n ? quote : (quote * total) / supply;
  const nav = free + wsol + quoteSol + xVal + solPos + dNet;
  const dStar = xVal / LEVERAGE;
  const errBps = dStar === 0n ? (dGross === 0n ? 0n : 2n ** 64n - 1n) : ((dGross > dStar ? dGross - dStar : dStar - dGross) * 10_000n) / dStar;
  return { nav, d: dGross, dStar, errBps, free, wsol, quote, quoteSol, xRaw, xPos, xTotal, xVal, solPos, pot, circulating, held, twapTick, poolSqrt, poolTick, liquidity, feesOwed, rate: Number(total) / Number(supply) };
}

/** DOWN tokens to buy (positive) or sell (negative) so the pot share lands on dStar. Buying/selling moves circulating too. */
export function hedgeDelta(x: Valuation): bigint {
  const { pot, circulating: circ, held, dStar } = x;
  if (dStar === 0n) return -held;
  // nobody holds DOWN: any buy makes the vault the sole holder (D = whole pot); buy dust, the caller trims the pot in the same tx
  if (circ === 0n) return 1_000_000_000n;
  const d = (pot * held) / circ;
  if (d < dStar) {
    // buy: share (held+t)/(circ+t) of the pot lands on D*; if the whole pot can't get there, buy a big share anyway (partial hedge
    // beats none; the curve budget cap in quoteBuy bounds the spend) and let the program judge it "no worse"
    if (pot <= dStar) return circ * 4n;
    return (dStar * circ - held * pot) / (pot - dStar);
  }
  // sell: redeeming n pays out n/circ of the pot (minus the 4% fee, which stays in the pot), so
  // D_after(n) = (held−n)/(circ−n) · pot · (1 − 0.96·n/circ). Monotone in n on [0, held]; bisect for D_after = D*.
  const dAfter = (n: bigint) => {
    if (circ - n <= 0n) return 0n;
    const potAfter = pot - (((pot * n) / circ) * 96n) / 100n;
    return ((held - n) * potAfter) / (circ - n);
  };
  let lo = 0n, hi = held;
  for (let i = 0; i < 64 && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n;
    if (dAfter(mid) > dStar) lo = mid;
    else hi = mid;
  }
  return -lo;
}
