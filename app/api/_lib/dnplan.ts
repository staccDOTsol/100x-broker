// Server-side planner for 1-click zaps on dnvault: builds the instruction lists the user signs (the server never
// signs anything; the program verifies every rebalance). Mirrors scripts/dn/{lib,ops,keeper}.ts.
import { Buffer } from "buffer";
import BN from "bn.js";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  StakeProgram,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as RaySdk from "@raydium-io/raydium-sdk-v2";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { liquidityFromAmounts, positionAmounts, priceX64, sqrtPriceAtTick } from "./clmm-math.js";
import { serverConnection } from "../../src/lib/upstream.js";

const { ClmmInstrument, PersonalPositionLayout, PoolUtils, Raydium } = RaySdk as any;

import { DN_PROGRAM_ID, PROGRAM_ID } from "../../src/config.js";
export const DN_PROGRAM = DN_PROGRAM_ID;
export const HOOKED = PROGRAM_ID;
export const RFSTACC = new PublicKey("pSYRpDqr847kB2nD5ZhjcPsHLV2ZpUxweXm1MwiSTcc");
export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
export const STAKE_POOL = new PublicKey("SzoSoRxsrL9sbFcwpbjbH5bRrzuvFtuytZTeuqZCfQ6");
export const STAKE_POOL_PROGRAM = new PublicKey("SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY");
const WITHDRAW_AUTHORITY = PublicKey.findProgramAddressSync([STAKE_POOL.toBuffer(), Buffer.from("withdraw")], STAKE_POOL_PROGRAM)[0];
const RESERVE = 30_000_000n; // SOL the vault keeps idle for rents and keeper bounties
const MIN_DEPLOY = 20_000_000n;
const SOL_FLOOR = 890_880n;

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
const bn = (x: bigint) => new BN(x.toString());
const big = (x: BN) => BigInt(x.toString());
const amt = (d: Buffer | undefined | null) => (d && d.length >= 165 ? d.readBigUInt64LE(64) : 0n);

export const conn = () => {
  const u = process.env.HELIUS_RPC_URL;
  if (!u) throw new Error("HELIUS_RPC_URL not configured");
  return serverConnection();
};

// ---------- state ----------
export type Vault = {
  key: PublicKey; market: PublicKey; pool: PublicKey; xMint: PublicKey; downMint: PublicKey; shareMint: PublicKey;
  wsolAta: PublicKey; xAta: PublicKey; quoteAta: PublicKey; downAta: PublicKey; position: PublicKey | null; solPda: PublicKey;
  tickLower: number; tickUpper: number; bandBps: number; xIsToken0: boolean; xIsT22: boolean; xProgram: PublicKey;
};
export function decodeVault(key: PublicKey, d: Buffer): Vault {
  if (d.length !== 488 || d.subarray(0, 8).toString() !== "dnvault1") throw new Error("not a vault");
  return {
    key, market: pk(d, 8), pool: pk(d, 40), xMint: pk(d, 72), downMint: pk(d, 104), shareMint: pk(d, 136),
    wsolAta: pk(d, 168), xAta: pk(d, 200), quoteAta: pk(d, 232), downAta: pk(d, 264), position: optPk(d, 296), solPda: pk(d, 392),
    tickLower: d.readInt32LE(464), tickUpper: d.readInt32LE(468), bandBps: d.readUInt16LE(472), xIsToken0: d[479] === 1,
    xIsT22: d[482] === 1, xProgram: d[482] === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
  };
}
export type MarketBits = { bearVault: PublicKey; bullVault: PublicKey; bearMint: PublicKey; baseVaultBear: PublicKey; poolBear: PublicKey; lastTwapQ32: bigint };
export const decodeMarket = (d: Buffer): MarketBits => ({ bearMint: pk(d, 40), bullVault: pk(d, 168), bearVault: pk(d, 200), poolBear: pk(d, 264), baseVaultBear: pk(d, 328), lastTwapQ32: d.readBigInt64LE(424) });

