// SOL <-> r-freestacc through its Sanctum single-validator stake pool (SPL stake-pool layout, different program).
// DepositSol mints r-fstacc instantly; WithdrawSol pays SOL from the reserve, which holds the whole pool.
import { Buffer } from "buffer";
import {
  PublicKey,
  StakeProgram,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { RFSTACC } from "../config.js";
import { conn } from "./chain.js";

export const STAKE_POOL_PROGRAM = new PublicKey("SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY");
export const STAKE_POOL = new PublicKey("SzoSoRxsrL9sbFcwpbjbH5bRrzuvFtuytZTeuqZCfQ6");
export const WITHDRAW_AUTHORITY = PublicKey.findProgramAddressSync(
  [STAKE_POOL.toBuffer(), Buffer.from("withdraw")],
  STAKE_POOL_PROGRAM,
)[0];

type Fee = { num: bigint; den: bigint };
export type PoolState = {
  reserveStake: PublicKey;
  managerFeeAccount: PublicKey;
  totalLamports: bigint;
  poolTokenSupply: bigint;
  solDepositAuthority: PublicKey | null;
  solWithdrawAuthority: PublicKey | null;
  solDepositFee: Fee;
  solReferralFee: number;
  solWithdrawalFee: Fee;
  reserveLamports: bigint;
  /** SOL per r-fstacc */
  rate: number;
};

/** Sequential borsh read of the StakePool account (Option/FutureEpoch fields make offsets variable). */
function parsePool(d: Buffer): Omit<PoolState, "reserveLamports" | "rate"> {
  let o = 0;
  const u8 = () => d[o++];
  const u64 = () => {
    const v = d.readBigUInt64LE(o);
    o += 8;
    return v;
  };
  const pk = () => {
    const v = new PublicKey(d.subarray(o, o + 32));
    o += 32;
    return v;
  };
  const fee = (): Fee => ({ den: u64(), num: u64() });
  const optPk = () => (u8() ? pk() : null);
  const future = () => {
    const tag = u8();
    if (tag) fee();
  };
  u8(); // account_type
  pk(); // manager
  pk(); // staker
  pk(); // stake_deposit_authority
  u8(); // stake_withdraw_bump_seed
  pk(); // validator_list
  const reserveStake = pk();
  pk(); // pool_mint
  const managerFeeAccount = pk();
  pk(); // token_program_id
  const totalLamports = u64();
  const poolTokenSupply = u64();
  u64(); // last_update_epoch
  o += 8 + 8 + 32; // lockup
  fee(); // epoch_fee
  future(); // next_epoch_fee
  optPk(); // preferred_deposit_validator
  optPk(); // preferred_withdraw_validator
  fee(); // stake_deposit_fee
  fee(); // stake_withdrawal_fee
  future(); // next_stake_withdrawal_fee
  u8(); // stake_referral_fee
  const solDepositAuthority = optPk();
  const solDepositFee = fee();
  const solReferralFee = u8();
  const solWithdrawAuthority = optPk();
  const solWithdrawalFee = fee();
  return {
    reserveStake, managerFeeAccount, totalLamports, poolTokenSupply, solDepositAuthority, solWithdrawAuthority,
    solDepositFee, solReferralFee, solWithdrawalFee,
  };
}

let cached: { at: number; v: PoolState } | null = null;
export async function poolState(): Promise<PoolState> {
  if (cached && Date.now() - cached.at < 20_000) return cached.v;
  const info = await conn.getAccountInfo(STAKE_POOL);
  if (!info) throw new Error("stake pool not found");
  const p = parsePool(Buffer.from(info.data));
  const reserve = await conn.getAccountInfo(p.reserveStake);
  const v: PoolState = {
    ...p,
    reserveLamports: BigInt(reserve?.lamports ?? 0),
    rate: Number(p.totalLamports) / Number(p.poolTokenSupply),
  };
  cached = { at: Date.now(), v };
  return v;
}

const mulDiv = (a: bigint, b: bigint, c: bigint) => (c === 0n ? 0n : (a * b) / c);

/** r-fstacc the user ends up with for `lamports` of SOL (fee taken, referral rebate ignored = lower bound). */
export function depositOut(p: PoolState, lamports: bigint): bigint {
  const minted = p.totalLamports === 0n ? lamports : mulDiv(lamports, p.poolTokenSupply, p.totalLamports);
  // the pool rounds its fee up; rounding down here left a fresh wallet 1 unit short of the swap. Overshoot, leave dust.
  const { num, den } = p.solDepositFee;
  const fee = den === 0n ? 0n : (minted * num + den - 1n) / den;
  const out = minted - fee - DEPOSIT_DUST;
  return out > 0n ? out : 0n;
}
/** r-fstacc left behind in the wallet on every SOL buy (1e-6 r-fstacc) so rounding can never starve the swap. */
const DEPOSIT_DUST = 1_000n;

/** Lamports paid out for burning `tokens` r-fstacc. */
export function withdrawOut(p: PoolState, tokens: bigint): bigint {
  const fee = mulDiv(tokens, p.solWithdrawalFee.num, p.solWithdrawalFee.den);
  return mulDiv(tokens - fee, p.totalLamports, p.poolTokenSupply);
}

/** r-fstacc needed so that withdrawOut >= lamports. */
export function tokensForLamports(p: PoolState, lamports: bigint): bigint {
  const gross = mulDiv(lamports, p.poolTokenSupply, p.totalLamports) + 1n;
  const den = p.solWithdrawalFee.den - p.solWithdrawalFee.num;
  return den <= 0n ? gross : (gross * p.solWithdrawalFee.den) / den + 1n;
}

/** Reserve must keep its rent-exempt minimum; a bit of headroom on top. */
export function withdrawCapacity(p: PoolState): bigint {
  const floor = 2_300_000n;
  return p.reserveLamports > floor ? p.reserveLamports - floor : 0n;
}

const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
const s = (pubkey: PublicKey, isWritable = true) => ({ pubkey, isSigner: true, isWritable });
const data = (tag: number, amount: bigint) => {
  const b = Buffer.alloc(9);
  b[0] = tag;
  b.writeBigUInt64LE(amount, 1);
  return b;
};

/** DepositSol (14): user's SOL -> r-fstacc into `userQuoteAta`. */
export function depositSolIx(p: PoolState, user: PublicKey, userQuoteAta: PublicKey, lamports: bigint, referral: PublicKey = userQuoteAta) {
  const keys = [
    w(STAKE_POOL), r(WITHDRAW_AUTHORITY), w(p.reserveStake), s(user), w(userQuoteAta), w(p.managerFeeAccount),
    w(referral), w(RFSTACC), r(SystemProgram.programId), r(TOKEN_PROGRAM_ID),
  ];
  if (p.solDepositAuthority) keys.push(s(p.solDepositAuthority, false));
  return new TransactionInstruction({ programId: STAKE_POOL_PROGRAM, keys, data: data(14, lamports) });
}

/** WithdrawSol (16): burn `tokens` r-fstacc from `userQuoteAta` -> SOL to `user`. */
export function withdrawSolIx(p: PoolState, user: PublicKey, userQuoteAta: PublicKey, tokens: bigint) {
  const keys = [
    w(STAKE_POOL), r(WITHDRAW_AUTHORITY), s(user, false), w(userQuoteAta), w(p.reserveStake), w(user),
    w(p.managerFeeAccount), w(RFSTACC), r(SYSVAR_CLOCK_PUBKEY), r(SYSVAR_STAKE_HISTORY_PUBKEY),
    r(StakeProgram.programId), r(TOKEN_PROGRAM_ID),
  ];
  if (p.solWithdrawAuthority) keys.push(s(p.solWithdrawAuthority, false));
  return new TransactionInstruction({ programId: STAKE_POOL_PROGRAM, keys, data: data(16, tokens) });
}
