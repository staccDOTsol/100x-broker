// dnvault keeper — permissionless, paid keeper_bps by every settle it lands.
// Every LOOP_MS, for every vault: harvest LP fees, deploy idle SOL (swap half to X, buy the DOWN hedge, add
// liquidity), and pull the hedge back inside the band when the price has moved. The program verifies every
// transaction (no value leak, hedge no worse), so this is just the proposer.
// Env: KEEPER_KEY (json array / base58 / file), RPC, LOOP_MS, ALT, MIN_DEPLOY_SOL, RESERVE_SOL, DRY_RUN
import { listAlts } from "../alt";
import fs from "fs";
import { Buffer } from "buffer";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import * as RaySdk from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { WSOL, decodeMarketBits, hedgeDelta, listVaults, readVault, unwrapIx, valuation, wrapIx, type VaultState, type Valuation } from "./lib";
import { big, dbcClient, decreaseIx, hedgeBuyIxs, hedgeSellIxs, loadRay, openPositionIxs, poolCtx, quoteBuy, readPosition, rebalanceTx, rewardAtas, send, swapIx, type PoolCtx, vaultAlt } from "./ops";
import { liquidityFromAmounts, sqrtPriceAtTick } from "./clmm-math";
import { bindPositionIx } from "./lib";
import { redeemIx, type Market } from "../lib";
const { ClmmInstrument } = RaySdk as any;

const RPC = process.env.RPC ?? "https://mainnet.helius-rpc.com/?api-key=f5f1e120-3a60-4e11-a9ed-2b91856e664a";
const conn = new Connection(RPC, "confirmed");
const LOOP_MS = Number(process.env.LOOP_MS ?? 60_000);
// lookup tables are discovered on chain by authority (see scripts/alt.ts); refreshed every minute so new tables show up
const MIN_DEPLOY = BigInt(Math.round(Number(process.env.MIN_DEPLOY_SOL ?? "0.05") * 1e9));
const RESERVE = BigInt(Math.round(Number(process.env.RESERVE_SOL ?? "0.03") * 1e9));
const HEDGE_FLOOR = BigInt(Math.round(Number(process.env.HEDGE_FLOOR_SOL ?? "0.005") * 1e9)); // a re-hedge may dip into the reserve down to this
const HARVEST_MIN = BigInt(Math.round(Number(process.env.HARVEST_MIN_SOL ?? "0.003") * 1e9));
// a hedge buy pays the DOWN curve and is marked at what the pot would pay for those tokens (after the 4% fee). On a crowded
// DOWN book the curve price is hype and the pot is money: the vault eats the gap on the spot. Above this haircut the hedge
// costs more than it can ever pay back from fees, so the keeper leaves the exposure unhedged and says so.
const HEDGE_MAX_HAIRCUT_BPS = BigInt(process.env.HEDGE_MAX_HAIRCUT_BPS ?? "2500");
const DRY = process.env.DRY_RUN === "1";
const key = (() => {
  const raw = process.env.KEEPER_KEY ?? "keeper.json";
  if (raw.trim().startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  if (fs.existsSync(raw)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(raw, "utf8"))));
  return Keypair.fromSecretKey(bs58.decode(raw));
})();
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sol = (n: bigint) => `${(Number(n) / 1e9).toFixed(5)}`;

async function hookedMarket(v: VaultState): Promise<Market> {
  const d = Buffer.from((await conn.getAccountInfo(v.market))!.data);
  const pk = (o: number) => new PublicKey(d.subarray(o, o + 32));
  const pool = await conn.getAccountInfo(pk(264));
  return { key: v.market, bullMint: pk(8), bearMint: pk(40), oraclePool: pk(104), oracleObs: pk(136), windowSecs: d.readUInt32LE(480), underlyingIsToken0: d[489], config: new PublicKey(pool!.data.subarray(72, 104)) };
}

