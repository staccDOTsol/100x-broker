// Orca launch, built and signed entirely in the browser. A fresh Token-2022 coin (metadata on the mint, fixed supply, no
// freeze or mint authority left) poured single-sided into Orca Whirlpools in the configs 12Nqk2 controls, each position
// running from the launch price to 10,000x it. Every pool pairs the coin with one quote: $100XBRO always, plus whatever good
// quotes the launcher picks, each opened at the same launch price converted through that quote's USD price. One approval
// signs everything (the mint transaction, then one transaction per pool); the page sends and resends them all.
//
// Instructions are hand-encoded from @orca-so/whirlpools-client 7.0.0 (its codecs want @solana/kit ^5; the app runs 7.1).
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, AuthorityType, ExtensionType, LENGTH_SIZE, TOKEN_2022_PROGRAM_ID, TYPE_SIZE,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMetadataPointerInstruction, createInitializeMintInstruction,
  createMintToInstruction, createSetAuthorityInstruction, getAssociatedTokenAddressSync, getMintLen,
} from "@solana/spl-token";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";
import { Buffer } from "buffer";

export const WHIRLPOOL = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const METADATA_UPDATE_AUTH = new PublicKey("3axbTs2z5GBy6usVbNVoqEgZMng3vZvMnAoX29BFfwhr");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const RENT = new PublicKey("SysvarRent111111111111111111111111111111111");
export const RANGE = 10_000;
export const COIN_DECIMALS = 6;
const TICK_ARRAY_SIZE = 88;
const MIN_TICK = -443636;
const MAX_TICK = 443636;
const LN_TICK = Math.log(1.0001);
const Q64 = 2n ** 64n;

/** A fee tier in one of our configs that a pool can be opened against. */
export type Slot = { config: string; tier: string; kind: "fixed" | "adaptive"; index: number; tickSpacing: number; fee: number };
/** A quote asset: the coin is priced in it at launch through `usd`. */
export type Quote = { mint: string; symbol: string; decimals: number; program: string; usd: number };
export type PoolPlan = { slot: Slot; quote: Quote; amount: bigint };

const DISC = {
  initializePoolV2: [207, 45, 87, 242, 27, 63, 204, 67],
  initializePoolWithAdaptiveFee: [143, 94, 96, 76, 172, 124, 119, 199],
  initializeDynamicTickArray: [41, 33, 165, 200, 120, 231, 142, 50],
  openPositionWithTokenExtensions: [212, 47, 95, 92, 114, 102, 131, 250],
  increaseLiquidityV2: [133, 29, 89, 223, 69, 238, 176, 10],
};
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u128 = (n: bigint) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(n & (Q64 - 1n)); b.writeBigUInt64LE(n >> 64n, 8); return b; };
const meta = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({ pubkey, isWritable, isSigner });
const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, WHIRLPOOL)[0];

const whirlpoolPda = (config: PublicKey, a: PublicKey, b: PublicKey, index: number) => pda([Buffer.from("whirlpool"), config.toBuffer(), a.toBuffer(), b.toBuffer(), u16(index)]);
const badgePda = (config: PublicKey, mint: PublicKey) => pda([Buffer.from("token_badge"), config.toBuffer(), mint.toBuffer()]);
const tickArrayPda = (pool: PublicKey, start: number) => pda([Buffer.from("tick_array"), pool.toBuffer(), Buffer.from(`${start}`)]);
const positionPda = (positionMint: PublicKey) => pda([Buffer.from("position"), positionMint.toBuffer()]);
const oraclePda = (pool: PublicKey) => pda([Buffer.from("oracle"), pool.toBuffer()]);
const arrayStart = (tick: number, spacing: number) => Math.floor(tick / (TICK_ARRAY_SIZE * spacing)) * TICK_ARRAY_SIZE * spacing;
/** sqrt(1.0001^tick) in Q64.64, carried as a 53-bit mantissa so tiny prices keep full precision. A double is ~1e-15 off the
 *  program's exact value; every use below keeps a margin far wider than that. */
function sqrtX64(tick: number) {
  const x = Math.exp((tick * LN_TICK) / 2);
  const shift = 52 - Math.floor(Math.log2(x));
  const m = BigInt(Math.round(x * 2 ** shift));
  const s = 64 - shift;
  return s >= 0 ? m << BigInt(s) : m >> BigInt(-s);
}
const rangeTicks = (spacing: number) => Math.ceil(Math.log(RANGE) / LN_TICK / spacing) * spacing;

/** Where one pool's position sits. The coin is token A or B depending on how the two mints sort; either way the pool opens
 *  just outside the position on the cheap side, so the position holds only the coin and every buy walks it up. */
