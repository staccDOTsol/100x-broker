// Shared client helpers for the hooked program (instruction builders, PDAs, state decoding).
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  deriveDbcEventAuthority,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

export const PROGRAM_ID = new PublicKey(process.env.HOOKED_PROGRAM_ID ?? "T8EKHG9mJhwWNAYWisFKvbYynGMvSHP5Fb7kxSDh7cb");
export const RFSTACC = new PublicKey("pSYRpDqr847kB2nD5ZhjcPsHLV2ZpUxweXm1MwiSTcc");
export const DBC = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const DEV_ATA = new PublicKey("6Jrrws5TmFTb4eCa63A4yNnaSCC62yvvHYspK3KW4SEd");
export const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMPSWAP = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const STAKE_POOL_ACCT = new PublicKey("SzoSoRxsrL9sbFcwpbjbH5bRrzuvFtuytZTeuqZCfQ6");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const burnVaultPda = () => PublicKey.findProgramAddressSync([Buffer.from("burn")], PROGRAM_ID)[0];
export const burnStatePda = () => PublicKey.findProgramAddressSync([Buffer.from("burn-state")], PROGRAM_ID)[0];
export const LEVERAGE = 100;
export const REDEEM_FEE_BPS = 400n;
export const FUNDING_SHARE_BPS = 9000n;

const tag = (t: number, ...rest: Buffer[]) => Buffer.concat([Buffer.from([t]), ...rest]);
const u64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
const s = (pubkey: PublicKey, isWritable = true) => ({ pubkey, isSigner: true, isWritable });

export type Market = {
  key: PublicKey;
  bullMint: PublicKey;
  bearMint: PublicKey;
  oraclePool: PublicKey;
  oracleObs: PublicKey;
  windowSecs: number;
  underlyingIsToken0: number;
  config: PublicKey;
  /** Market.oracle_kind (byte 493): 0 Raydium CLMM (default), 1 PumpSwap, 2 Raydium CPMM, 3 Meteora DAMM v2, 4 Meteora DLMM. */
  oracleKind?: number;
  /** Kinds 1/2: the venue pool (create_market's trailing account). Kind 1 keeps needing it: poke / settle_begin / redeem pass
   *  the PumpSwap Pool after the oracle_pool slot so the program can read `virtual_quote_reserves`. */
  venuePool?: PublicKey;
};

// ---------- oracle venues (mirrors app/src/lib/venues.ts) ----------
export const KIND_PUMPSWAP = 1;
export const MARKET_ORACLE_KIND = 493;
/** PumpSwap Pool: base_ata @139, quote_ata @171, virtual_quote_reserves i128 @245 (only on accounts of >= 261 bytes). */
const PS_BASE_ATA = 139, PS_QUOTE_ATA = 171, PS_VIRTUAL_QUOTE = 245;
export const pumpSwapVirtualQuote = (d: Buffer): bigint => (d.length >= PS_VIRTUAL_QUOTE + 16 ? d.readBigUInt64LE(PS_VIRTUAL_QUOTE) + (d.readBigInt64LE(PS_VIRTUAL_QUOTE + 8) << 64n) : 0n);
export function pumpSwapCanonicalPool(mint: PublicKey): PublicKey {
  const [auth] = PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), mint.toBuffer()], PUMP);
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), Buffer.alloc(2), auth.toBuffer(), mint.toBuffer(), WSOL_MINT.toBuffer()], PUMPSWAP)[0];
}
/** The PumpSwap Pool behind a kind-1 market: the 7th ExtraAccountMetaList entry of the bull mint when present, else the canonical
 *  PDA of the underlying (the base vault's mint); its vault fields must equal the market's slots. */
