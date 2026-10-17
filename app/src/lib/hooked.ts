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
import { DBC, MEME_MINT, PROGRAM_ID, RFSTACC } from "../config.js";
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
  /** Oracle venue (0 Raydium CLMM = default, 1 PumpSwap, 2 Raydium CPMM, 3 Meteora DAMM v2, 4 Meteora DLMM). */
  oracleKind?: number;
  /** Kinds 1/2: the venue's pool account — create_market's trailing account (the program verifies the two slot token accounts
   *  against it). Kind 1 keeps needing it: poke / settle_begin / redeem pass the PumpSwap Pool after the oracle_pool slot so
   *  the program can read `virtual_quote_reserves`. */
  venuePool?: PublicKey;
};

/** Trailing oracle accounts for poke / settle_begin / redeem: the oracle_pool slot for every kind (kind 0 only uses it when
 *  the ring is dead; kinds 1/2 require it; 3/4 just check it), then the PumpSwap Pool for kind 1 (required, read-only). */
export function oracleTail(m: MarketKeys) {
  const tail = [r(m.oraclePool)];
  if (m.oracleKind === 1) {
    if (!m.venuePool) throw new Error("kind 1 (PumpSwap) markets need the venue pool for poke/settle/redeem");
    tail.push(r(m.venuePool));
  }
  return tail;
}

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

/** data: tag 0 | window_secs u32 | underlying_is_token0 u8 | [oracle_kind u8 — omitted for kind 0, so CLMM markets are byte-for-byte what they were].
 *  Kinds 1 (PumpSwap) and 2 (Raydium CPMM) append the venue pool as one trailing read-only account. */
export function createMarketIx(payer: PublicKey, m: MarketKeys) {
  const b = sideAccounts(m, 0);
  const e = sideAccounts(m, 1);
  const kind = m.oracleKind ?? 0;
  const data = Buffer.alloc(kind ? 7 : 6);
  data[0] = 0;
  data.writeUInt32LE(m.windowSecs, 1);
  data[5] = m.underlyingIsToken0;
  if (kind) data[6] = kind;
  const keys = [
    s(payer), w(m.key), w(b.vault), w(e.vault), r(m.bullMint), r(m.bearMint), r(b.pool), r(e.pool),
    r(b.baseVault), r(e.baseVault), r(b.quoteVault), r(e.quoteVault), r(RFSTACC), r(b.escrow), r(e.escrow),
    w(b.meta), w(e.meta), r(m.oraclePool), r(m.oracleObs), r(SystemProgram.programId), r(TOKEN_PROGRAM_ID),
  ];
  if (kind === 1 || kind === 2) {
    if (!m.venuePool) throw new Error("create_market: kinds 1/2 need the venue pool account");
    keys.push(r(m.venuePool));
  }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

export function pokeIx(m: MarketKeys) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [w(m.key), r(m.oracleObs), w(vaultPda(m.key, 0)), w(vaultPda(m.key, 1)), r(TOKEN_PROGRAM_ID), ...oracleTail(m)],
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
      w(vaultPda(m.key, 1)), r(a.baseVault), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), w(burnVaultPda()), w(DEV_ATA), ...oracleTail(m),
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
      r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), w(a.mint), w(a.escrow), r(a.pool), r(SYSVAR_INSTRUCTIONS_PUBKEY), ...oracleTail(m),
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

// ---------- launches: a market's companion pump.fun coins ($TICKERUP / $TICKERDN, quoted in $100XBRO) ----------
/** `register_launch` tag. */
export const TAG_REGISTER_LAUNCH = 8;
/** `boost` tag. */
export const TAG_BOOST = 9;
/** Launch.mode 0: Launch PDA is a 9000 bps shareholder next to the lister's 1000. boost burns 1/9 and sells 8/9. */
export const LAUNCH_MODE_SHARED = 0;
/** Launch.mode 1: Launch PDA receives 100%; boost pays the lister 10%, burns 10%, sells 80%. */
export const LAUNCH_MODE_FULL = 1;
/** Same value as LAUNCH_MODE_FULL. */
export const LAUNCH_MODE_SOLE = LAUNCH_MODE_FULL;
/** Fee split a launch advertises: pump's 3% creator fee → 80% side vault · 10% lister · 10% burn. */
export const LAUNCH_CREATOR_FEE_BPS = 300;
export const LAUNCH_SPLIT = { vault: 80, lister: 10, burn: 10 } as const;
/** On-chain `Launch` (state.rs): 144 bytes, disc `hooklnch`. `curve` is derived, not stored. */
export const LAUNCH_LAYOUT = { len: 144, disc: 0, market: 8, mint: 40, lister: 72, side: 104, mode: 105, bump: 106, solBump: 107, totalSold: 112, totalBurned: 120, totalLister: 128, totalBoost: 136 } as const;
const LAUNCH_DISC = Buffer.from("hooklnch");

export type Launch = {
  key: PublicKey;
  market: PublicKey;
  mint: PublicKey;
  /** Bonding-curve PDA of `mint`. Not a field on the account. */
  curve: PublicKey;
  lister: PublicKey;
  side: 0 | 1;
  mode: number;
  bump: number;
  solBump: number;
  totalSold: bigint;
  totalBurned: bigint;
  totalLister: bigint;
  totalBoost: bigint;
};

/** ["launch", market, side u8] under our program. */
export const launchPda = (market: PublicKey, side: 0 | 1) =>
  PublicKey.findProgramAddressSync([Buffer.from("launch"), market.toBuffer(), Buffer.from([side])], PROGRAM_ID)[0];