export type Valuation = { nav: bigint; d: bigint; dStar: bigint; errBps: bigint; free: bigint; wsol: bigint; quote: bigint; xRaw: bigint; xTotal: bigint; xVal: bigint; solPos: bigint; pot: bigint; potUp: bigint; circulating: bigint; held: bigint; supply: bigint; liquidity: bigint };
export async function valuation(c: Connection, v: Vault, m: MarketBits): Promise<Valuation> {
  const [vaultBear, bearMint, baseVaultBear, downAta, pool, position, wsolAta, xAta, quoteAta, stakePool, sol, shareMint, vaultBull] = (
    await c.getMultipleAccountsInfo([m.bearVault, m.bearMint, m.baseVaultBear, v.downAta, v.pool, v.position ?? v.key, v.wsolAta, v.xAta, v.quoteAta, STAKE_POOL, v.solPda, v.shareMint, m.bullVault])
  ).map((a) => (a ? { lamports: a.lamports, data: Buffer.from(a.data) } : null));
  if (!vaultBear || !bearMint || !baseVaultBear || !pool || !stakePool || !shareMint) throw new Error("vault accounts missing");
  const pot = amt(vaultBear.data);
  const potUp = amt(vaultBull?.data);
  const circulating = bearMint.data.readBigUInt64LE(36) - amt(baseVaultBear.data);
  const held = amt(downAta?.data);
  const d = circulating > 0n && held > 0n ? (pot * held) / circulating : 0n;
  const poolSqrt = pool.data.readBigUInt64LE(253) + (pool.data.readBigUInt64LE(261) << 64n);
  let amt0 = 0n, amt1 = 0n, liquidity = 0n;
  if (v.position && position && position.data.length >= 145) {
    liquidity = position.data.readBigUInt64LE(81) + (position.data.readBigUInt64LE(89) << 64n);
    const [a0, a1] = positionAmounts(liquidity, poolSqrt, sqrtPriceAtTick(v.tickLower), sqrtPriceAtTick(v.tickUpper));
    amt0 = a0 + position.data.readBigUInt64LE(129);
    amt1 = a1 + position.data.readBigUInt64LE(137);
  }
  const xRaw = amt(xAta?.data);
  const [xPos, solPos] = v.xIsToken0 ? [amt0, amt1] : [amt1, amt0];
  const xTotal = xPos + xRaw;
  const price = priceX64(sqrtPriceAtTick(Number(m.lastTwapQ32 >> 32n)));
  const xVal = xTotal === 0n ? 0n : v.xIsToken0 ? (xTotal * price) >> 64n : (xTotal << 64n) / price;
  const free = sol && BigInt(sol.lamports) > SOL_FLOOR ? BigInt(sol.lamports) - SOL_FLOOR : 0n;
  const wsol = amt(wsolAta?.data);
  const quote = amt(quoteAta?.data);
  const total = stakePool.data.readBigUInt64LE(258);
  const supplyLst = stakePool.data.readBigUInt64LE(266);
  const quoteSol = quote === 0n ? 0n : supplyLst === 0n ? quote : (quote * total) / supplyLst;
  const nav = free + wsol + quoteSol + xVal + solPos + (d * 9_600n) / 10_000n;
  const dStar = xVal / 100n;
  const errBps = dStar === 0n ? (d === 0n ? 0n : 10_000n) : ((d > dStar ? d - dStar : dStar - d) * 10_000n) / dStar;
  return { nav, d, dStar, errBps, free, wsol, quote, xRaw, xTotal, xVal, solPos, pot, potUp, circulating, held, supply: shareMint.data.readBigUInt64LE(36), liquidity };
}

