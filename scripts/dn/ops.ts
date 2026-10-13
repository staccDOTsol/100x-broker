// Keeper/e2e building blocks: Raydium CLMM swaps + positions, DBC hedge trades, stake-pool zaps, and sending.
import { Buffer } from "buffer";
import BN from "bn.js";
import {
  AddressLookupTableAccount,
  type AccountMeta,
  Connection,
  Keypair,
  PublicKey,
  type Signer,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as RaySdk from "@raydium-io/raydium-sdk-v2";
import type { ApiV3PoolInfoConcentratedItem, ClmmKeys, Raydium } from "@raydium-io/raydium-sdk-v2";
const { ClmmInstrument, PersonalPositionLayout, PoolUtils, Raydium: RaydiumCls } = RaySdk as any;
import { liquidityFromAmounts, sqrtPriceAtTick } from "./clmm-math";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { RFSTACC, redeemIx, type Market, PROGRAM_ID as HOOKED } from "../lib";
import { depositSolIx, readPool, withdrawSolIx } from "../stakepool";
import { ensureAlts } from "../alt";
import { type VaultState, type Valuation, WSOL, actIx, settleIx, wrapIx, valAccounts, valuation, hedgeDelta, decodeMarketBits } from "./lib";

export type PoolCtx = {
  poolInfo: ApiV3PoolInfoConcentratedItem;
  poolKeys: ClmmKeys;
  compute: Awaited<ReturnType<typeof PoolUtils.fetchComputeClmmInfo>>;
  tickCache: Record<string, any>;
};

export async function loadRay(conn: Connection, owner: Keypair) {
  return RaydiumCls.load({ connection: conn, owner, disableLoadToken: true, cluster: "mainnet", disableFeatureCheck: true }) as Promise<Raydium>;
}

/** Pool metadata from the Raydium API (same on a mainnet fork) + live state from RPC. */
export async function poolCtx(_conn: Connection, ray: Raydium, poolId: PublicKey): Promise<PoolCtx> {
  const r: any = await ray.clmm.getPoolInfoFromRpc(poolId.toBase58());
  return { poolInfo: r.poolInfo, poolKeys: r.poolKeys, compute: r.computePoolInfo, tickCache: r.tickData[poolId.toBase58()] };
}

const bn = (x: bigint) => new BN(x.toString());
export const big = (x: BN) => BigInt(x.toString());

/** CLMM swap_v2 from the vault's token accounts. Returns the raw Raydium instruction and the minimum out. */
export async function swapIx(conn: Connection, ctx: PoolCtx, v: VaultState, inputMint: PublicKey, amountIn: bigint, slippage = 0.01) {
  const epochInfo = await conn.getEpochInfo();
  const q = PoolUtils.computeAmountOut({
    poolInfo: ctx.compute, tickarrayBitmapExtension: ctx.compute.exBitmapInfo, tickArrayCache: ctx.tickCache, baseMint: inputMint,
    epochInfo, amountIn: bn(amountIn), slippage, catchLiquidityInsufficient: false, blockTimestamp: Math.floor(Date.now() / 1000),
  } as any);
  const aIsWsol = ctx.poolInfo.mintA.address === WSOL.toBase58();
  const { instructions } = ClmmInstrument.makeSwapBaseInInstructions({
    poolInfo: ctx.poolInfo, poolKeys: ctx.poolKeys, observationId: ctx.compute.observationId,
    ownerInfo: { wallet: v.solPda, tokenAccountA: aIsWsol ? v.wsolAta : v.xAta, tokenAccountB: aIsWsol ? v.xAta : v.wsolAta },
    inputMint, amountIn: bn(amountIn), amountOutMin: q.minAmountOut.amount, sqrtPriceLimitX64: new BN(0), remainingAccounts: q.remainingAccounts,
  });
  return { ix: instructions.find((i) => i.programId.toBase58() === ctx.poolInfo.programId)!, minOut: big(q.minAmountOut.amount) };
}

/** Open the vault's position with everything it holds in WSOL/X (SDK picks liquidity from both amounts). */
export async function openPositionIxs(ctx: PoolCtx, v: VaultState, payer: PublicKey, amountA: bigint, amountB: bigint) {
  // 99%: leave slack for the pool ticking before the tx lands (Raydium PriceSlippageCheck otherwise)
  const liquidity = bn(liquidityFromAmounts(big(ctx.compute.sqrtPriceX64), sqrtPriceAtTick(v.tickLower), sqrtPriceAtTick(v.tickUpper), (amountA * 99n) / 100n, (amountB * 99n) / 100n));
  const aIsWsol = ctx.poolInfo.mintA.address === WSOL.toBase58();
  const r = await ClmmInstrument.openPositionFromLiquidityInstructions({
    poolInfo: ctx.poolInfo, poolKeys: ctx.poolKeys,
    ownerInfo: { feePayer: v.solPda, wallet: v.solPda, tokenAccountA: aIsWsol ? v.wsolAta : v.xAta, tokenAccountB: aIsWsol ? v.xAta : v.wsolAta },
    tickLower: v.tickLower, tickUpper: v.tickUpper, liquidity, amountMaxA: bn(amountA), amountMaxB: bn(amountB), base: null, withMetadata: "no-create", nft2022: true,
  } as any);
  return { ...r, liquidity: big(liquidity) };
}

export async function readPosition(conn: Connection, position: PublicKey) {
  const info = await conn.getAccountInfo(position);
  if (!info) throw new Error("position not found");
  return PersonalPositionLayout.decode(info.data);
}

/** decrease_liquidity_v2 paying to `recipA/recipB` (mint A/B order). liquidity 0 = harvest fees only. */
/** The reward-mint ATAs `owner` needs for a decrease on this pool (one per active farming reward), with idempotent creates. */
export function rewardAtas(ctx: PoolCtx, owner: PublicKey, payer: PublicKey) {
  const infos: any[] = (ctx.poolInfo as any).rewardDefaultInfos ?? [];
  const atas: PublicKey[] = [];
  const creates: TransactionInstruction[] = [];
  for (const ri of infos) {
    const mint = new PublicKey(ri.mint.address);
    if (mint.equals(PublicKey.default)) continue;
    const program = new PublicKey(ri.mint.programId ?? TOKEN_PROGRAM_ID.toBase58());
    const ata = getAssociatedTokenAddressSync(mint, owner, true, program);
    atas.push(ata);
    creates.push(createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint, program));
  }
  return { atas, creates };
}

