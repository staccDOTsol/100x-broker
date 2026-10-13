// Minimal r-freestacc stake pool helpers for the keeper (mirrors app/src/lib/zap.ts).
import { Buffer } from "buffer";
import { Connection, PublicKey, StakeProgram, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_STAKE_HISTORY_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { RFSTACC } from "./lib";

export const STAKE_POOL_PROGRAM = new PublicKey("SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY");
export const STAKE_POOL = new PublicKey("SzoSoRxsrL9sbFcwpbjbH5bRrzuvFtuytZTeuqZCfQ6");
const WITHDRAW_AUTHORITY = PublicKey.findProgramAddressSync([STAKE_POOL.toBuffer(), Buffer.from("withdraw")], STAKE_POOL_PROGRAM)[0];

export type Pool = { reserveStake: PublicKey; managerFeeAccount: PublicKey; totalLamports: bigint; poolTokenSupply: bigint; solWithdrawAuthority: PublicKey | null; rate: number };
export async function readPool(conn: Connection): Promise<Pool> {
  const d = Buffer.from((await conn.getAccountInfo(STAKE_POOL))!.data);
  let o = 0;
  const u8 = () => d[o++];
  const u64 = () => { const v = d.readBigUInt64LE(o); o += 8; return v; };
  const pk = () => { const v = new PublicKey(d.subarray(o, o + 32)); o += 32; return v; };
  const fee = () => { u64(); u64(); };
  const optPk = () => (u8() ? pk() : null);
  const future = () => { if (u8()) fee(); };
  u8(); pk(); pk(); pk(); u8(); pk();
  const reserveStake = pk(); pk();
  const managerFeeAccount = pk(); pk();
  const totalLamports = u64(); const poolTokenSupply = u64(); u64(); o += 48;
  fee(); future(); optPk(); optPk(); fee(); fee(); future(); u8(); optPk(); fee(); u8();
  const solWithdrawAuthority = optPk();
  return { reserveStake, managerFeeAccount, totalLamports, poolTokenSupply, solWithdrawAuthority, rate: Number(totalLamports) / Number(poolTokenSupply) };
}

/** DepositSol (14): `funder`'s SOL -> r-fstacc into `userQuoteAta` (referral = that same account). */
export function depositSolIx(p: Pool, funder: PublicKey, userQuoteAta: PublicKey, lamports: bigint) {
  const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const keys = [
    w(STAKE_POOL), r(WITHDRAW_AUTHORITY), w(p.reserveStake), { pubkey: funder, isSigner: true, isWritable: true }, w(userQuoteAta),
    w(p.managerFeeAccount), w(userQuoteAta), w(RFSTACC), r(SystemProgram.programId), r(TOKEN_PROGRAM_ID),
  ];
  const data = Buffer.alloc(9);
  data[0] = 14;
  data.writeBigUInt64LE(lamports, 1);
  return new TransactionInstruction({ programId: STAKE_POOL_PROGRAM, keys, data });
}

export function withdrawSolIx(p: Pool, user: PublicKey, userQuoteAta: PublicKey, tokens: bigint, dest: PublicKey = user) {
  const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const keys = [
    w(STAKE_POOL), r(WITHDRAW_AUTHORITY), { pubkey: user, isSigner: true, isWritable: false }, w(userQuoteAta), w(p.reserveStake), w(dest),
    w(p.managerFeeAccount), w(RFSTACC), r(SYSVAR_CLOCK_PUBKEY), r(SYSVAR_STAKE_HISTORY_PUBKEY), r(StakeProgram.programId), r(TOKEN_PROGRAM_ID),
  ];
  if (p.solWithdrawAuthority) keys.push({ pubkey: p.solWithdrawAuthority, isSigner: true, isWritable: false });
  const data = Buffer.alloc(9);
  data[0] = 16;
  data.writeBigUInt64LE(tokens, 1);
  return new TransactionInstruction({ programId: STAKE_POOL_PROGRAM, keys, data });
}
