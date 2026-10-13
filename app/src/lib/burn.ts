// The $100X burn pot: balance, venue (bonding curve or canonical PumpSwap), live quote, and the burn tx.
import { Buffer } from "buffer";
import { PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { MEME_MINT, RFSTACC } from "../config";
import { conn } from "./chain";
import { PUMP, PUMPSWAP, burnMemeIx, burnStatePda, burnVaultPda, memeVenue, cu } from "./hooked";
import { STAKE_POOL, poolState } from "./zap";

export type BurnPot = {
  pot: bigint; // r-fstacc raw in the pot
  totalBurned: bigint; // raw $100X burned so far
  totalPaid: bigint;
  lastTs: number;
  cooldownLeft: number;
  venue: "curve" | "pumpswap";
  decimals: number;
  memeProgram: PublicKey;
  /** r-fstacc paid for n raw tokens (what the program will pay) */
  quote: (n: bigint) => bigint;
  /** largest n that fits under the 5% cap */
  maxTokens: bigint;
  poolBaseAta: PublicKey;
  poolQuoteAta: PublicKey;
  priceSol: number; // SOL per whole token at the venue
};

export async function loadBurnPot(): Promise<BurnPot | null> {
  const v = memeVenue(MEME_MINT);
  const [vault, state, mint, bc, pool, sp] = await conn.getMultipleAccountsInfo([burnVaultPda(), burnStatePda(), MEME_MINT, v.bondingCurve, v.pool, STAKE_POOL]);
  if (!vault || !state || !mint || !bc || !sp) return null;
  const pot = Buffer.from(vault.data).readBigUInt64LE(64);
  const sd = Buffer.from(state.data);
  const lastTs = Number(sd.readBigInt64LE(16));
  const decimals = mint.data[44];
  const total = Buffer.from(sp.data).readBigUInt64LE(258);
  const supply = Buffer.from(sp.data).readBigUInt64LE(266);
  const toLst = (lamports: bigint) => (((lamports * 10_300n) / 10_000n) * supply) / total;
  let quote: (n: bigint) => bigint;
  let venue: BurnPot["venue"] = "curve";
  let poolBaseAta = v.pool;
  let poolQuoteAta = v.pool;
  let priceSol: number;
  const bcd = Buffer.from(bc.data);
  if (bcd[48] === 0) {
    const vt = bcd.readBigUInt64LE(8);
    const vs = bcd.readBigUInt64LE(16);
    quote = (n) => toLst((((vs * n) / (vt + n)) * 9_900n) / 10_000n);
    priceSol = (Number(vs) / 1e9) / (Number(vt) / 10 ** decimals);
  } else {
    if (!pool) return null;
    venue = "pumpswap";
    poolBaseAta = new PublicKey(pool.data.subarray(139, 171));
    poolQuoteAta = new PublicKey(pool.data.subarray(171, 203));
    const [b, q] = await conn.getMultipleAccountsInfo([poolBaseAta, poolQuoteAta]);
    const bb = Buffer.from(b!.data).readBigUInt64LE(64);
    const qb = Buffer.from(q!.data).readBigUInt64LE(64);
    quote = (n) => toLst((((qb * n) / (bb + n)) * 9_970n) / 10_000n);
    priceSol = (Number(qb) / 1e9) / (Number(bb) / 10 ** decimals);
  }
  const cap = (pot * 500n) / 10_000n;
  // binary search the largest n whose quote fits the cap
  let lo = 0n;
  let hi = 10n ** 18n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (quote(mid) <= cap) lo = mid;
    else hi = mid;
  }
  return {
    pot, totalBurned: sd.readBigUInt64LE(24), totalPaid: sd.readBigUInt64LE(32), lastTs,
    cooldownLeft: Math.max(0, 60 - (Math.floor(Date.now() / 1000) - lastTs)),
    venue, decimals, memeProgram: mint.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    quote, maxTokens: lo, poolBaseAta, poolQuoteAta, priceSol,
  };
}

export async function memeBalance(owner: PublicKey, p: BurnPot): Promise<bigint> {
  const info = await conn.getAccountInfo(getAssociatedTokenAddressSync(MEME_MINT, owner, false, p.memeProgram));
  return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
}

/** burn `n` $100X from `caller`, receive r-fstacc from the pot, then turn it into SOL. */
export async function buildBurnTx(caller: PublicKey, p: BurnPot, n: bigint) {
  const quoteAta = getAssociatedTokenAddressSync(RFSTACC, caller);
  const memeAta = getAssociatedTokenAddressSync(MEME_MINT, caller, false, p.memeProgram);
  const pool = await poolState();
  const { withdrawSolIx } = await import("./zap");
  const paid = p.quote(n);
  return new Transaction().add(
    cu(250_000),
    createAssociatedTokenAccountIdempotentInstruction(caller, quoteAta, caller, RFSTACC),
    burnMemeIx(caller, MEME_MINT, p.memeProgram, memeAta, p.poolBaseAta, p.poolQuoteAta, n),
    withdrawSolIx(pool, caller, quoteAta, paid),
  );
}

export { PUMP, PUMPSWAP };