export function poolShape(coin: PublicKey, quote: Quote, coinPriceInQuote: number, spacing: number) {
  const q = new PublicKey(quote.mint);
  const coinIsA = Buffer.compare(coin.toBuffer(), q.toBuffer()) < 0;
  const span = rangeTicks(spacing);
  // whirlpool price is B per A in raw units
  const raw = coinIsA ? coinPriceInQuote * 10 ** (quote.decimals - COIN_DECIMALS) : (1 / coinPriceInQuote) * 10 ** (COIN_DECIMALS - quote.decimals);
  const tick0 = Math.floor(Math.log(raw) / LN_TICK);
  let lower: number, upper: number, initialSqrt: bigint;
  if (coinIsA) {
    lower = Math.ceil(tick0 / spacing) * spacing; // the first coin sells at or above the launch price
    upper = lower + span;
    initialSqrt = (sqrtX64(lower) * 999_999_999n) / 1_000_000_000n; // a hair under the lower tick: out of range, all coin
  } else {
    upper = Math.floor(tick0 / spacing) * spacing;
    lower = upper - span;
    initialSqrt = (sqrtX64(upper) * 1_000_000_001n) / 1_000_000_000n + 1n; // a hair over the upper tick: all coin
  }
  if (lower < MIN_TICK || upper > MAX_TICK) throw new Error(`launch price is out of Orca's range against ${quote.symbol}`);
  return { coinIsA, mintA: coinIsA ? coin : q, mintB: coinIsA ? q : coin, lower, upper, initialSqrt };
}

/** Liquidity that deposits at most `amount` of the coin into [lower, upper], with a 1e-6 margin for the float sqrt. */
function liquidityFor(amount: bigint, lower: number, upper: number, coinIsA: boolean) {
  const sl = sqrtX64(lower), su = sqrtX64(upper);
  const liq = coinIsA ? (amount * sl * su) / ((su - sl) * Q64) : (amount * Q64) / (su - sl);
  return (liq * 999_999n) / 1_000_000n;
}