const ray = await loadRay(conn, key);
const dbc = await dbcClient(conn);
const ctxCache = new Map<string, { at: number; ctx: PoolCtx }>();
async function ctxFor(v: VaultState) {
  const hit = ctxCache.get(v.pool.toBase58());
  if (hit && Date.now() - hit.at < 120_000) return hit.ctx;
  const ctx = await poolCtx(conn, ray, v.pool);
  ctxCache.set(v.pool.toBase58(), { at: Date.now(), ctx });
  return ctx;
}
let altCache: { at: number; tables: Awaited<ReturnType<typeof listAlts>> } | null = null;
async function tables() {
  if (altCache && Date.now() - altCache.at < 60_000) return altCache.tables;
  const t = await listAlts(conn, key.publicKey);
  altCache = { at: Date.now(), tables: t };
  return t;
}

/** Buy or sell DOWN so pot share lands on D*; `dStarOverride` lets a deploy pre-hedge exposure it is about to create.
 *  Returns the instructions and the SOL a buy will pull out of the sub-account. */
async function hedgeIxs(v: VaultState, m: Market, x: Valuation, dStarOverride?: bigint, available = x.free, floor = RESERVE, sellScale = 100n): Promise<{ ixs: TransactionInstruction[]; spend: bigint }> {
  const est = dStarOverride !== undefined ? { ...x, dStar: dStarOverride } : x;
  const t = hedgeDelta(est);
  const bits = decodeMarketBits(v.market, Buffer.from((await conn.getAccountInfo(v.market))!.data));
  if (t > 0n) {
    const q = await quoteBuy(dbc, bits.poolBear, t, est.dStar + 2_000_000n);
    const spend = (q.budget * 1010n) / 1000n + 2_000n; // r-fstacc budget + the stake pool's rate/fee margin
    const affordable = available > floor ? available - floor : 0n;
    if (spend > affordable) throw new Error(`hedge needs ${sol(spend)} SOL, only ${sol(affordable)} free`);
    // what the pot would pay for the tokens we are about to buy, after the redeem fee (the mark the vault carries them at)
    const circAfter = x.circulating + t;
    const potMark = circAfter > 0n ? (((x.pot + (q.budget * 60n) / 100n) * t) / circAfter) * 96n / 100n : 0n;
    const haircutBps = q.budget > 0n ? ((q.budget - potMark) * 10_000n) / q.budget : 0n;
    if (haircutBps > HEDGE_MAX_HAIRCUT_BPS) {
      log(`  hedge: skipped — curve asks ${sol(q.budget)} SOL for ${t} DOWN the pot would pay ${sol(potMark)} for (${haircutBps} bps haircut > ${HEDGE_MAX_HAIRCUT_BPS}); leaving D ${sol(x.d)} vs D* ${sol(est.dStar)} until the book is worth hedging into`);
      return { ixs: [], spend: 0n };
    }
    log(`  hedge: buy ${t} DOWN for ${sol(q.budget)} SOL (D ${sol(x.d)} -> D* ${sol(est.dStar)})`);
    const ixs = await hedgeBuyIxs(conn, dbc, v, bits.poolBear, q.budget, q.min, key.publicKey);
    // nobody else holds DOWN: any buy makes the vault 100% of the pot, which is far over target. In the same tx, cash out just
    // enough of the dust so the pot itself shrinks to D* (the program judges the hedge relative to D*, so over is worse than empty)
    if (x.circulating === 0n && x.pot > est.dStar) {
      const n = (t * (x.pot - est.dStar)) / ((x.pot * 96n) / 100n);
      if (n > 0n && n < t) {
        log(`  hedge: sole holder — cash out ${n} of the dust so the pot lands on D*`);
        ixs.push(redeemIx(m, v.key, 1, n));
      }
    }
    return { ixs, spend };
  }
  if (t < 0n) {
    let n = -t > x.held ? x.held : -t;
    n = (n * sellScale) / 100n; // the pot model is approximate; callers back off on HedgeWorse
    const expect = x.circulating > 0n ? (((x.pot * n) / x.circulating) * 96n) / 100n : 0n;
    log(`  hedge: redeem ${n} DOWN (D ${sol(x.d)} -> D* ${sol(est.dStar)}), expect ${sol(expect)} r-fstacc`);
    return { ixs: await hedgeSellIxs(conn, v, m, n, expect), spend: 0n };
  }
  return { ixs: [], spend: 0n };
}

