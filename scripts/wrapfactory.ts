// Wrap factory: every 100x.broker UP/DOWN coin (Token-2022 + the hooked transfer hook) gets
//   1. a plain SPL twin through SPL Token Wrap at 3cwC… (immutable, upstream token-wrap; 1:1 escrow),
//   2. optionally a Metaplex name so wallets/routers show the ticker,
//   3. two Orca whirlpools on config 12yTE… (wrapped coin vs Fr28 and vs r-freestacc) in a dedicated adaptive
//      fee tier whose delegated fee authority is the factory key, so pool fees can be retuned without 12Nq.
// The hook only rebalances its market on every transfer, so coins parked in the wrap escrow change nothing.
//
// Env: RPC, FACTORY_KEY (file path or JSON byte array, default ~/hooked.json), FEE_AUTHORITY_KEY (file, default ~/.config/solana/id.json;
//      only `tier` needs it), DRY_RUN=1 (simulate only).
// Usage: bun wrapfactory.ts status | wrap | names | tier | pools | fee <pool|all> <percent>
//        bun wrapfactory.ts seed [fraction=0.5] [symbol|mint]   wrap that share of the inventory, post it as asks
//        bun wrapfactory.ts recycle [--loop]      r-freestacc (10% dev cut) -> bids under the seeded coins; harvest LP fees
//        bun wrapfactory.ts reclaim               close the factory's empty token accounts for their rent
import fs from "node:fs";
import os from "node:os";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, addExtraAccountMetasForExecute, createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync, getMint, getTransferHook,
} from "@solana/spl-token";
import {
  AccountRole, address, appendTransactionMessageInstructions, createKeyPairSignerFromBytes, createNoopSigner,
  createTransactionMessage, getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
  type Address, type Instruction, type KeyPairSigner,
} from "@solana/kit";
import { harvestPositionInstructions, increaseLiquidityInstructions, openPositionInstructionsWithTickBounds } from "@orca-so/whirlpools";
import {
  WHIRLPOOL_PROGRAM_ADDRESS, WhirlpoolDeployment, fetchMaybeAdaptiveFeeTier, fetchWhirlpool, getFeeTierAddress, getInitializeAdaptiveFeeTierInstruction,
  getInitializePoolWithAdaptiveFeeInstruction, getOracleAddress, getSetFeeRateByDelegatedFeeAuthorityInstruction,
  getTokenBadgeAddress, getWhirlpoolAddress,
} from "@orca-so/whirlpools-client";
import { getInitializableTickIndex, priceToSqrtPrice, priceToTickIndex } from "@orca-so/whirlpools-core";
import { createSolanaRpc } from "@solana/kit";
import { PROGRAM_ID } from "./lib";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const DRY = process.env.DRY_RUN === "1";
const conn = new Connection(RPC, "confirmed");
const rpc = createSolanaRpc(RPC);
/** A key given inline as a JSON byte array (how Fly secrets carry it), or a path to a solana-keygen file. */
const loadKey = (src: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(src.trim().startsWith("[") ? src : fs.readFileSync(src.replace(/^~/, os.homedir()), "utf8"))));
const factory = loadKey(process.env.FACTORY_KEY ?? "~/hooked.json");

// ---- constants --------------------------------------------------------------------------------------------------
const WRAP = new PublicKey("3cwCHXKjSXcfcBRBveKY7Jn6qrF6wPGPt4LQYDcZHQ6w");
const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const RFSTACC = new PublicKey("pSYRpDqr847kB2nD5ZhjcPsHLV2ZpUxweXm1MwiSTcc"); // 9 dp, the markets' quote
const FR28 = new PublicKey("Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump"); // 6 dp, the burn pot's meme
const STAKE_POOL = new PublicKey("SzoSoRxsrL9sbFcwpbjbH5bRrzuvFtuytZTeuqZCfQ6");
const CONFIG = address("12yTE48QR6bGK4EMcyY8XsARbX1TRTEbwHYSuuxR1Hp8"); // 12Nq holds all three authorities, 25% protocol fee
const deployment = WhirlpoolDeployment.custom(WHIRLPOOL_PROGRAM_ADDRESS, CONFIG);
// The factory's own adaptive tier: 1% base fee, adaptive part rides up to the 10% hard cap on big tick moves (same
// constants as the live tier 1032), permissionless pool init (the service needs it), fees retunable per pool by
// the factory key through the delegated fee authority.
const TIER = {
  feeTierIndex: 3128,
  tickSpacing: 128,
  defaultBaseFeeRate: 10_000,
  filterPeriod: 30,
  decayPeriod: 600,
  reductionFactor: 5_000,
  adaptiveFeeControlFactor: 20_000,
  maxVolatilityAccumulator: 100_000,
  tickGroupSize: 128,
  majorSwapThresholdTicks: 128,
};
const QUOTES = [
  { key: "fr28", mint: FR28, decimals: 6 },
  { key: "rfstacc", mint: RFSTACC, decimals: 9 },
] as const;
const COIN_DECIMALS = 6;
const METADATA_COST = 13_733_800; // Metaplex CreateMetadataAccountV3 via the wrap authority PDA (measured on mainnet)