export async function pumpSwapPoolOf(conn: Connection, bullMint: PublicKey, obs: PublicKey, pool: PublicKey, obsData: Buffer): Promise<PublicKey | null> {
  const canonical = pumpSwapCanonicalPool(new PublicKey(obsData.subarray(0, 32)));
  const [meta, canon] = await conn.getMultipleAccountsInfo([metaPda(bullMint), canonical]);
  const SEVENTH = 16 + 6 * 35; // disc 8 | len u32 | count u32 | 35-byte entries (discriminator u8 | address 32 | signer | writable)
  const listed = meta && meta.data.length >= SEVENTH + 35 && meta.data[SEVENTH] === 0 ? new PublicKey(meta.data.subarray(SEVENTH + 1, SEVENTH + 33)) : null;
  const ok = (d: Buffer | undefined) => !!d && d.length >= PS_QUOTE_ATA + 32 && new PublicKey(d.subarray(PS_BASE_ATA, PS_BASE_ATA + 32)).equals(obs) && new PublicKey(d.subarray(PS_QUOTE_ATA, PS_QUOTE_ATA + 32)).equals(pool);
  if (listed && !listed.equals(canonical) && ok((await conn.getAccountInfo(listed))?.data)) return listed;
  return canon?.owner.equals(PUMPSWAP) && ok(canon.data) ? canonical : null;
}
/** Spot tick (1.0001^tick = raw token1 per raw token0) of a non-CLMM venue from the two slot accounts (+ the PumpSwap Pool for kind 1). */
export function venueTick(kind: number, obsData: Buffer, poolData: Buffer, psPoolData?: Buffer): number {
  const LN = Math.log(1.0001);
  switch (kind) {
    case 1: {
      const eff = poolData.readBigUInt64LE(64) + (psPoolData ? pumpSwapVirtualQuote(psPoolData) : 0n);
      const a0 = Number(obsData.readBigUInt64LE(64));
      return psPoolData && eff > 0n && a0 > 0 ? Math.log(Number(eff) / a0) / LN : NaN;
    }
    case 2: {
      const a0 = Number(obsData.readBigUInt64LE(64)), a1 = Number(poolData.readBigUInt64LE(64));
      return a0 > 0 && a1 > 0 ? Math.log(a1 / a0) / LN : NaN;
    }
    case 3: {
      const sqrt = Number(poolData.readBigUInt64LE(456) + (poolData.readBigUInt64LE(464) << 64n)) / 2 ** 64;
      return sqrt > 0 ? (2 * Math.log(sqrt)) / LN : NaN;
    }
    case 4:
      return (poolData.readInt32LE(76) * Math.log(1 + poolData.readUInt16LE(80) / 1e4)) / LN;
    default:
      return poolData.readInt32LE(269);
  }
}
/** A `Market` from its account bytes, oracle kind included; kind-1 markets get their PumpSwap Pool resolved (null => unusable). */
export async function marketFromAccount(conn: Connection, key: PublicKey, d: Buffer): Promise<Market> {
  const pk = (o: number) => new PublicKey(d.subarray(o, o + 32));
  const kind = d[MARKET_ORACLE_KIND] ?? 0;
  const [pool, obs] = await conn.getMultipleAccountsInfo([pk(232), pk(136)]);
  const m: Market = { key, bullMint: pk(8), bearMint: pk(40), oraclePool: pk(104), oracleObs: pk(136), windowSecs: d.readUInt32LE(480), underlyingIsToken0: d.readUInt8(489), config: new PublicKey(pool!.data.subarray(72, 104)) };
  if (kind) m.oracleKind = kind;
  if (kind === KIND_PUMPSWAP && obs) m.venuePool = (await pumpSwapPoolOf(conn, m.bullMint, m.oracleObs, m.oraclePool, obs.data)) ?? undefined;
  return m;
}
/** Trailing oracle accounts for poke / settle_begin / redeem: the oracle_pool slot for every kind (kind 0 uses it only when the
 *  ring is dead; kinds 1/2 require it; 3/4 check it), then the PumpSwap Pool for kind 1 (required, read-only). */
export function oracleTail(m: Market) {
  const tail = [r(m.oraclePool)];
  if (m.oracleKind === KIND_PUMPSWAP) {
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

export function sideAccounts(m: Market, side: number) {
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

/** data: tag 0 | window_secs u32 | underlying_is_token0 u8 | [oracle_kind u8 — omitted for kind 0]. Kinds 1/2 append the venue pool (read-only). */
export function createMarketIx(payer: PublicKey, m: Market) {
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

export function pokeIx(m: Market) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [w(m.key), r(m.oracleObs), w(vaultPda(m.key, 0)), w(vaultPda(m.key, 1)), r(TOKEN_PROGRAM_ID), ...oracleTail(m)],
    data: tag(1),
  });
}

export function redeemIx(m: Market, user: PublicKey, side: number, amount: bigint) {
  const a = sideAccounts(m, side);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      // allowOwnerOffCurve: the dnvault redeems with a PDA as the owner
      s(user, false), w(getAssociatedTokenAddressSync(a.mint, user, true, TOKEN_2022_PROGRAM_ID)), w(a.mint),
      w(getAssociatedTokenAddressSync(RFSTACC, user, true)), w(m.key), r(m.oracleObs), w(vaultPda(m.key, 0)),
      w(vaultPda(m.key, 1)), r(a.baseVault), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), w(burnVaultPda()), w(DEV_ATA), ...oracleTail(m),
    ],
    data: tag(2, Buffer.from([side]), u64(amount)),
  });
}

