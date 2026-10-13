// Instruction builders + PDAs for the hooked program (mirrors scripts/lib.ts, verified e2e).
import { Buffer } from "buffer";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  deriveDbcEventAuthority,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { DBC, PROGRAM_ID, RFSTACC } from "../config.js";
export const DEV_ATA = new PublicKey("6Jrrws5TmFTb4eCa63A4yNnaSCC62yvvHYspK3KW4SEd");
export const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMPSWAP = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const STAKE_POOL_ACCT = new PublicKey("SzoSoRxsrL9sbFcwpbjbH5bRrzuvFtuytZTeuqZCfQ6");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const burnVaultPda = () => PublicKey.findProgramAddressSync([Buffer.from("burn")], PROGRAM_ID)[0];
export const burnStatePda = () => PublicKey.findProgramAddressSync([Buffer.from("burn-state")], PROGRAM_ID)[0];

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
const s = (pubkey: PublicKey, isWritable = true) => ({ pubkey, isSigner: true, isWritable });

export type MarketKeys = {
  key: PublicKey;
  bullMint: PublicKey;
  bearMint: PublicKey;
  oraclePool: PublicKey;
  oracleObs: PublicKey;
  windowSecs: number;
  underlyingIsToken0: number;
  config: PublicKey;
};

export function marketPda(bull: PublicKey, bear: PublicKey, obs: PublicKey, windowSecs: number, flag: number) {
  const params = Buffer.alloc(5);
  params.writeUInt32LE(windowSecs, 0);
  params[4] = flag;
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), bull.toBuffer(), bear.toBuffer(), obs.toBuffer(), params],
    PROGRAM_ID,
  )[0];
}
export const vaultPda = (market: PublicKey, side: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer(), Buffer.from([side])], PROGRAM_ID)[0];
export const metaPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), mint.toBuffer()], PROGRAM_ID)[0];
export const escrowAta = (market: PublicKey, mint: PublicKey) =>
  getAssociatedTokenAddressSync(mint, market, true, TOKEN_2022_PROGRAM_ID);

export function sideAccounts(m: MarketKeys, side: number) {
  const mint = side === 0 ? m.bullMint : m.bearMint;
  const pool = deriveDbcPoolAddress(RFSTACC, mint, m.config);
  return {
    mint,
    pool,
    baseVault: deriveDbcTokenVaultAddress(pool, mint),
    quoteVault: deriveDbcTokenVaultAddress(pool, RFSTACC),
    escrow: escrowAta(m.key, mint),
    vault: vaultPda(m.key, side),
    meta: metaPda(mint),
  };
}

export function createMarketIx(payer: PublicKey, m: MarketKeys) {
  const b = sideAccounts(m, 0);
  const e = sideAccounts(m, 1);
  const data = Buffer.alloc(6);
  data[0] = 0;
  data.writeUInt32LE(m.windowSecs, 1);
  data[5] = m.underlyingIsToken0;
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      s(payer), w(m.key), w(b.vault), w(e.vault), r(m.bullMint), r(m.bearMint), r(b.pool), r(e.pool),
      r(b.baseVault), r(e.baseVault), r(b.quoteVault), r(e.quoteVault), r(RFSTACC), r(b.escrow), r(e.escrow),
      w(b.meta), w(e.meta), r(m.oraclePool), r(m.oracleObs), r(SystemProgram.programId), r(TOKEN_PROGRAM_ID),
    ],
    data,
  });
}

export function pokeIx(m: MarketKeys) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [w(m.key), r(m.oracleObs), w(vaultPda(m.key, 0)), w(vaultPda(m.key, 1)), r(TOKEN_PROGRAM_ID), r(m.oraclePool)],
    data: Buffer.from([1]),
  });
}

export function redeemIx(m: MarketKeys, user: PublicKey, side: number, amount: bigint) {
  const a = sideAccounts(m, side);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      s(user, false), w(getAssociatedTokenAddressSync(a.mint, user, false, TOKEN_2022_PROGRAM_ID)), w(a.mint),
      w(getAssociatedTokenAddressSync(RFSTACC, user)), w(m.key), r(m.oracleObs), w(vaultPda(m.key, 0)),
      w(vaultPda(m.key, 1)), r(a.baseVault), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), w(burnVaultPda()), w(DEV_ATA), r(m.oraclePool),
    ],
    data: Buffer.concat([Buffer.from([2, side]), u64(amount)]),
  });
}