// ---- discovery ----------------------------------------------------------------------------------------------------
type Coin = { market: PublicKey; side: "UP" | "DOWN"; mint: PublicKey; dbcPool: PublicKey; symbol: string };

async function discover(): Promise<Coin[]> {
  const markets = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58("hookmkt1") } }],
  });
  const coins: Coin[] = [];
  for (const { pubkey, account } of markets) {
    const d = account.data;
    const at = (o: number) => new PublicKey(d.subarray(o, o + 32));
    coins.push({ market: pubkey, side: "UP", mint: at(8), dbcPool: at(232), symbol: "" });
    coins.push({ market: pubkey, side: "DOWN", mint: at(40), dbcPool: at(264), symbol: "" });
  }
  const infos = await conn.getMultipleParsedAccounts(coins.map((c) => c.mint));
  infos.value.forEach((v, i) => {
    const ext = (v?.data as any)?.parsed?.info?.extensions ?? [];
    const c = coins[i]!;
    c.symbol = ext.find((e: any) => e.extension === "tokenMetadata")?.state?.symbol ?? c.mint.toBase58().slice(0, 6);
  });
  return coins.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function bs58(s: string) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + Buffer.from(s).toString("hex"));
  let out = "";
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  return out;
}

// ---- wrap PDAs (SPL Token Wrap, Token-2022 -> SPL) -----------------------------------------------------------------
const pda = (seeds: Buffer[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
function wrapOf(unwrapped: PublicKey) {
  const wrapped = pda([Buffer.from("mint"), unwrapped.toBuffer(), TOKEN_PROGRAM_ID.toBuffer()], WRAP);
  const authority = pda([Buffer.from("authority"), wrapped.toBuffer()], WRAP);
  return {
    wrapped,
    backpointer: pda([Buffer.from("backpointer"), wrapped.toBuffer()], WRAP),
    authority,
    escrow: getAssociatedTokenAddressSync(unwrapped, authority, true, TOKEN_2022_PROGRAM_ID),
    metadata: pda([Buffer.from("metadata"), METAPLEX.toBuffer(), wrapped.toBuffer()], METAPLEX),
  };
}

async function createMintIxs(unwrapped: PublicKey): Promise<TransactionInstruction[]> {
  const w = wrapOf(unwrapped);
  const [mintAcc, backAcc] = await conn.getMultipleAccountsInfo([w.wrapped, w.backpointer]);
  const need = async (have: number, size: number) => Math.max(0, (await conn.getMinimumBalanceForRentExemption(size)) - have);
  const ixs: TransactionInstruction[] = [];
  const mintGap = await need(mintAcc?.lamports ?? 0, 82);
  const backGap = await need(backAcc?.lamports ?? 0, 32);
  if (mintGap) ixs.push(SystemProgram.transfer({ fromPubkey: factory.publicKey, toPubkey: w.wrapped, lamports: mintGap }));
  if (backGap) ixs.push(SystemProgram.transfer({ fromPubkey: factory.publicKey, toPubkey: w.backpointer, lamports: backGap }));
  ixs.push(
    new TransactionInstruction({
      programId: WRAP,
      data: Buffer.from([0, 1]), // CreateMint { idempotent }
      keys: [
        { pubkey: w.wrapped, isSigner: false, isWritable: true },
        { pubkey: w.backpointer, isSigner: false, isWritable: true },
        { pubkey: unwrapped, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
    }),
    createAssociatedTokenAccountIdempotentInstruction(factory.publicKey, w.escrow, w.authority, unwrapped, TOKEN_2022_PROGRAM_ID),
  );
  return ixs;
}

async function metadataIxs(unwrapped: PublicKey): Promise<TransactionInstruction[]> {
  const w = wrapOf(unwrapped);
  const have = (await conn.getAccountInfo(w.authority))?.lamports ?? 0;
  const ixs: TransactionInstruction[] = [];
  if (have < METADATA_COST) {
    ixs.push(SystemProgram.transfer({ fromPubkey: factory.publicKey, toPubkey: w.authority, lamports: METADATA_COST - have }));
  }
  ixs.push(new TransactionInstruction({
    programId: WRAP,
    data: Buffer.from([5]), // SyncMetadataToSplToken (hooked coins point their metadata at themselves)
    keys: [
      { pubkey: w.metadata, isSigner: false, isWritable: true },
      { pubkey: w.authority, isSigner: false, isWritable: true },
      { pubkey: w.wrapped, isSigner: false, isWritable: false },
      { pubkey: unwrapped, isSigner: false, isWritable: false },
      { pubkey: METAPLEX, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
  }));
  return ixs;
}

// ---- prices -------------------------------------------------------------------------------------------------------
/** Human price of one coin in r-freestacc, from its DBC curve's sqrt price (Q64.64 at offset 280). */
async function coinInRf(dbcPool: PublicKey): Promise<number> {
  const d = (await conn.getAccountInfo(dbcPool))!.data;
  const sqrt = Number(d.readBigUInt64LE(280) + (d.readBigUInt64LE(288) << 64n)) / 2 ** 64;
  return sqrt * sqrt * 10 ** (COIN_DECIMALS - 9);
}
/** SOL per r-freestacc from the stake pool (total_lamports / pool_token_supply). */
async function rfInSol(): Promise<number> {
  const d = (await conn.getAccountInfo(STAKE_POOL))!.data;
  return Number(d.readBigUInt64LE(258)) / Number(d.readBigUInt64LE(266));
}
async function fr28InSol(): Promise<number> {
  const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${FR28},So11111111111111111111111111111111111111112`);
  const j = (await r.json()) as Record<string, { usdPrice: number }>;
  return j[FR28.toBase58()]!.usdPrice / j["So11111111111111111111111111111111111111112"]!.usdPrice;
}

// ---- orca ---------------------------------------------------------------------------------------------------------
const order = (a: PublicKey, b: PublicKey): [PublicKey, PublicKey] => (Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a]);
async function poolAddress(coinWrapped: PublicKey, quote: PublicKey) {
  const [a, b] = order(coinWrapped, quote);
  return (await getWhirlpoolAddress(address(a.toBase58()), address(b.toBase58()), TIER.feeTierIndex, deployment))[0];
}
const tierAddress = async () => (await getFeeTierAddress(TIER.feeTierIndex, deployment))[0];

async function initPoolIxs(coinWrapped: PublicKey, quote: (typeof QUOTES)[number], coinInQuote: number) {
  const [a, b] = order(coinWrapped, quote.mint);
  const coinIsA = a.equals(coinWrapped);
  const decA = coinIsA ? COIN_DECIMALS : quote.decimals;
  const decB = coinIsA ? quote.decimals : COIN_DECIMALS;
  const price = coinIsA ? coinInQuote : 1 / coinInQuote; // Orca price = B per A
  const whirlpool = await poolAddress(coinWrapped, quote.mint);
  const vaultA = Keypair.generate(), vaultB = Keypair.generate();
  const programOf = async (m: PublicKey) => (await conn.getAccountInfo(m))!.owner;
  const ix = getInitializePoolWithAdaptiveFeeInstruction({
    whirlpoolsConfig: CONFIG,
    tokenMintA: address(a.toBase58()),
    tokenMintB: address(b.toBase58()),
    tokenBadgeA: (await getTokenBadgeAddress(address(a.toBase58()), deployment))[0],
    tokenBadgeB: (await getTokenBadgeAddress(address(b.toBase58()), deployment))[0],
    funder: createNoopSigner(address(factory.publicKey.toBase58())),
    initializePoolAuthority: createNoopSigner(address(factory.publicKey.toBase58())),
    whirlpool,
    oracle: (await getOracleAddress(whirlpool))[0],
    tokenVaultA: createNoopSigner(address(vaultA.publicKey.toBase58())),
    tokenVaultB: createNoopSigner(address(vaultB.publicKey.toBase58())),
    adaptiveFeeTier: await tierAddress(),
    tokenProgramA: address((await programOf(a)).toBase58()),
    tokenProgramB: address((await programOf(b)).toBase58()),
    initialSqrtPrice: priceToSqrtPrice(price, decA, decB),
    tradeEnableTimestamp: null,
  });
  return { ixs: [toWeb3(ix)], signers: [vaultA, vaultB], whirlpool };
}

function toWeb3(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    data: Buffer.from(ix.data ?? []),
    keys: (ix.accounts ?? []).map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.role >= 2, isWritable: (a.role & 1) === 1 })),
  });
}

// ---- send ---------------------------------------------------------------------------------------------------------
async function send(label: string, ixs: TransactionInstruction[], signers: Keypair[] = []) {
  const build = async (units: number) => {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: factory.publicKey, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), ...ixs],
    }).compileToV0Message());
    tx.sign([factory, ...signers]);
    return tx;
  };
  const sim = await conn.simulateTransaction(await build(1_400_000), { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    throw new Error(`${label}: simulation failed ${JSON.stringify(sim.value.err)}\n  ${(sim.value.logs ?? []).slice(-6).join("\n  ")}`);
  }
  if (DRY) return console.log(`[dry-run] ${label}: ok (${sim.value.unitsConsumed} CU)`);
  const tx = await build(Math.ceil((sim.value.unitsConsumed ?? 200_000) * 1.2) + 10_000);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
  const res = await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash("confirmed")) }, "confirmed");
  if (res.value.err) throw new Error(`${label}: ${sig} failed ${JSON.stringify(res.value.err)}`);
  console.log(`${label}: ${sig}`);
}


// ---- liquidity ----------------------------------------------------------------------------------------------------
// One wide single-sided position per (pool, side), tracked so later deposits top it up instead of paying rent again.
// Asks hold only the wrapped coin and start at the higher of the pool price and the curve price; bids hold only the
// quote and start at the lower of the two, so neither side ever quotes better than the curve.
const RANGE_TICKS = 69_120; // ~1000x either way, 540 * tick spacing
const STATE_FILE = new URL("./wrapfactory-state.json", import.meta.url);
type State = { positions: Record<string, { ask?: string; bid?: string }> };
const loadState = (): State => (fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : { positions: {} });
const saveState = (s: State) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
let _kitSigner: KeyPairSigner | undefined;
const kitSigner = async () => (_kitSigner ??= await createKeyPairSignerFromBytes(factory.secretKey));

function fromWeb3(ix: TransactionInstruction): Instruction {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => ({
      address: address(k.pubkey.toBase58()),
      role: k.isSigner ? (k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY,
    })),
    data: new Uint8Array(ix.data),
  };
}

/** Kit send path for Orca's high-level builders (their new position mints are kit signers). */
async function sendKit(label: string, ixs: Instruction[]) {
  const me = await kitSigner();
  const build = async (units: number) => {
    const { value: bh } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(me, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions([
        fromWeb3(ComputeBudgetProgram.setComputeUnitLimit({ units })),
        fromWeb3(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })),
        ...ixs,
      ], m),
    );
    return signTransactionMessageWithSigners(msg);
  };
  const probe = await build(1_400_000);
  const sim = await rpc.simulateTransaction(getBase64EncodedWireTransaction(probe), { encoding: "base64", replaceRecentBlockhash: true, sigVerify: false }).send();
  if (sim.value.err) {
    throw new Error(`${label}: simulation failed ${JSON.stringify(sim.value.err, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n  ${(sim.value.logs ?? []).slice(-6).join("\n  ")}`);
  }
  if (DRY) return console.log(`[dry-run] ${label}: ok (${sim.value.unitsConsumed} CU)`);
  const tx = await build(Math.ceil(Number(sim.value.unitsConsumed ?? 200_000n) * 1.2) + 10_000);
  const sig = getSignatureFromTransaction(tx);
  const wire = getBase64EncodedWireTransaction(tx);
  for (let i = 0; i < 40; i++) {
    if (i % 3 === 0) await rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: true, maxRetries: 0n }).send().catch(() => {});
    await Bun.sleep(1_500);
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st?.err) throw new Error(`${label}: ${sig} failed ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return console.log(`${label}: ${sig}`);
  }
  throw new Error(`${label}: ${sig} not confirmed in time`);
}

const tokenBalance = async (account: PublicKey) => BigInt((await conn.getTokenAccountBalance(account, "confirmed").catch(() => null))?.value.amount ?? "0");

/** Wrap `amount` of the factory's own Token-2022 coin into its SPL twin (the hook's extra accounts appended). */
async function wrapInventoryIxs(coin: PublicKey, amount: bigint) {
  const w = wrapOf(coin);
  const source = getAssociatedTokenAddressSync(coin, factory.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const recipient = getAssociatedTokenAddressSync(w.wrapped, factory.publicKey, false, TOKEN_PROGRAM_ID);
  const mint = await getMint(conn, coin, "confirmed", TOKEN_2022_PROGRAM_ID);
  const probe = createTransferCheckedInstruction(source, coin, w.escrow, factory.publicKey, amount, mint.decimals, [], TOKEN_2022_PROGRAM_ID);
  const hook = getTransferHook(mint);
  if (hook) await addExtraAccountMetasForExecute(conn, probe, hook.programId, source, coin, w.escrow, factory.publicKey, amount, "confirmed");
  const data = Buffer.alloc(9);
  data[0] = 1; // Wrap { amount }
  data.writeBigUInt64LE(amount, 1);
  return [
    createAssociatedTokenAccountIdempotentInstruction(factory.publicKey, recipient, factory.publicKey, w.wrapped, TOKEN_PROGRAM_ID),
    new TransactionInstruction({
      programId: WRAP, data,
      keys: [
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: w.wrapped, isSigner: false, isWritable: true },
        { pubkey: w.authority, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: coin, isSigner: false, isWritable: false },
        { pubkey: w.escrow, isSigner: false, isWritable: true },
        { pubkey: factory.publicKey, isSigner: true, isWritable: false },
        ...probe.keys.slice(4),
      ],
    }),
  ];
}

/**
 * Deposit `amount` of `token` single-sided into `pool` (the wrapped coin + `quote` pair). Tops up the tracked
 * position for that side if there is one, otherwise opens a ~1000x-wide one anchored as described above.
 */
async function depositSingleSided(state: State, pool: Address, coinWrapped: PublicKey, quote: (typeof QUOTES)[number], coinInQuote: number, side: "ask" | "bid", amount: bigint) {
  const [a] = order(coinWrapped, quote.mint);
  const coinIsA = a.equals(coinWrapped);
  const tokenIsA = side === "ask" ? coinIsA : !coinIsA;
  const param = tokenIsA ? { tokenMaxA: amount, tokenMaxB: 0n } : { tokenMaxA: 0n, tokenMaxB: amount };
  const slot = (state.positions[pool] ??= {});
  const label = `${side} ${(Number(amount) / 10 ** (side === "ask" ? COIN_DECIMALS : quote.decimals)).toLocaleString()} into ${pool.slice(0, 6)}… (${quote.key})`;
  const me = await kitSigner();
  if (slot[side]) {
    const { instructions } = await increaseLiquidityInstructions(rpc, address(slot[side]!), param, { authority: me, whirlpoolDeployment: deployment });
    return sendKit(`top up ${label}`, instructions);
  }
  const wp = await fetchWhirlpool(rpc, pool);
  const decA = coinIsA ? COIN_DECIMALS : quote.decimals;
  const decB = coinIsA ? quote.decimals : COIN_DECIMALS;
  const refTick = priceToTickIndex(coinIsA ? coinInQuote : 1 / coinInQuote, decA, decB);
  const cur = wp.data.tickCurrentIndex;
  const [lower, upper] = tokenIsA
    ? (() => { const lo = getInitializableTickIndex(Math.max(refTick, cur + 1), TIER.tickSpacing, true); return [lo, lo + RANGE_TICKS]; })()
    : (() => { const up = getInitializableTickIndex(Math.min(refTick, cur), TIER.tickSpacing, false); return [up - RANGE_TICKS, up]; })();
  const { instructions, positionMint } = await openPositionInstructionsWithTickBounds(rpc, pool, param, lower, upper, {
    funder: me, withTokenMetadataExtension: false, whirlpoolDeployment: deployment,
  });
  await sendKit(`open ${label} ticks ${lower}..${upper}`, instructions);
  if (!DRY) { slot[side] = positionMint; saveState(state); }
}

async function quotePrices(c: Coin) {
  const [rf, fr, inRf] = await Promise.all([rfInSol(), fr28InSol(), coinInRf(c.dbcPool)]);
  return { rfstacc: inRf, fr28: (inRf * rf) / fr } as Record<(typeof QUOTES)[number]["key"], number>;
}

const MIN_SEED_RAW = 1_000n * 10n ** BigInt(COIN_DECIMALS); // skip dust holdings under 1,000 coins

async function seed(coins: Coin[], fraction: number, only?: string) {
  const state = loadState();
  for (const c of coins) {
    if (only && c.symbol !== only && c.mint.toBase58() !== only) continue;
    const held = await tokenBalance(getAssociatedTokenAddressSync(c.mint, factory.publicKey, false, TOKEN_2022_PROGRAM_ID));
    const amount = (held * BigInt(Math.round(fraction * 1e6))) / 1_000_000n;
    if (amount < MIN_SEED_RAW) continue;
    await send(`wrap ${(Number(amount) / 1e6).toLocaleString()} ${c.symbol} from inventory`, await wrapInventoryIxs(c.mint, amount));
    await asks(state, c, DRY ? amount : undefined);
  }
}

/** Split the wrapped coins the factory holds for `c` between its two pools as asks. */
async function asks(state: State, c: Coin, known?: bigint) {
  const w = wrapOf(c.mint);
  const account = getAssociatedTokenAddressSync(w.wrapped, factory.publicKey, false, TOKEN_PROGRAM_ID);
  let held = known ?? 0n;
  for (let i = 0; known === undefined && i < 10 && held === 0n; i++) {
    held = await tokenBalance(account); // a just-confirmed wrap can lag on the node we read from
    if (held === 0n) await Bun.sleep(1_500);
  }
  if (held === 0n) return console.log(`${c.symbol}: no wrapped coins to post`);
  const prices = await quotePrices(c);
  const half = held / 2n;
  for (const [i, q] of QUOTES.entries()) {
    const pool = await poolAddress(w.wrapped, q.mint);
    await depositSingleSided(state, pool, w.wrapped, q, prices[q.key], "ask", i === 0 ? half : held - half);
  }
}

const MIN_RECYCLE_RAW = BigInt(process.env.MIN_RECYCLE_LST ?? "50000000"); // 0.05 r-freestacc
const SOL_FLOOR = Number(process.env.SOL_FLOOR ?? 0.05) * 1e9;

/** One pass: harvest our positions' LP fees, then spread idle r-freestacc as bids under every coin we make asks for. */
async function recycleOnce(coins: Coin[]) {
  const state = loadState();
  for (const [pool, slots] of Object.entries(state.positions)) {
    for (const mint of [slots.ask, slots.bid].filter(Boolean) as string[]) {
      try {
        const { instructions, feesQuote } = await harvestPositionInstructions(rpc, address(mint), { authority: await kitSigner(), whirlpoolDeployment: deployment });
        if (feesQuote.feeOwedA > 0n || feesQuote.feeOwedB > 0n) await sendKit(`harvest ${pool.slice(0, 6)}…`, instructions);
      } catch (e: any) {
        console.warn(`harvest ${mint}: ${e.message}`);
      }
    }
  }
  const rfAta = getAssociatedTokenAddressSync(RFSTACC, factory.publicKey, false, TOKEN_PROGRAM_ID);
  const idle = await tokenBalance(rfAta);
  const sol = await conn.getBalance(factory.publicKey);
  const rfPools = [];
  for (const c of coins) {
    const pool = await poolAddress(wrapOf(c.mint).wrapped, RFSTACC);
    if (state.positions[pool]?.ask) rfPools.push({ c, pool });
  }
  if (idle < MIN_RECYCLE_RAW || !rfPools.length) {
    return console.log(`recycle: ${Number(idle) / 1e9} r-freestacc idle (min ${Number(MIN_RECYCLE_RAW) / 1e9}), ${rfPools.length} pools with asks; nothing to do`);
  }
  if (sol < SOL_FLOOR) return console.log(`recycle: ${sol / 1e9} SOL is under the ${SOL_FLOOR / 1e9} floor; waiting`);
  const each = idle / BigInt(rfPools.length);
  const quote = QUOTES.find((q) => q.key === "rfstacc")!;
  for (const { c, pool } of rfPools) {
    const prices = await quotePrices(c);
    await depositSingleSided(state, pool, wrapOf(c.mint).wrapped, quote, prices.rfstacc, "bid", each);
  }
}


/** Close the factory's empty token accounts for their rent. Never the r-freestacc dev-fee ATA: the program requires it. */
const DEV_ATA = new PublicKey("6Jrrws5TmFTb4eCa63A4yNnaSCC62yvvHYspK3KW4SEd");
async function reclaim() {
  const empty: { pubkey: PublicKey; program: PublicKey }[] = [];
  for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const { value } = await conn.getParsedTokenAccountsByOwner(factory.publicKey, { programId: program });
    for (const a of value) {
      const info = (a.account.data as any).parsed.info;
      if (info.tokenAmount.amount === "0" && info.state !== "frozen" && !a.pubkey.equals(DEV_ATA)) empty.push({ pubkey: a.pubkey, program });
    }
  }
  for (let i = 0; i < empty.length; i += 10) {
    const batch = empty.slice(i, i + 10);
    await send(`close ${batch.length} empty token accounts`, batch.map((e) => createCloseAccountInstruction(e.pubkey, factory.publicKey, factory.publicKey, [], e.program)));
  }
  console.log(`${DRY ? "would close" : "closed"} ${empty.length}; balance ${(await conn.getBalance(factory.publicKey)) / 1e9} SOL`);
}

// ---- commands -----------------------------------------------------------------------------------------------------
async function status(coins: Coin[]) {
  const rows = [];
  for (const c of coins) {
    const w = wrapOf(c.mint);
    const pools = await Promise.all(QUOTES.map(async (q) => poolAddress(w.wrapped, q.mint)));
    const accts = await conn.getMultipleAccountsInfo([w.wrapped, w.metadata, ...pools.map((p) => new PublicKey(p))]);
    const escrow = accts[0] ? (await conn.getTokenAccountBalance(w.escrow).catch(() => null))?.value.uiAmountString ?? "0" : "-";
    rows.push({
      coin: `${c.symbol}`, wrapped: w.wrapped.toBase58(), live: accts[0] ? "yes" : "no", name: accts[1] ? "yes" : "no",
      "pool/fr28": accts[2] ? "yes" : "no", "pool/rf": accts[3] ? "yes" : "no", escrow,
    });
  }
  console.table(rows);
  const tier = await fetchMaybeAdaptiveFeeTier(rpc, await tierAddress());
  console.log(`factory ${factory.publicKey.toBase58()} · ${(await conn.getBalance(factory.publicKey)) / 1e9} SOL · tier ${TIER.feeTierIndex}: ${tier.exists ? "live" : "not created"}`);
}

async function wrapAll(coins: Coin[]) {
  const todo = [];
  for (const c of coins) if (!(await conn.getAccountInfo(wrapOf(c.mint).wrapped))) todo.push(c);
  for (let i = 0; i < todo.length; i += 3) {
    const batch = todo.slice(i, i + 3);
    const ixs = (await Promise.all(batch.map((c) => createMintIxs(c.mint)))).flat();
    await send(`wrap ${batch.map((c) => c.symbol).join(", ")}`, ixs);
  }
  if (!todo.length) console.log("every coin already has its SPL twin");
}

async function namesAll(coins: Coin[], only: string[] = []) {
  for (const c of coins) {
    if (only.length && !only.includes(c.symbol) && !only.includes(c.mint.toBase58())) continue;
    const w = wrapOf(c.mint);
    const [mintAcc, md] = await conn.getMultipleAccountsInfo([w.wrapped, w.metadata]);
    if (!mintAcc || md) continue;
    await send(`name ${c.symbol}`, await metadataIxs(c.mint));
  }
}

async function tier() {
  const at = await tierAddress();
  if ((await fetchMaybeAdaptiveFeeTier(rpc, at)).exists) return console.log(`tier ${TIER.feeTierIndex} already live at ${at}`);
  const feeAuthority = loadKey(process.env.FEE_AUTHORITY_KEY ?? "~/.config/solana/id.json");
  const ix = getInitializeAdaptiveFeeTierInstruction({
    whirlpoolsConfig: CONFIG,
    adaptiveFeeTier: at,
    funder: createNoopSigner(address(factory.publicKey.toBase58())),
    feeAuthority: createNoopSigner(address(feeAuthority.publicKey.toBase58())),
    initializePoolAuthority: address(PublicKey.default.toBase58()),
    delegatedFeeAuthority: address(factory.publicKey.toBase58()),
    ...TIER,
  });
  await send(`create adaptive fee tier ${TIER.feeTierIndex} on 12yTE…`, [toWeb3(ix)], [feeAuthority]);
}

async function poolsAll(coins: Coin[]) {
  const [rf, fr] = await Promise.all([rfInSol(), fr28InSol()]);
  for (const c of coins) {
    const w = wrapOf(c.mint);
    if (!(await conn.getAccountInfo(w.wrapped))) { console.log(`${c.symbol}: not wrapped yet, skipping`); continue; }
    const inRf = await coinInRf(c.dbcPool);
    for (const q of QUOTES) {
      const inQuote = q.key === "rfstacc" ? inRf : (inRf * rf) / fr;
      const whirlpool = await poolAddress(w.wrapped, q.mint);
      if (await conn.getAccountInfo(new PublicKey(whirlpool))) continue;
      const { ixs, signers } = await initPoolIxs(w.wrapped, q, inQuote);
      await send(`pool ${c.symbol}/${q.key} @ ${inQuote.toExponential(4)}`, ixs, signers);
    }
  }
}

async function fee(target: string, percent: number) {
  const feeRate = Math.round(percent * 10_000); // hundredths of a bp
  const coins = await discover();
  const pools = target === "all"
    ? (await Promise.all(coins.flatMap((c) => QUOTES.map((q) => poolAddress(wrapOf(c.mint).wrapped, q.mint)))))
    : [address(target)];
  const tierAt = await tierAddress();
  for (const whirlpool of pools) {
    if (!(await conn.getAccountInfo(new PublicKey(whirlpool)))) continue;
    const ix = getSetFeeRateByDelegatedFeeAuthorityInstruction({
      whirlpool, adaptiveFeeTier: tierAt, delegatedFeeAuthority: createNoopSigner(address(factory.publicKey.toBase58())), feeRate,
    });
    await send(`fee ${whirlpool} -> ${percent}%`, [toWeb3(ix)]);
  }
}

const [cmd, ...args] = process.argv.slice(2);
const coins = cmd === "tier" || cmd === "fee" ? [] : await discover();
switch (cmd) {
  case "status": await status(coins); break;
  case "wrap": await wrapAll(coins); break;
  case "names": await namesAll(coins, args); break;
  case "tier": await tier(); break;
  case "pools": await poolsAll(coins); break;
  case "fee": await fee(args[0] ?? "", Number(args[1])); break;
  case "seed": await seed(coins, Number(args[0] ?? 0.5), args[1]); break;
  case "reclaim": await reclaim(); break;
  case "asks": for (const c of coins) if (!args[0] || c.symbol === args[0] || c.mint.toBase58() === args[0]) await asks(loadState(), c); break;
  case "recycle":
    do {
      try { await recycleOnce(coins); } catch (e: any) { console.error("recycle:", e.message); }
      if (args[0] === "--loop") await Bun.sleep(Number(process.env.LOOP_MS ?? 600_000));
    } while (args[0] === "--loop");
    break;
  default: console.log("usage: bun wrapfactory.ts status | wrap | names | tier | pools | fee <pool|all> <percent> | seed [fraction] | recycle [--loop]");
}