// ---------- dnvault instructions ----------
export function valAccounts(v: Vault, m: MarketBits, position?: PublicKey): AccountMeta[] {
  return [r(v.market), r(m.bearVault), r(m.bearMint), r(m.baseVaultBear), w(v.downAta), r(v.pool), r(position ?? v.position ?? v.key), w(v.wsolAta), w(v.xAta), w(v.quoteAta), r(STAKE_POOL), w(v.solPda)];
}
const demote = (keys: AccountMeta[], pdas: PublicKey[]) => keys.map((k) => (pdas.some((p) => p.equals(k.pubkey)) ? { ...k, isSigner: false } : k));
export const depositIxs = (user: PublicKey, v: Vault, m: MarketBits, lamports: bigint) => {
  const share = getAssociatedTokenAddressSync(v.shareMint, user);
  return [
    createAssociatedTokenAccountIdempotentInstruction(user, share, user, v.shareMint),
    new TransactionInstruction({ programId: DN_PROGRAM, keys: [s(user), w(v.key), w(v.shareMint), w(share), ...valAccounts(v, m), r(SystemProgram.programId), r(TOKEN_PROGRAM_ID)], data: Buffer.concat([Buffer.from([1]), u64le(lamports)]) }),
  ];
};
export const actIx = (v: Vault, val: AccountMeta[], inner: TransactionInstruction) =>
  new TransactionInstruction({ programId: DN_PROGRAM, keys: [w(v.key), r(SYSVAR_INSTRUCTIONS_PUBKEY), r(inner.programId), ...val, ...demote(inner.keys, [v.key, v.solPda])], data: Buffer.concat([Buffer.from([3]), inner.data]) });
export const settleIx = (v: Vault, val: AccountMeta[], keeper: PublicKey) =>
  new TransactionInstruction({ programId: DN_PROGRAM, keys: [w(v.key), s(keeper), r(SystemProgram.programId), ...val], data: Buffer.from([4]) });
export const wrapIx = (v: Vault, lamports: bigint) =>
  new TransactionInstruction({ programId: DN_PROGRAM, keys: [r(v.key), w(v.solPda), w(v.wsolAta), r(SystemProgram.programId), r(TOKEN_PROGRAM_ID)], data: Buffer.concat([Buffer.from([5]), u64le(lamports)]) });
export const bindPositionIx = (v: Vault, position: PublicKey, nftAccount: PublicKey) =>
  new TransactionInstruction({ programId: DN_PROGRAM, keys: [w(v.key), r(position), r(nftAccount)], data: Buffer.from([7]) });

// ---------- stake pool ----------
type Pool = { reserveStake: PublicKey; managerFeeAccount: PublicKey; totalLamports: bigint; poolTokenSupply: bigint; solWithdrawAuthority: PublicKey | null };
export async function readPool(c: Connection): Promise<Pool> {
  const d = Buffer.from((await c.getAccountInfo(STAKE_POOL))!.data);
  let o = 0;
  const u8 = () => d[o++];
  const u64 = () => { const v = d.readBigUInt64LE(o); o += 8; return v; };
  const pkr = () => { const v = new PublicKey(d.subarray(o, o + 32)); o += 32; return v; };
  const fee = () => { u64(); u64(); };
  const optPkr = () => (u8() ? pkr() : null);
  const future = () => { if (u8()) fee(); };
  u8(); pkr(); pkr(); pkr(); u8(); pkr();
  const reserveStake = pkr(); pkr();
  const managerFeeAccount = pkr(); pkr();
  const totalLamports = u64(); const poolTokenSupply = u64(); u64(); o += 48;
  fee(); future(); optPkr(); optPkr(); fee(); fee(); future(); u8(); optPkr(); fee(); u8();
  const solWithdrawAuthority = optPkr();
  return { reserveStake, managerFeeAccount, totalLamports, poolTokenSupply, solWithdrawAuthority };
}
export function depositSolIx(p: Pool, funder: PublicKey, quoteAta: PublicKey, lamports: bigint) {
  const keys = [w(STAKE_POOL), r(WITHDRAW_AUTHORITY), w(p.reserveStake), { pubkey: funder, isSigner: true, isWritable: true }, w(quoteAta), w(p.managerFeeAccount), w(quoteAta), w(RFSTACC), r(SystemProgram.programId), r(TOKEN_PROGRAM_ID)];
  return new TransactionInstruction({ programId: STAKE_POOL_PROGRAM, keys, data: Buffer.concat([Buffer.from([14]), u64le(lamports)]) });
}
export function withdrawSolIx(p: Pool, user: PublicKey, quoteAta: PublicKey, tokens: bigint) {
  const keys = [w(STAKE_POOL), r(WITHDRAW_AUTHORITY), s(user, false), w(quoteAta), w(p.reserveStake), w(user), w(p.managerFeeAccount), w(RFSTACC), r(SYSVAR_CLOCK_PUBKEY), r(SYSVAR_STAKE_HISTORY_PUBKEY), r(StakeProgram.programId), r(TOKEN_PROGRAM_ID)];
  if (p.solWithdrawAuthority) keys.push({ pubkey: p.solWithdrawAuthority, isSigner: true, isWritable: false });
  return new TransactionInstruction({ programId: STAKE_POOL_PROGRAM, keys, data: Buffer.concat([Buffer.from([16]), u64le(tokens)]) });
}