export function settleBeginIx(m: Market, caller: PublicKey, side: number, amount: bigint) {
  const a = sideAccounts(m, side);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      s(caller, false), w(m.key), r(m.oracleObs), w(vaultPda(m.key, 0)), w(vaultPda(m.key, 1)),
      r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), w(a.mint), w(a.escrow), r(a.pool), r(SYSVAR_INSTRUCTIONS_PUBKEY), ...oracleTail(m),
    ],
    data: tag(3, Buffer.from([side]), u64(amount)),
  });
}

export function settleEndIx(m: Market, side: number) {
  const a = sideAccounts(m, side);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [w(m.key), w(a.escrow), r(a.pool), r(vaultPda(m.key, 1 - side)), r(TOKEN_2022_PROGRAM_ID)],
    data: tag(4),
  });
}

export function claimFeesIx(m: Market, side: number) {
  const a = sideAccounts(m, side);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      r(m.key), w(vaultPda(m.key, 0)), w(vaultPda(m.key, 1)), r(TOKEN_PROGRAM_ID), r(TOKEN_2022_PROGRAM_ID), r(DBC),
      r(deriveDbcPoolAuthority()), r(m.config), w(a.pool), w(a.escrow), w(a.baseVault), w(a.quoteVault),
      r(a.mint), r(RFSTACC), r(deriveDbcEventAuthority()), w(burnVaultPda()), w(DEV_ATA),
    ],
    data: tag(5, Buffer.from([side])),
  });
}


/** Creates the global burn pot (idempotent). [payer(s), burn_state(w), burn_vault(w), quote_mint, system, token program] */
export function initBurnIx(payer: PublicKey) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [s(payer), w(burnStatePda()), w(burnVaultPda()), r(RFSTACC), r(SystemProgram.programId), r(TOKEN_PROGRAM_ID)],
    data: tag(6),
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

export type MarketState = {
  lastTwapQ32: bigint;
  keepBullQ63: bigint;
  keepBearQ63: bigint;
  windowSecs: number;
  lastObsTs: number;
  settling: number;
  ckpts: { ts: number; tc: bigint }[];
};
export async function readMarket(conn: Connection, key: PublicKey): Promise<MarketState> {
  const d = (await conn.getAccountInfo(key))!.data;
  const ckpts = [];
  for (let i = 0; i < 32; i++) {
    const o = 496 + i * 16;
    ckpts.push({ ts: d.readUInt32LE(o), tc: d.readBigInt64LE(o + 8) });
  }
  return {
    lastTwapQ32: d.readBigInt64LE(424),
    keepBullQ63: d.readBigUInt64LE(432),
    keepBearQ63: d.readBigUInt64LE(440),
    windowSecs: d.readUInt32LE(480),
    lastObsTs: d.readUInt32LE(484),
    settling: d[490],
    ckpts,
  };
}

export async function tokenBalance(conn: Connection, account: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(account);
  if (!info) return 0n;
  return info.data.readBigUInt64LE(64);
}

export async function send(conn: Connection, tx: Transaction, signers: Keypair[]) {
  tx.feePayer = tx.feePayer ?? signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const res = await conn.confirmTransaction(sig, "confirmed");
  const got = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (res.value.err || got?.meta?.err) {
    console.log((got?.meta?.logMessages ?? []).slice(-25).join("\n"));
    throw new Error(`tx failed: ${JSON.stringify(res.value.err ?? got?.meta?.err)}`);
  }
  return { sig, logs: got?.meta?.logMessages ?? [], cu: got?.meta?.computeUnitsConsumed };
}