/** ["launch-sol", market, side u8], data-less and system-owned. Holds unwrapped SOL inside boost. */
export const launchSolPda = (market: PublicKey, side: 0 | 1) =>
  PublicKey.findProgramAddressSync([Buffer.from("launch-sol"), market.toBuffer(), Buffer.from([side])], PROGRAM_ID)[0];
/** pump's BondingCurve PDA for a coin. */
export const pumpCurvePda = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP)[0];
export const PUMP_FEES = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const sharingConfigPda = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("sharing-config"), mint.toBuffer()], PUMP_FEES)[0];
const STAKE_POOL_PROGRAM = new PublicKey("SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY");
/** PumpSwap sell_v2 fee_config second seed (idl/pump_amm.json), under PUMP_FEES. */
const PS_FEE_CONFIG_SEED = Buffer.from([12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101, 244, 41, 141, 49, 86, 213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99]);

export function decodeLaunch(key: PublicKey, d: Uint8Array): Launch | null {
  if (d.length !== LAUNCH_LAYOUT.len) return null;
  const b = Buffer.from(d);
  if (!b.subarray(0, 8).equals(LAUNCH_DISC)) return null;
  const side = b[LAUNCH_LAYOUT.side];
  if (side !== 0 && side !== 1) return null;
  const pk = (o: number) => new PublicKey(b.subarray(o, o + 32));
  const mint = pk(LAUNCH_LAYOUT.mint);
  return {
    key, market: pk(LAUNCH_LAYOUT.market), mint, curve: pumpCurvePda(mint), lister: pk(LAUNCH_LAYOUT.lister), side,
    mode: b[LAUNCH_LAYOUT.mode], bump: b[LAUNCH_LAYOUT.bump], solBump: b[LAUNCH_LAYOUT.solBump],
    totalSold: b.readBigUInt64LE(LAUNCH_LAYOUT.totalSold), totalBurned: b.readBigUInt64LE(LAUNCH_LAYOUT.totalBurned),
    totalLister: b.readBigUInt64LE(LAUNCH_LAYOUT.totalLister), totalBoost: b.readBigUInt64LE(LAUNCH_LAYOUT.totalBoost),
  };
}

/** register_launch(side u8, mode u8).
 *  0 lister (signer, payer) · 1 market · 2 launch (w, init) · 3 pump_mint · 4 bonding_curve · 5 system · 6 sharing_config */
export function registerLaunchIx(lister: PublicKey, market: PublicKey, side: 0 | 1, mode: number, pumpMint: PublicKey) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [s(lister), r(market), w(launchPda(market, side)), r(pumpMint), r(pumpCurvePda(pumpMint)), r(SystemProgram.programId), r(sharingConfigPda(pumpMint))],
    data: Buffer.from([TAG_REGISTER_LAUNCH, side, mode]),
  });
}

/** Accounts `boost` cannot derive: the canonical pool's vaults, one buyback recipient, and the stake pool's reserve and manager-fee account.
 *  The WSOL ATA must already exist (the instruction closes it). `user_volume_accumulator` is created inside boost when empty. */
export type BoostVenue = { poolBase: PublicKey; poolQuote: PublicKey; buybackFeeRecipient: PublicKey; reserveStake: PublicKey; managerFee: PublicKey };

/** boost(min_quote_out u64). Account order matches `boost` in programs/hooked/src/processor.rs. */
export function boostIx(caller: PublicKey, launch: Launch, venue: BoostVenue, minQuoteOut: bigint) {
  const memeAta = (owner: PublicKey) => getAssociatedTokenAddressSync(MEME_MINT, owner, true, TOKEN_2022_PROGRAM_ID);
  const pool = memeVenue(MEME_MINT).pool;
  const globalConfig = PublicKey.findProgramAddressSync([Buffer.from("global_config")], PUMPSWAP)[0];
  const userVolume = PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), launch.key.toBuffer()], PUMPSWAP)[0];
  const feeConfig = PublicKey.findProgramAddressSync([Buffer.from("fee_config"), PS_FEE_CONFIG_SEED], PUMP_FEES)[0];
  const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMPSWAP)[0];
  const withdraw = PublicKey.findProgramAddressSync([STAKE_POOL_ACCT.toBuffer(), Buffer.from("withdraw")], STAKE_POOL_PROGRAM)[0];
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      s(caller), r(launch.market), w(launch.key), w(memeAta(launch.key)), w(memeAta(launch.lister)), w(vaultPda(launch.market, launch.side)),
      w(launchSolPda(launch.market, launch.side)), w(getAssociatedTokenAddressSync(WSOL_MINT, launch.key, true, TOKEN_PROGRAM_ID)),
      w(MEME_MINT), r(WSOL_MINT), r(TOKEN_2022_PROGRAM_ID), r(TOKEN_PROGRAM_ID), r(SystemProgram.programId), r(PUMPSWAP),
      r(globalConfig), w(pool), w(venue.poolBase), w(venue.poolQuote), w(userVolume), r(feeConfig), w(venue.buybackFeeRecipient), r(eventAuthority),
      r(STAKE_POOL_PROGRAM), w(STAKE_POOL_ACCT), r(withdraw), w(venue.reserveStake), w(venue.managerFee), w(RFSTACC),
    ],
    data: Buffer.concat([Buffer.from([TAG_BOOST]), u64(minQuoteOut)]),
  });
}