export async function decreaseIx(conn: Connection, ctx: PoolCtx, v: VaultState, liquidity: bigint, recipA: PublicKey, recipB: PublicKey, rewardOwner: PublicKey = v.solPda) {
  const ownerPosition = await readPosition(conn, v.position!);
  const r = ClmmInstrument.decreaseLiquidityInstructions({
    poolInfo: ctx.poolInfo, poolKeys: ctx.poolKeys, ownerPosition,
    ownerInfo: { wallet: v.solPda, tokenAccountA: recipA, tokenAccountB: recipB, rewardAccounts: rewardAtas(ctx, rewardOwner, rewardOwner).atas },
    liquidity: bn(liquidity), amountMinA: new BN(0), amountMinB: new BN(0), nft2022: true,
  } as any);
  return r.instructions.find((i) => i.programId.toBase58() === ctx.poolInfo.programId)!;
}

// ---------- hedge ----------
export async function dbcClient(conn: Connection) {
  return DynamicBondingCurveClient.create(conn, "confirmed");
}

/** r-fstacc needed on the DOWN curve to receive ~`tokens` (ExactIn quoted, scaled, re-quoted). */
export async function quoteBuy(dbc: DynamicBondingCurveClient, poolBear: PublicKey, tokens: bigint, startBudget: bigint) {
  const p = await dbc.state.getPool(poolBear);
  const config = p && (await dbc.state.getPoolConfig(p.poolState.config));
  if (!p || !config) throw new Error("curve unavailable");
  const q = (amountIn: bigint) => {
    const r: any = dbc.pool.swapQuote2({ virtualPool: p, config, swapBaseForQuote: false, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: new BN(Math.floor(Date.now() / 1000)), slippageBps: 300, swapMode: SwapMode.ExactIn, amountIn: new BN(amountIn.toString()) });
    return { out: BigInt((r.outputAmount ?? r.amountOut).toString()), min: BigInt((r.minimumAmountOut ?? 0).toString()) };
  };
  let budget = startBudget;
  let r = q(budget);
  for (let i = 0; i < 4 && r.out > 0n; i++) {
    budget = (budget * tokens * 102n) / (r.out * 100n);
    if (budget <= 0n) break;
    r = q(budget);
  }
  return { budget, ...r };
}