/** Loose WSOL / X in pool order, read no earlier than the slot `afterSig` landed in (load-balanced RPC nodes lag a second). */
async function looseBalances(v: VaultState, ctx: PoolCtx, afterSig?: string): Promise<[bigint, bigint]> {
  const aIsWsol = ctx.poolInfo.mintA.address === WSOL.toBase58();
  const keys = aIsWsol ? [v.wsolAta, v.xAta] : [v.xAta, v.wsolAta];
  const slot = afterSig ? (await conn.getSignatureStatuses([afterSig])).value[0]?.slot : undefined;
  for (let i = 0; ; i++) {
    try {
      const infos = await conn.getMultipleAccountsInfo(keys, slot !== undefined ? { commitment: "confirmed", minContextSlot: slot } : { commitment: "confirmed" });
      return [infos[0] ? infos[0].data.readBigUInt64LE(64) : 0n, infos[1] ? infos[1].data.readBigUInt64LE(64) : 0n];
    } catch (e) {
      if (i >= 8) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Fold loose balances into the existing position (99% sizing, full balances as the max). False when there is nothing to add. */
async function addLiquidity(v: VaultState, ctx: PoolCtx, tbl: Awaited<ReturnType<typeof tables>>, balA: bigint, balB: bigint, label = "add liquidity") {
  if (!v.position) return false;
  const ownerPosition = await readPosition(conn, v.position);
  const liquidity = liquidityFromAmounts(big(ctx.compute.sqrtPriceX64), sqrtPriceAtTick(v.tickLower), sqrtPriceAtTick(v.tickUpper), (balA * 99n) / 100n, (balB * 99n) / 100n);
  if (liquidity === 0n) return false;
  const aIsWsol = ctx.poolInfo.mintA.address === WSOL.toBase58();
  const r3 = ClmmInstrument.increasePositionFromLiquidityInstructions({
    poolInfo: ctx.poolInfo, poolKeys: ctx.poolKeys, ownerPosition,
    ownerInfo: { wallet: v.solPda, tokenAccountA: aIsWsol ? v.wsolAta : v.xAta, tokenAccountB: aIsWsol ? v.xAta : v.wsolAta },
    liquidity: new BN(liquidity.toString()), amountMaxA: new BN(balA.toString()), amountMaxB: new BN(balB.toString()), nft2022: true,
  });
  const clmm = r3.instructions.filter((i: TransactionInstruction) => i.programId.toBase58() === ctx.poolInfo.programId);
  if (DRY) return log(`  would ${label}: ${liquidity}`), true;
  const r2 = await rebalanceTx(conn, key, v, clmm, [], [], [], tbl, `deploy: ${label}`);
  log(`  ${label}: +${liquidity} ${r2.sig}`);
  return true;
}

async function deploy(v: VaultState, m: Market, x: Valuation, ctx: PoolCtx, tbl: Awaited<ReturnType<typeof tables>>) {
  // resume: an earlier deploy swapped half to X but the position never opened (e.g. ValueLeaked on a vault too small for the
  // rent). Swapping again would just keep halving the SOL into X; open the position with what is already loose instead.
  if (!v.position && x.xRaw > 0n && x.xVal > MIN_DEPLOY / 4n) {
    const spare = x.free > RESERVE ? x.free - RESERVE : 0n;
    const pre: TransactionInstruction[] = spare > 0n ? [createAssociatedTokenAccountIdempotentInstruction(key.publicKey, v.wsolAta, v.solPda, WSOL), wrapIx(v, spare)] : [];
    const aIsWsol = ctx.poolInfo.mintA.address === WSOL.toBase58();
    const [balA, balB] = aIsWsol ? [x.wsol + spare, x.xRaw] : [x.xRaw, x.wsol + spare];
    log(`  deploy: resuming with loose X ${sol(x.xVal)} + ${sol(x.wsol + spare)} SOL, opening the position`);
    if (DRY) return true;
    const op = await openPositionIxs(ctx, v, key.publicKey, balA, balB);
    const addr: any = op.address;
    const clmm = op.instructions.filter((i) => i.programId.toBase58() === ctx.poolInfo.programId);
    const other = op.instructions.filter((i) => i.programId.toBase58() !== ctx.poolInfo.programId);
    const r2 = await rebalanceTx(conn, key, v, clmm, [...pre, ...other], [bindPositionIx(v, addr.personalPosition, addr.positionNftAccount)], op.signers, tbl, "deploy: open position (resume)", addr.personalPosition);
    log(`  opened position ${addr.personalPosition.toBase58()} liquidity ${op.liquidity} ${r2.sig}`);
    return true;
  }
  const idle = x.free + x.wsol;
  if (idle <= RESERVE + MIN_DEPLOY) return false;
  // price the hedge first (it is paid from un-wrapped SOL), then wrap and swap what is left
  const guessHalf = (idle - RESERVE) / 2n;
  // the hedge is paid in SOL from the sub-account; if only WSOL is loose, unwrap it first (and re-create the ATA for the wrap)
  // the program values the X we are about to buy at the market TWAP, we pay the pool price; on a young oracle those can be
  // far apart, so size the hedge to what the program will see (it re-hedges toward reality as the TWAP converges)
  const skew = Math.pow(1.0001, v.xIsToken0 ? x.twapTick - x.poolTick : x.poolTick - x.twapTick);
  const seen = BigInt(Math.round(Number(guessHalf) * Math.min(Math.max(skew, 0.05), 20)));
  if (Math.abs(skew - 1) > 0.1) log(`  deploy: oracle ${x.twapTick} vs pool ${x.poolTick}: program values the new X at ${skew.toFixed(2)}× pool, hedging to that`);
  // a DOWN pot smaller than the hedge the new exposure needs cannot be bought into; swapping into X anyway is the HedgeWorse
  // rejection we kept hitting every pass. Wait for the book (anyone buying DOWN, or a tip) and keep the SOL parked.
  const dStarAfter = (x.xVal + seen) / 100n;
  if (dStarAfter > 0n && x.pot <= dStarAfter) {
    log(`  deploy: DOWN pot ${sol(x.pot)} < hedge needed ${sol(dStarAfter)}; starved, parking ${sol(idle)} until DOWN refills`);
    return false;
  }
  const hedge = await hedgeIxs(v, m, x, dStarAfter, x.free + x.wsol);
  if (dStarAfter > 0n && !hedge.ixs.length) {
    log(`  deploy: the hedge is not worth buying on this book; parking ${sol(idle)} unhedged-and-undeployed rather than swapping into X without cover`);
    return false;
  }
  if (idle <= RESERVE + hedge.spend + MIN_DEPLOY) return false;
  const amount = idle - RESERVE - hedge.spend;
  const freeAfterReserve = x.free > RESERVE ? x.free - RESERVE : 0n;
  const unwrapFirst = hedge.spend > freeAfterReserve && x.wsol > 0n;
  const wsolLoose = unwrapFirst ? 0n : x.wsol;
  const toWrap = amount > wsolLoose ? amount - wsolLoose : 0n;
  const pre: TransactionInstruction[] = unwrapFirst ? [unwrapIx(v), createAssociatedTokenAccountIdempotentInstruction(key.publicKey, v.wsolAta, v.solPda, WSOL)] : [];
  if (toWrap > 0n) pre.push(wrapIx(v, toWrap));
  if (unwrapFirst) log(`  deploy: unwrapping ${sol(x.wsol)} WSOL to fund the ${sol(hedge.spend)} hedge`);
  const half = amount / 2n;
  const sw = await swapIx(conn, ctx, v, WSOL, half);
  log(`  deploy: wrap ${sol(toWrap)} swap ${sol(half)} -> X (min ${sw.minOut}) + hedge (${sol(hedge.spend)})`);
  if (DRY) return true;
  const r = await rebalanceTx(conn, key, v, [sw.ix, ...hedge.ixs], pre, [], [], tbl, "deploy: swap+hedge");
  log(`  deploy tx ${r.sig} (${r.cu} cu)`);
  // then the liquidity, in its own tx (exposure unchanged, so no hedge move)
  v = await readVault(conn, v.key);
  const [balA, balB] = await looseBalances(v, ctx, r.sig);
  if (!v.position) {
    const op = await openPositionIxs(ctx, v, key.publicKey, balA, balB);
    const addr: any = op.address;
    const clmm = op.instructions.filter((i) => i.programId.toBase58() === ctx.poolInfo.programId);
    const other = op.instructions.filter((i) => i.programId.toBase58() !== ctx.poolInfo.programId);
    const r2 = await rebalanceTx(conn, key, v, clmm, other, [bindPositionIx(v, addr.personalPosition, addr.positionNftAccount)], op.signers, tbl, "deploy: open position", addr.personalPosition);
    log(`  opened position ${addr.personalPosition.toBase58()} liquidity ${op.liquidity} ${r2.sig}`);
  } else {
    await addLiquidity(v, ctx, tbl, balA, balB, "increase liquidity");
  }
  return true;
}

async function harvest(v: VaultState, x: Valuation, ctx: PoolCtx, tbl: Awaited<ReturnType<typeof tables>>) {
  const owed = x.feesOwed[0] + x.feesOwed[1];
  if (!v.position || owed === 0n) return false;
  // value the owed fees roughly: token1 owed + token0 owed at pool price
  const aIsWsol = ctx.poolInfo.mintA.address === WSOL.toBase58();
  const owedSol = aIsWsol ? x.feesOwed[0] : x.feesOwed[1];
  if (owedSol * 2n < HARVEST_MIN) return false;
  log(`  harvest: fees owed ${x.feesOwed[0]} / ${x.feesOwed[1]}`);
  if (DRY) return true;
  const ix = await decreaseIx(conn, ctx, v, 0n, aIsWsol ? v.wsolAta : v.xAta, aIsWsol ? v.xAta : v.wsolAta);
  // pools with farming rewards need the sub-account's reward ATAs to exist before the decrease
  const r = await rebalanceTx(conn, key, v, [ix], rewardAtas(ctx, v.solPda, key.publicKey).creates, [], [], tbl, "harvest");
  log(`  harvested ${r.sig}`);
  return true;
}

const altDone = new Set<string>();
async function tick(v: VaultState) {
  const ctx = await ctxFor(v);
  // vaults made from the site/CLI arrive without lookup-table entries; without them the deploy tx is over 1232 bytes
  if (!altDone.has(v.key.toBase58())) {
    try {
      await vaultAlt(conn, key, null, v, [new PublicKey(ctx.poolKeys.vault.A), new PublicKey(ctx.poolKeys.vault.B), ctx.compute.observationId, v.xMint]);
      altCache = null;
      altDone.add(v.key.toBase58());
    } catch (e) {
      log("  alt sync failed (will retry next pass):", e instanceof Error ? e.message : e);
    }
  }
  const m = await hookedMarket(v);
  const tbl = await tables();
  // vault ATAs may not exist yet (fresh vault)
  const atas = await conn.getMultipleAccountsInfo([v.wsolAta, v.xAta, v.quoteAta, v.downAta]);
  if (atas.some((a) => !a)) {
    if (DRY) return log("  would create ATAs");
    await send(conn, key, [
      createAssociatedTokenAccountIdempotentInstruction(key.publicKey, v.wsolAta, v.solPda, WSOL),
      createAssociatedTokenAccountIdempotentInstruction(key.publicKey, v.xAta, v.solPda, v.xMint, v.xProgram),
      createAssociatedTokenAccountIdempotentInstruction(key.publicKey, v.quoteAta, v.key, new PublicKey("pSYRpDqr847kB2nD5ZhjcPsHLV2ZpUxweXm1MwiSTcc")),
      createAssociatedTokenAccountIdempotentInstruction(key.publicKey, v.downAta, v.key, v.downMint, new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")),
    ], [], [], "atas");
    log("  created vault ATAs");
  }
  let x = await valuation(conn, v);
  log(`${v.key.toBase58().slice(0, 6)} nav ${sol(x.nav)} free ${sol(x.free)} wsol ${sol(x.wsol)} xVal ${sol(x.xVal)} pos ${sol(x.solPos)} D ${sol(x.d)} D* ${sol(x.dStar)} err ${x.errBps} bps tick ${x.poolTick}/${x.twapTick}`);
  if (await harvest(v, x, ctx, tbl)) x = await valuation(conn, v);
  if (await deploy(v, m, x, ctx, tbl)) {
    v = await readVault(conn, v.key); // the deploy may have bound a position
    x = await valuation(conn, v);
    log(`  after deploy: nav ${sol(x.nav)} xVal ${sol(x.xVal)} pos ${sol(x.solPos)} D ${sol(x.d)} D* ${sol(x.dStar)} err ${x.errBps} bps`);
  }
  if (v.position && x.wsol > 2_000_000n && x.xRaw > 0n) {
    const [balA, balB] = await looseBalances(v, ctx);
    if (await addLiquidity(v, ctx, tbl, balA, balB, "fold loose into position")) x = await valuation(conn, v);
  }
  if (x.errBps > BigInt(v.bandBps) && x.dStar > 0n && x.pot <= x.dStar && x.d < x.dStar) {
    log(`  hedge: DOWN pot ${sol(x.pot)} < D* ${sol(x.dStar)}; nothing to buy until the book refills`);
  } else if (x.errBps > BigInt(v.bandBps) && x.dStar > 0n) {
    // the redeem→pot model is approximate (fee splits, pending transfers); if the program calls it worse, try smaller sizes
    for (const scale of [100n, 70n, 45n, 25n, 12n]) {
      const { ixs } = await hedgeIxs(v, m, x, undefined, x.free, HEDGE_FLOOR, scale);
      if (!ixs.length || DRY) break;
      try {
        const r = await rebalanceTx(conn, key, v, ixs, [], [], [], tbl, `re-hedge${scale === 100n ? "" : ` @${scale}%`}`);
        log(`  re-hedged ${r.sig}`);
        break;
      } catch (e) {
        if (!(e instanceof Error) || !/"Custom":13\b/.test(e.message) || scale === 12n) throw e;
      }
    }
  }
}

log("dn keeper", key.publicKey.toBase58(), DRY ? "(dry run)" : "", "rpc", RPC.replace(/api-key=.*/, "api-key=…"));
for (;;) {
  try {
    const vaults = await listVaults(conn);
    for (const v of vaults)
      await tick(v).catch((e) => {
        const msg = e instanceof Error ? e.message.split("\n").find((l) => l.trim()) ?? e.name : String(e);
        log(`  ${v.key.toBase58().slice(0, 6)} error:`, msg, process.env.DEBUG_ERR && e instanceof Error ? `\n${e.stack}` : "");
      });
  } catch (e) {
    log("loop", e instanceof Error ? e.message : e);
  }
  if (process.env.ONCE) break;
  await new Promise((r) => setTimeout(r, LOOP_MS));
}