export function settleBeginIx(m: MarketKeys, caller: PublicKey, side: number, amount: bigint) {
  const a = sideAccounts(m, side);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      s(caller, false), w(m.key), r(m.oracleObs), w(vaultPda(m.key, 0)), w(vaultPda(m.key, 1)),
      r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), w(a.mint), w(a.escrow), r(a.pool), r(SYSVAR_INSTRUCTIONS_PUBKEY), r(m.oraclePool),
    ],
    data: Buffer.concat([Buffer.from([3, side]), u64(amount)]),
  });
}

export function settleEndIx(m: MarketKeys, side: number) {
  const a = sideAccounts(m, side);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [w(m.key), w(a.escrow), r(a.pool), r(vaultPda(m.key, 1 - side)), r(TOKEN_2022_PROGRAM_ID)],
    data: Buffer.from([4]),
  });
}

/** Rewires an SDK-built DBC hook swap so it sells from the market escrow into the winning vault. */
export function settleSwapIx(sdkSwap: TransactionInstruction, m: MarketKeys, side: number, amount: bigint) {
  const a = sideAccounts(m, side);
  const keys = sdkSwap.keys.map((k) => ({ ...k }));
  keys[3] = w(a.escrow);
  keys[4] = w(vaultPda(m.key, 1 - side));
  const data = Buffer.from(sdkSwap.data);
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(0n, 16);
  return new TransactionInstruction({ programId: DBC, keys, data });
}

export function claimFeesIx(m: MarketKeys, side: number) {
  const a = sideAccounts(m, side);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      r(m.key), w(vaultPda(m.key, 0)), w(vaultPda(m.key, 1)), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), r(DBC),
      r(deriveDbcPoolAuthority()), r(m.config), w(a.pool), w(a.escrow), w(a.baseVault), w(a.quoteVault),
      r(a.mint), r(RFSTACC), r(deriveDbcEventAuthority()), w(burnVaultPda()), w(DEV_ATA),
    ],
    data: Buffer.from([5, side]),
  });
}


/** Creates the global burn pot (idempotent). [payer(s), burn_state(w), burn_vault(w), quote_mint, system, token program] */
export function initBurnIx(payer: PublicKey) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [s(payer), w(burnStatePda()), w(burnVaultPda()), r(RFSTACC), r(SystemProgram.programId), r(TOKEN_PROGRAM_ID)],
    data: Buffer.from([6]),
  });
}

/** Venue accounts for a meme mint: its bonding curve and canonical PumpSwap pool (+ pool token accounts). */
export function memeVenue(mint: PublicKey) {
  const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP);
  const [auth] = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mint.toBuffer()], PUMP);
  const idx = Buffer.alloc(2);
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from("pool"), idx, auth.toBuffer(), mint.toBuffer(), WSOL_MINT.toBuffer()], PUMPSWAP);
  return { bondingCurve, pool };
}

/** Burn `amount` of MEME from the caller and get paid from the pot. `poolBaseAta`/`poolQuoteAta` from the PumpSwap pool account (139/171). */
export function burnMemeIx(caller: PublicKey, mint: PublicKey, memeProgram: PublicKey, callerMemeAta: PublicKey, poolBaseAta: PublicKey, poolQuoteAta: PublicKey, amount: bigint) {
  const v = memeVenue(mint);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      s(caller, false), w(callerMemeAta), w(mint), w(getAssociatedTokenAddressSync(RFSTACC, caller)), w(burnVaultPda()), w(burnStatePda()),
      r(STAKE_POOL_ACCT), r(v.bondingCurve), r(v.pool), r(poolBaseAta), r(poolQuoteAta), r(memeProgram), r(TOKEN_PROGRAM_ID),
    ],
    data: Buffer.concat([Buffer.from([7]), u64(amount)]),
  });
}

export const cu = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