/** [DepositSol(budget) ; DBC buy ExactIn(budget)] as raw inner instructions for `act`. */
export async function hedgeBuyIxs(conn: Connection, dbc: DynamicBondingCurveClient, v: VaultState, poolBear: PublicKey, budget: bigint, minOut: bigint, payer: PublicKey) {
  const pool = await readPool(conn);
  // r-fstacc minted = lamports * supply / total * (1 - 0.1%): deposit enough SOL to cover `budget` with a hair to spare
  const lamports = (budget * pool.totalLamports * 1004n) / (pool.poolTokenSupply * 1000n) + 1_000n;
  const dep = depositSolIx(pool, v.solPda, v.quoteAta, lamports);
  const sdk = await dbc.pool.swap2WithTransferHook({ owner: v.key, pool: poolBear, swapBaseForQuote: false, referralTokenAccount: null, payer, swapMode: SwapMode.ExactIn, amountIn: new BN(budget.toString()), minimumAmountOut: new BN(minOut.toString()) });
  const swap = sdk.instructions.find((i) => i.programId.toBase58().startsWith("dbcij"))!;
  return [dep, swap];
}

/** Sell `tokens` of DOWN: redeem at the pot (always possible), then WithdrawSol the proceeds back to the SOL sub-account. */
export async function hedgeSellIxs(conn: Connection, v: VaultState, m: Market, tokens: bigint, expectQuote: bigint) {
  const pool = await readPool(conn);
  const red = redeemIx(m, v.key, 1, tokens);
  // the program pins this: authority = vault (signs via CPI), SOL lands in the sub-account
  const wd = withdrawSolIx(pool, v.key, v.quoteAta, (expectQuote * 97n) / 100n, v.solPda);
  return [red, wd];
}

// ---------- sending ----------
export async function ensureAtas(conn: Connection, payer: Keypair, v: VaultState) {
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, v.wsolAta, v.solPda, WSOL),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, v.xAta, v.solPda, v.xMint, v.xProgram),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, v.quoteAta, v.key, RFSTACC),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, v.downAta, v.key, v.downMint, TOKEN_2022_PROGRAM_ID),
  ];
  await send(conn, payer, ixs, [], []);
}

export async function send(conn: Connection, payer: Keypair, ixs: TransactionInstruction[], signers: Signer[], tables: AddressLookupTableAccount[], label = "tx") {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 }), ...ixs] }).compileToV0Message(tables);
  const tx = new VersionedTransaction(msg);
  tx.sign([payer, ...signers]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    console.log((sim.value.logs ?? []).slice(-30).join("\n"));
    throw new Error(`${label}: simulation failed ${JSON.stringify(sim.value.err)}`);
  }
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  let err: unknown = null;
  try {
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    err = res.value.err;
  } catch (e) {
    err = e instanceof Error ? e.message : e;
  }
  if (err) {
    const got = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
    console.log((got?.meta?.logMessages ?? []).slice(-25).join("\n"));
    throw new Error(`${label}: failed on-chain ${JSON.stringify(got?.meta?.err ?? err)} ${sig}`);
  }
  return { sig, cu: sim.value.unitsConsumed };
}

/** Every account a vault's keeper/zap txs touch (plus whatever extra the caller passes). */
export async function vaultAccounts(conn: Connection, v: VaultState, extra: PublicKey[] = []) {
  const md = await conn.getAccountInfo(v.market);
  const m = decodeMarketBits(v.market, Buffer.from(md!.data));
  return [v.key, v.solPda, v.shareMint, v.wsolAta, v.xAta, v.quoteAta, v.downAta, v.market, v.pool, v.xMint, v.downMint, m.vaultBear, m.bearMint, m.baseVaultBear, m.poolBear, ...extra];
}
/** Put a vault's accounts into our lookup tables (opening a new one if they're full). Returns every live table. */
export async function vaultAlt(conn: Connection, authority: Keypair, _existing: PublicKey | null, v: VaultState, extra: PublicKey[]) {
  return ensureAlts(conn, authority, await vaultAccounts(conn, v, extra), () => {});
}

/** One keeper transaction: [acts..., settle]. */
export async function rebalanceTx(conn: Connection, payer: Keypair, v: VaultState, inner: TransactionInstruction[], pre: TransactionInstruction[], post: TransactionInstruction[], signers: Signer[], tables: AddressLookupTableAccount[], label: string, position?: PublicKey) {
  const val = await valAccounts(conn, v);
  if (position) val[6] = { pubkey: position, isSigner: false, isWritable: false }; // a position bound inside this tx must already sit in the valuation slot
  const ixs = [...pre, ...inner.map((ix) => actIx(v, val, ix)), ...post, settleIx(v, val, payer.publicKey)];
  return send(conn, payer, ixs, signers, tables, label);
}

export { valuation, hedgeDelta, wrapIx, HOOKED, getAssociatedTokenAddressSync };
export type { Valuation };