// ---------- raydium ----------
export async function poolCtx(c: Connection, poolId: PublicKey) {
  const ray = await Raydium.load({ connection: c, disableLoadToken: true, cluster: "mainnet", disableFeatureCheck: true });
  const rr: any = await ray.clmm.getPoolInfoFromRpc(poolId.toBase58());
  return { poolInfo: rr.poolInfo, poolKeys: rr.poolKeys, compute: rr.computePoolInfo, tickCache: rr.tickData[poolId.toBase58()] };
}
type Ctx = Awaited<ReturnType<typeof poolCtx>>;
/** swap_v2 from `owner`'s token accounts (wallet or the vault's SOL sub-account). */
export async function swapIx(c: Connection, ctx: Ctx, owner: PublicKey, ataA: PublicKey, ataB: PublicKey, inputMint: PublicKey, amountIn: bigint, slippage = 0.01) {
  const epochInfo = await c.getEpochInfo();
  const q = PoolUtils.computeAmountOut({ poolInfo: ctx.compute, tickarrayBitmapExtension: ctx.compute.exBitmapInfo, tickArrayCache: ctx.tickCache, baseMint: inputMint, epochInfo, amountIn: bn(amountIn), slippage, catchLiquidityInsufficient: false, blockTimestamp: Math.floor(Date.now() / 1000) });
  const { instructions } = ClmmInstrument.makeSwapBaseInInstructions({ poolInfo: ctx.poolInfo, poolKeys: ctx.poolKeys, observationId: ctx.compute.observationId, ownerInfo: { wallet: owner, tokenAccountA: ataA, tokenAccountB: ataB }, inputMint, amountIn: bn(amountIn), amountOutMin: q.minAmountOut.amount, sqrtPriceLimitX64: new BN(0), remainingAccounts: q.remainingAccounts });
  return { ix: instructions.find((i: TransactionInstruction) => i.programId.toBase58() === ctx.poolInfo.programId)! as TransactionInstruction, minOut: big(q.minAmountOut.amount) };
}

// ---------- hedge ----------
export function hedgeDelta(x: { pot: bigint; circulating: bigint; held: bigint; dStar: bigint }) {
  const { pot, circulating: circ, held, dStar } = x;
  if (dStar === 0n) return -held;
  if (pot <= dStar) return 0n; // the whole pot could not hedge this; the keeper caps by budget instead
  // nobody holds DOWN: any buy makes the vault the sole holder (D = whole pot), so buy dust and size on the next pass
  if (circ === 0n) return 1_000_000_000n;
  // sole holder: the share stays 100% whatever is held, so only redeeming (which shrinks the pot) moves D — land it on D*
  if (held === circ) return pot > dStar ? -((circ * (pot - dStar)) / ((pot * 96n) / 100n)) : 0n;
  return (dStar * circ - held * pot) / (pot - dStar);
}
export async function quoteBuy(dbc: DynamicBondingCurveClient, poolBear: PublicKey, tokens: bigint, startBudget: bigint) {
  const p = await dbc.state.getPool(poolBear);
  const config = p && (await dbc.state.getPoolConfig(p.poolState.config));
  if (!p || !config) throw new Error("curve unavailable");
  const q = (amountIn: bigint) => {
    const res: any = dbc.pool.swapQuote2({ virtualPool: p, config, swapBaseForQuote: false, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: new BN(Math.floor(Date.now() / 1000)), slippageBps: 300, swapMode: SwapMode.ExactIn, amountIn: new BN(amountIn.toString()) });
    return { out: BigInt((res.outputAmount ?? res.amountOut).toString()), min: BigInt((res.minimumAmountOut ?? 0).toString()) };
  };
  let budget = startBudget;
  let res = q(budget);
  for (let i = 0; i < 4 && res.out > 0n; i++) {
    budget = (budget * tokens * 102n) / (res.out * 100n);
    if (budget <= 0n) break;
    res = q(budget);
  }
  return { budget, ...res };
}

