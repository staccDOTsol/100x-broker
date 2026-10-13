// Exit router, shared by the market ticket and the bag page: sell into the curve for what it can absorb, cash the
// rest out at the pot, and take the whole pot instead when that pays more. Never leaves a holder without a way out.
import BN from "bn.js";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { curveCapacity, dbc, type MarketView } from "./chain.js";
import { claimFeesIx, cu, redeemIx, sideAccounts } from "./hooked.js";
import { withdrawSolIx, type PoolState, withdrawOut } from "./zap.js";
import { RFSTACC } from "../config.js";

export type ExitPlan = { sell: bigint; redeem: bigint; sellMin: bigint; redeemMin: bigint; sellOut: bigint; redeemOut: bigint };

/** What the pot pays for `n` tokens after the pending rebalance; `safe` is what we promise on-chain. */
export function potQuote(v: MarketView, side: 0 | 1, n: bigint) {
  const s = v.side[side];
  if (s.circulating <= 0n) return null;
  const vault = v.pending ? (v.pending.payer === side ? s.vault - v.pending.amount : s.vault + v.pending.amount) : s.vault;
  const gross = (vault * n) / s.circulating;
  const lst = gross - (gross * 400n) / 10_000n;
  return { lst, safe: (lst * 995n) / 1000n };
}

/**
 * What `n` freshly bought tokens cash out of the pot for (lamports) if the TWAP moves by `move`
 * (fraction; positive = this side wins). Mirrors the program: the loser hands over 1 − 1.0001^(−100·ticks) of its pot.
 */
export function whatIf(v: MarketView, side: 0 | 1, n: bigint, move: number, pool: PoolState): bigint {
  const s = v.side[side];
  const o = v.side[1 - side];
  const pend = v.pending;
  let mine = pend ? (pend.payer === side ? s.vault - pend.amount : s.vault + pend.amount) : s.vault;
  const theirs = pend ? (pend.payer === side ? o.vault + pend.amount : o.vault - pend.amount) : o.vault;
  const ticks = Math.log(1 + Math.abs(move)) / Math.log(1.0001);
  const f = 1 - Math.pow(1.0001, -100 * ticks);
  if (move > 0) mine += BigInt(Math.floor(Number(theirs) * f));
  else if (move < 0) mine -= BigInt(Math.floor(Number(mine) * f));
  const supply = s.circulating + n;
  if (supply <= 0n || mine <= 0n) return 0n;
  const gross = (mine * n) / supply;
  const lst = gross - (gross * 400n) / 10_000n;
  return withdrawOut(pool, lst);
}

/** DBC quote for `n` in (base when selling, quote when buying), 1% slippage. */
export async function curveQuote(v: MarketView, side: 0 | 1, n: bigint, sell: boolean) {
  const a = sideAccounts(v.keys, side);
  const p = await dbc.state.getPool(a.pool);
  const config = p && (await dbc.state.getPoolConfig(p.poolState.config));
  if (!p || !config) throw new Error("curve unavailable");
  const q: any = dbc.pool.swapQuote2({
    virtualPool: p, config, swapBaseForQuote: sell, hasReferral: false, eligibleForFirstSwapWithMinFee: false,
    currentPoint: new BN(Math.floor(Date.now() / 1000)), slippageBps: 100, swapMode: SwapMode.ExactIn, amountIn: new BN(n.toString()),
  });
  const out = BigInt((q.outputAmount ?? q.amountOut ?? 0).toString());
  return { out, min: BigInt((q.minimumAmountOut ?? (out * 99n) / 100n).toString()) };
}

/**
 * What `n` freshly bought tokens sell back for right now (r-fstacc, rough): the better of the pot at the post-buy supply and
 * the curve — which refunds `quoteIn` minus both 4% fees, then gets collected down by whatever the side still owes.
 */