/** The coin: Token-2022 with its metadata on the mint, the whole supply minted to the launcher, mint authority dropped. */
export async function coinMintIxs(p: { owner: PublicKey; mint: PublicKey; name: string; symbol: string; uri: string; supply: bigint; rent: (bytes: number) => Promise<number> }) {
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const metaLen = TYPE_SIZE + LENGTH_SIZE + pack({ mint: p.mint, name: p.name, symbol: p.symbol, uri: p.uri, additionalMetadata: [] }).length;
  const ata = getAssociatedTokenAddressSync(p.mint, p.owner, false, TOKEN_2022_PROGRAM_ID);
  return [
    SystemProgram.createAccount({ fromPubkey: p.owner, newAccountPubkey: p.mint, space: mintLen, lamports: await p.rent(mintLen + metaLen), programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(p.mint, p.owner, p.mint, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(p.mint, COIN_DECIMALS, p.owner, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, metadata: p.mint, updateAuthority: p.owner, mint: p.mint, mintAuthority: p.owner, name: p.name, symbol: p.symbol, uri: p.uri }),
    createAssociatedTokenAccountIdempotentInstruction(p.owner, ata, p.owner, p.mint, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(p.mint, ata, p.owner, p.supply, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(p.mint, p.owner, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
  ];
}

/** One pool: open it, its tick arrays, the position, and the coin deposit. Returns the keypairs that must co-sign. */
export function poolIxs(p: { owner: PublicKey; coin: PublicKey; plan: PoolPlan; coinPriceInQuote: number }) {
  const { slot, quote, amount } = p.plan;
  const config = new PublicKey(slot.config);
  const tier = new PublicKey(slot.tier);
  const quoteMint = new PublicKey(quote.mint);
  const quoteProgram = new PublicKey(quote.program);
  const s = poolShape(p.coin, quote, p.coinPriceInQuote, slot.tickSpacing);
  const progA = s.coinIsA ? TOKEN_2022_PROGRAM_ID : quoteProgram;
  const progB = s.coinIsA ? quoteProgram : TOKEN_2022_PROGRAM_ID;
  const pool = whirlpoolPda(config, s.mintA, s.mintB, slot.index);
  const vaultA = Keypair.generate(), vaultB = Keypair.generate(), positionMint = Keypair.generate();
  const position = positionPda(positionMint.publicKey);
  const positionAta = getAssociatedTokenAddressSync(positionMint.publicKey, p.owner, false, TOKEN_2022_PROGRAM_ID);
  const ownerA = getAssociatedTokenAddressSync(s.mintA, p.owner, false, progA);
  const ownerB = getAssociatedTokenAddressSync(s.mintB, p.owner, false, progB);
  const lowerStart = arrayStart(s.lower, slot.tickSpacing), upperStart = arrayStart(s.upper, slot.tickSpacing);
  const taLower = tickArrayPda(pool, lowerStart), taUpper = tickArrayPda(pool, upperStart);
  const W = WHIRLPOOL;

  const init = slot.kind === "fixed"
    ? new TransactionInstruction({ programId: W, keys: [
        meta(config, false), meta(s.mintA, false), meta(s.mintB, false), meta(badgePda(config, s.mintA), false), meta(badgePda(config, s.mintB), false),
        meta(p.owner, true, true), meta(pool, true), meta(vaultA.publicKey, true, true), meta(vaultB.publicKey, true, true), meta(tier, false),
        meta(progA, false), meta(progB, false), meta(SystemProgram.programId, false), meta(RENT, false),
      ], data: Buffer.concat([Buffer.from(DISC.initializePoolV2), u16(slot.tickSpacing), u128(s.initialSqrt)]) })
    : new TransactionInstruction({ programId: W, keys: [
        meta(config, false), meta(s.mintA, false), meta(s.mintB, false), meta(badgePda(config, s.mintA), false), meta(badgePda(config, s.mintB), false),
        // permissionless tier: the funder stands in as the pool-init authority
        meta(p.owner, true, true), meta(p.owner, false, true), meta(pool, true), meta(oraclePda(pool), true),
        meta(vaultA.publicKey, true, true), meta(vaultB.publicKey, true, true), meta(tier, false),
        meta(progA, false), meta(progB, false), meta(SystemProgram.programId, false), meta(RENT, false),
      ], data: Buffer.concat([Buffer.from(DISC.initializePoolWithAdaptiveFee), u128(s.initialSqrt), Buffer.from([0])]) });

  const arrays = [...new Set([lowerStart, upperStart])].map((start) => new TransactionInstruction({ programId: W, keys: [
    meta(pool, false), meta(p.owner, true, true), meta(tickArrayPda(pool, start), true), meta(SystemProgram.programId, false),
  ], data: Buffer.concat([Buffer.from(DISC.initializeDynamicTickArray), i32(start), Buffer.from([1])]) }));

  const open = new TransactionInstruction({ programId: W, keys: [
    meta(p.owner, true, true), meta(p.owner, false), meta(position, true), meta(positionMint.publicKey, true, true), meta(positionAta, true),
    meta(pool, false), meta(TOKEN_2022_PROGRAM_ID, false), meta(SystemProgram.programId, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false), meta(METADATA_UPDATE_AUTH, false),
  ], data: Buffer.concat([Buffer.from(DISC.openPositionWithTokenExtensions), i32(s.lower), i32(s.upper), Buffer.from([0])]) });

  const liq = liquidityFor(amount, s.lower, s.upper, s.coinIsA);
  const deposit = new TransactionInstruction({ programId: W, keys: [
    meta(pool, true), meta(progA, false), meta(progB, false), meta(MEMO, false), meta(p.owner, false, true), meta(position, true), meta(positionAta, false),
    meta(s.mintA, false), meta(s.mintB, false), meta(ownerA, true), meta(ownerB, true), meta(vaultA.publicKey, true), meta(vaultB.publicKey, true),
    meta(taLower, true), meta(taUpper, true),
  ], data: Buffer.concat([Buffer.from(DISC.increaseLiquidityV2), u128(liq), u64(s.coinIsA ? amount : 0n), u64(s.coinIsA ? 0n : amount), Buffer.from([0])]) });

  // the quote side moves nothing, but the program still wants the launcher's quote account to exist
  const quoteAta = s.coinIsA ? ownerB : ownerA;
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(p.owner, quoteAta, p.owner, quoteMint, quoteProgram), init, ...arrays, open, deposit];
  return { ixs, signers: [vaultA, vaultB, positionMint], pool, position, shape: s };
}

/** Pools to open: spread the slots over the quotes ($100XBRO first, then the rest round-robin) and split the supply evenly. */
export function planPools(slots: Slot[], quotes: Quote[], count: number, supply: bigint): PoolPlan[] {
  const pairs: { slot: Slot; quote: Quote }[] = [];
  // each (config, tier index) holds one pool per mint pair, so every quote can use every slot
  for (let round = 0; pairs.length < count && round < slots.length; round++) {
    for (const quote of quotes) {
      if (pairs.length >= count) break;
      pairs.push({ slot: slots[round], quote });
    }
  }
  const each = supply / BigInt(pairs.length || 1);
  return pairs.map((x) => ({ ...x, amount: each }));
}

/** A signed-ready v0 transaction for a set of instructions, with the extra keypairs already signed in. */
export function v0(owner: PublicKey, ixs: TransactionInstruction[], blockhash: string, alts: AddressLookupTableAccount[], cu: number, signers: Keypair[]) {
  const msg = new TransactionMessage({
    payerKey: owner, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ...ixs],
  }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  if (signers.length) tx.sign(signers);
  return tx;
}