export type PlanIx = { programId: string; keys: { p: string; s: boolean; w: boolean }[]; data: string };
export const serialize = (ix: TransactionInstruction): PlanIx => ({ programId: ix.programId.toBase58(), keys: ix.keys.map((k) => ({ p: k.pubkey.toBase58(), s: k.isSigner, w: k.isWritable })), data: Buffer.from(ix.data).toString("base64") });
export type Plan = { steps: { label: string; ixs: PlanIx[]; signers: string[] }[]; note?: string };

/** Park + deploy: deposit, then swap half to X and buy the hedge, then add the liquidity. The user is the keeper and pockets the bounty. */
export async function planZapIn(user: PublicKey, vaultKey: PublicKey, lamports: bigint): Promise<Plan> {
  const c = conn();
  const vd = await c.getAccountInfo(vaultKey);
  if (!vd) throw new Error("vault not found");
  const v = decodeVault(vaultKey, Buffer.from(vd.data));
  const m = decodeMarket(Buffer.from((await c.getAccountInfo(v.market))!.data));
  const x = await valuation(c, v, m);
  const steps: Plan["steps"] = [{ label: "Park SOL, mint receipts", ixs: depositIxs(user, v, m, lamports).map(serialize), signers: [] }];
  const idle = x.free + x.wsol + lamports;
  if (idle <= RESERVE + MIN_DEPLOY) return { steps, note: "too small to deploy on its own; the keeper folds it in on its next pass" };
  const dbc = DynamicBondingCurveClient.create(c, "confirmed");
  const ctx = await poolCtx(c, v.pool);
  const aIsWsol = ctx.poolInfo.mintA.address === WSOL.toBase58();
  const ataA = aIsWsol ? v.wsolAta : v.xAta;
  const ataB = aIsWsol ? v.xAta : v.wsolAta;
  // hedge first (paid from un-wrapped SOL), then wrap and swap what is left
  const guessHalf = (idle - RESERVE) / 2n;
  const dStarAfter = (x.xVal + guessHalf) / 100n;
  if (dStarAfter > 0n && x.pot <= dStarAfter) {
    // the whole DOWN pot is smaller than the hedge this deposit needs: nothing to buy, and swapping into X without the hedge
    // is exactly what the program's HedgeWorse check refuses. Park it; the keeper deploys when DOWN refills.
    return { steps, note: `parked, not deployed: the DOWN pot (${(Number(x.pot) / 1e9).toFixed(4)} SOL) is smaller than the hedge this deposit needs (${(Number(dStarAfter) / 1e9).toFixed(4)} SOL); the keeper deploys it when someone buys DOWN or tips the pots` };
  }
  const want = hedgeDelta({ ...x, dStar: dStarAfter });
  let hedge: TransactionInstruction[] = [];
  let spend = 0n;
  const sp = await readPool(c);
  if (want > 0n) {
    const q = await quoteBuy(dbc, m.poolBear, want, dStarAfter + 2_000_000n);
    const lam = (q.budget * sp.totalLamports * 1004n) / (sp.poolTokenSupply * 1000n) + 1_000n;
    spend = lam + 2_000n;
    const sdk = await dbc.pool.swap2WithTransferHook({ owner: v.key, pool: m.poolBear, swapBaseForQuote: false, referralTokenAccount: null, payer: user, swapMode: SwapMode.ExactIn, amountIn: new BN(q.budget.toString()), minimumAmountOut: new BN(q.min.toString()) });
    hedge = [depositSolIx(sp, v.solPda, v.quoteAta, lam), sdk.instructions.find((i) => i.programId.toBase58().startsWith("dbcij"))!];
  }
  const amount = idle - RESERVE - spend;
  const toWrap = amount > x.wsol ? amount - x.wsol : 0n;
  const half = amount / 2n;
  const sw = await swapIx(c, ctx, v.solPda, ataA, ataB, WSOL, half);
  const val = valAccounts(v, m);
  steps.push({ label: "Swap half to the coin, buy the DOWN hedge", ixs: [...(toWrap > 0n ? [wrapIx(v, toWrap)] : []), actIx(v, val, sw.ix), ...hedge.map((ix) => actIx(v, val, ix)), settleIx(v, val, user)].map(serialize), signers: [] });
  // liquidity, from what the vault will hold after the swap (X estimated at the quoted minimum; dust stays for the next pass)
  const balA = aIsWsol ? toWrap + x.wsol - half : x.xRaw + sw.minOut;
  const balB = aIsWsol ? x.xRaw + sw.minOut : toWrap + x.wsol - half;
  // 99%: the pool ticks between planning and landing; Raydium rejects a liquidity that needs one lamport more than the max (PriceSlippageCheck)
  const liquidity = liquidityFromAmounts(big(ctx.compute.sqrtPriceX64), sqrtPriceAtTick(v.tickLower), sqrtPriceAtTick(v.tickUpper), (balA * 99n) / 100n, (balB * 99n) / 100n);
  if (liquidity > 0n) {
    if (!v.position) {
      const op: any = await ClmmInstrument.openPositionFromLiquidityInstructions({
        poolInfo: ctx.poolInfo, poolKeys: ctx.poolKeys, ownerInfo: { feePayer: v.solPda, wallet: v.solPda, tokenAccountA: ataA, tokenAccountB: ataB },
        tickLower: v.tickLower, tickUpper: v.tickUpper, liquidity: bn(liquidity), amountMaxA: bn(balA), amountMaxB: bn(balB), base: null, withMetadata: "no-create", nft2022: true,
      });
      const clmm = op.instructions.filter((i: TransactionInstruction) => i.programId.toBase58() === ctx.poolInfo.programId);
      const other = op.instructions.filter((i: TransactionInstruction) => i.programId.toBase58() !== ctx.poolInfo.programId);
      const val2 = valAccounts(v, m, op.address.personalPosition);
      steps.push({ label: "Open the pool position", ixs: [...other, ...clmm.map((ix: TransactionInstruction) => actIx(v, val2, ix)), bindPositionIx(v, op.address.personalPosition, op.address.positionNftAccount), settleIx(v, val2, user)].map(serialize), signers: op.signers.map((k: Keypair) => bs58.encode(k.secretKey)) });
    } else {
      const ownerPosition = PersonalPositionLayout.decode((await c.getAccountInfo(v.position))!.data);
      const inc: any = ClmmInstrument.increasePositionFromLiquidityInstructions({ poolInfo: ctx.poolInfo, poolKeys: ctx.poolKeys, ownerPosition, ownerInfo: { wallet: v.solPda, tokenAccountA: ataA, tokenAccountB: ataB }, liquidity: bn(liquidity), amountMaxA: bn(balA), amountMaxB: bn(balB), nft2022: true });
      const clmm = inc.instructions.filter((i: TransactionInstruction) => i.programId.toBase58() === ctx.poolInfo.programId);
      steps.push({ label: "Add the liquidity", ixs: [...clmm.map((ix: TransactionInstruction) => actIx(v, val, ix)), settleIx(v, val, user)].map(serialize), signers: [] });
    }
  }
  return { steps };
}

/** The user's own X -> WSOL swap after an in-kind withdraw (the DOWN and r-fstacc legs are built client-side). */
export async function planUserSwapOut(user: PublicKey, vaultKey: PublicKey, amountX: bigint): Promise<{ ixs: PlanIx[]; minOut: string }> {
  const c = conn();
  const v = decodeVault(vaultKey, Buffer.from((await c.getAccountInfo(vaultKey))!.data));
  const ctx = await poolCtx(c, v.pool);
  const aIsWsol = ctx.poolInfo.mintA.address === WSOL.toBase58();
  const userWsol = getAssociatedTokenAddressSync(WSOL, user);
  const userX = getAssociatedTokenAddressSync(v.xMint, user, false, v.xProgram);
  const sw = await swapIx(c, ctx, user, aIsWsol ? userWsol : userX, aIsWsol ? userX : userWsol, v.xMint, amountX, 0.01);
  return { ixs: [serialize(sw.ix)], minOut: sw.minOut.toString() };
}