export function sellBackEstimate(v: MarketView, side: 0 | 1, n: bigint, quoteIn: bigint): bigint {
  const s = v.side[side];
  const pend = v.pending;
  const vault = pend ? (pend.payer === side ? s.vault - pend.amount : s.vault + pend.amount) : s.vault;
  const supply = s.circulating + n;
  const gross = supply > 0n && n > 0n ? (vault * n) / supply : 0n;
  const pot = ((gross - (gross * 400n) / 10_000n) * 995n) / 1000n;
  const keep = Math.max(0, Math.min(1, 1 - s.owed));
  const curve = BigInt(Math.floor(Number(quoteIn) * 0.92 * keep));
  return curve > pot ? curve : pot;
}

/** Split `raw` tokens between curve and pot. `cap` is the curve's capacity (fetched when omitted). */
export async function planExit(v: MarketView, side: 0 | 1, raw: bigint, cap?: bigint | null): Promise<ExitPlan> {
  const c = cap ?? (await curveCapacity(v, side).catch(() => 0n));
  let sell = raw <= c ? raw : (c * 995n) / 1000n;
  let redeem = raw - sell;
  let sellOut = 0n, sellMin = 0n;
  if (sell > 0n) {
    try {
      ({ out: sellOut, min: sellMin } = await curveQuote(v, side, sell, true));
    } catch {
      sell = 0n;
      redeem = raw;
    }
  }
  const pq = redeem > 0n ? potQuote(v, side, redeem) : { lst: 0n, safe: 0n };
  const full = potQuote(v, side, raw);
  let plan: ExitPlan = { sell, redeem, sellMin, redeemMin: pq?.safe ?? 0n, sellOut, redeemOut: pq?.lst ?? 0n };
  if (full && full.lst > sellOut + (pq?.lst ?? 0n)) plan = { sell: 0n, redeem: raw, sellMin: 0n, redeemMin: full.safe, sellOut: 0n, redeemOut: full.lst };
  if (plan.sell === 0n && plan.redeem === 0n) throw new Error("nothing to exit");
  return plan;
}

const quoteAtaIx = (payer: PublicKey) => {
  const quoteAta = getAssociatedTokenAddressSync(RFSTACC, payer);
  return { quoteAta, ix: createAssociatedTokenAccountIdempotentInstruction(payer, quoteAta, payer, RFSTACC) };
};

/** Instructions for an exit per `plan`; pays out in SOL when `pool` is given, else leaves r-fstacc in the wallet. */
export async function exitIxs(v: MarketView, side: 0 | 1, plan: ExitPlan, payer: PublicKey, pool: PoolState | null): Promise<TransactionInstruction[]> {
  const a = sideAccounts(v.keys, side);
  const { quoteAta, ix } = quoteAtaIx(payer);
  const ixs = [cu(600_000), ix];
  if (plan.sell > 0n) {
    const tx = await dbc.pool.swap2WithTransferHook({
      owner: payer, pool: a.pool, swapBaseForQuote: true, referralTokenAccount: null, payer,
      swapMode: SwapMode.ExactIn, amountIn: new BN(plan.sell.toString()), minimumAmountOut: new BN(plan.sellMin.toString()),
    });
    ixs.push(...tx.instructions);
  }
  if (plan.redeem > 0n) ixs.push(redeemIx(v.keys, payer, side, plan.redeem));
  const min = plan.sellMin + plan.redeemMin;
  if (pool && min > 0n) ixs.push(withdrawSolIx(pool, payer, quoteAta, min));
  ixs.push(claimFeesIx(v.keys, side));
  return ixs;
}

/** Cash out at the pot only (no curve). */
export function redeemIxs(v: MarketView, side: 0 | 1, raw: bigint, payer: PublicKey, pool: PoolState | null) {
  const pq = potQuote(v, side, raw);
  if (!pq) throw new Error("nothing circulating");
  const { quoteAta, ix } = quoteAtaIx(payer);
  const ixs = [cu(350_000), ix, redeemIx(v.keys, payer, side, raw)];
  if (pool) ixs.push(withdrawSolIx(pool, payer, quoteAta, pq.safe));
  return { ixs, min: pq.safe, lst: pq.lst };
}
