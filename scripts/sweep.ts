// Dev-fee sweep: the protocol's 10% dev share (r-fstacc in DEV_ATA, SPL-delegated to the keeper) ends up as burned BABY100X.
//   a. DEV_ATA balance >= MIN_SWEEP_LST (or a carry from a failed earlier pass) -> go
//   b. tx A: stake-pool WithdrawSol burns the dev r-fstacc (keeper signs as delegate), SOL lands on the keeper
//   c. PumpPortal buy of $100XBRO with that SOL (minus 0.0005 for fees/rent); the bought amount is the `carry`
//   d. tx B: pump `buy_exact_quote_in_v2` spends the carry on the BABY100X curve (quoted in $100XBRO), then burn all BABY the keeper holds
// `carry` is in-memory: if tx B fails, the next loop retries it instead of leaving the $100XBRO to the burn job's inventory.
// Env: MIN_SWEEP_LST (raw r-fstacc, default 2_000_000), BABY_MINT, MEME_MINT, RPC, KEEPER_KEY, DRY_RUN.
// CLI: `bun sweep.ts once` runs one full pass; `bun sweep.ts baby <raw $100XBRO>` runs step d alone on that much of the keeper's inventory.
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createBurnInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import bs58 from "bs58";
import fs from "fs";
import { DEV_ATA, PUMP, cu, tokenBalance } from "./lib";
import { readPool, withdrawSolIx, type Pool } from "./stakepool";

export const X100 = new PublicKey(process.env.MEME_MINT ?? "Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump");
export const BABY = new PublicKey(process.env.BABY_MINT ?? "CqCnyVWYSUapVhiB2u8kM6kKVYirLegumw84rm4spump");
export const FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const MIN_SWEEP_LST = BigInt(process.env.MIN_SWEEP_LST ?? "2000000"); // min dev r-fstacc (raw) worth one sweep
const BUY_RESERVE_LAMPORTS = 500_000n; // 0.0005 SOL of each withdrawal stays with the keeper (tx fees, ATA rent)
const MIN_OUT_BPS = 9_000n; // min_tokens_out = 90% of the no-fee constant-product estimate (fees are ~1.25%)

type Log = (...a: unknown[]) => void;
export type SweepOpts = { minSweep?: bigint; dry?: boolean };

// ---------- pump program (IDL fetched once) ----------
let pumpProgram: Promise<Program> | null = null;
function pump(conn: Connection, key: Keypair) {
  return (pumpProgram ??= (async () => {
    // read + build only (no provider-signed sends), so a bare wallet shim does; anchor's ESM entry has no NodeWallet export
    const wallet = { publicKey: key.publicKey, signTransaction: async <T>(t: T) => t, signAllTransactions: async <T>(t: T[]) => t } as any;
    const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });
    const idl = await Program.fetchIdl(PUMP, provider);
    if (!idl) throw new Error("pump IDL not found on chain");
    return new Program(idl, provider);
  })());
}

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];
const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
export const bondingCurvePda = (mint: PublicKey) => pda([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP);
// FEE_CONFIG seed: the constant pump's IDL hard-codes for fee_config under the fee program
const FEE_CONFIG_SEED = Uint8Array.from([1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176]);

export type Curve = { virtualTokenReserves: bigint; virtualQuoteReserves: bigint; realTokenReserves: bigint; realQuoteReserves: bigint; creator: PublicKey; complete: boolean; quoteMint: PublicKey };
export async function readCurve(conn: Connection, key: Keypair, mint = BABY): Promise<Curve> {
  const p = await pump(conn, key);
  const c: any = await (p.account as any).bondingCurve.fetch(bondingCurvePda(mint));
  const big = (v: BN) => BigInt(v.toString());
  return { virtualTokenReserves: big(c.virtualTokenReserves), virtualQuoteReserves: big(c.virtualQuoteReserves), realTokenReserves: big(c.realTokenReserves), realQuoteReserves: big(c.realQuoteReserves), creator: c.creator, complete: c.complete, quoteMint: c.quoteMint };
}

/** No-fee constant-product estimate of BABY out for `quoteIn` $100XBRO. */
export const estimateOut = (c: Curve, quoteIn: bigint) => (c.virtualTokenReserves * quoteIn) / (c.virtualQuoteReserves + quoteIn);

/** Instructions for tx B: (create keeper BABY ATA) + buy_exact_quote_in_v2 spending `quoteIn` $100XBRO on the BABY curve. */
export async function buyBabyIxs(conn: Connection, key: Keypair, quoteIn: bigint): Promise<{ ixs: TransactionInstruction[]; minOut: bigint; est: bigint; curve: Curve }> {
  const p = await pump(conn, key);
  const curve = await readCurve(conn, key);
  if (curve.complete) throw new Error("BABY curve is complete (graduated); buy_exact_quote_in_v2 no longer applies");
  if (!curve.quoteMint.equals(X100)) throw new Error(`BABY curve quote mint is ${curve.quoteMint.toBase58()}, expected $100XBRO`);
  const global: any = await (p.account as any).global.fetch(pda([Buffer.from("global")], PUMP));
  const feeRecipient: PublicKey = global.feeRecipient;
  const buybackFeeRecipient: PublicKey = global.buybackFeeRecipients[0];
  const user = key.publicKey;
  const bondingCurve = bondingCurvePda(BABY);
  const creatorVault = pda([Buffer.from("creator-vault"), curve.creator.toBuffer()], PUMP);
  const userVolumeAccumulator = pda([Buffer.from("user_volume_accumulator"), user.toBuffer()], PUMP);
  const est = estimateOut(curve, quoteIn);
  const minOut = (est * MIN_OUT_BPS) / 10_000n;
  const buy = await (p.methods as any)
    .buyExactQuoteInV2(new BN(quoteIn.toString()), new BN(minOut.toString()))
    .accountsStrict({
      global: pda([Buffer.from("global")], PUMP),
      baseMint: BABY,
      quoteMint: X100,
      baseTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      feeRecipient,
      associatedQuoteFeeRecipient: ata(X100, feeRecipient),
      buybackFeeRecipient,
      associatedQuoteBuybackFeeRecipient: ata(X100, buybackFeeRecipient),
      bondingCurve,
      associatedBaseBondingCurve: ata(BABY, bondingCurve),
      associatedQuoteBondingCurve: ata(X100, bondingCurve),
      user,
      associatedBaseUser: ata(BABY, user),
      associatedQuoteUser: ata(X100, user),
      creatorVault,
      associatedCreatorVault: ata(X100, creatorVault),
      // lives under the fee program and may not exist: pump's IDL documents that handlers check data_is_empty() before reading it
      sharingConfig: pda([Buffer.from("sharing-config"), BABY.toBuffer()], FEE_PROGRAM),
      globalVolumeAccumulator: pda([Buffer.from("global_volume_accumulator")], PUMP),
      userVolumeAccumulator,
      associatedUserVolumeAccumulator: ata(X100, userVolumeAccumulator),
      feeConfig: pda([Buffer.from("fee_config"), FEE_CONFIG_SEED], FEE_PROGRAM),
      feeProgram: FEE_PROGRAM,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
      eventAuthority: pda([Buffer.from("__event_authority")], PUMP),
      program: PUMP,
    })
    .instruction();
  const ixs = [cu(300_000), createAssociatedTokenAccountIdempotentInstruction(user, ata(BABY, user), user, BABY, TOKEN_2022_PROGRAM_ID), buy];
  return { ixs, minOut, est, curve };
}

/** Burn every BABY the keeper holds. */
export const burnBabyIxs = (keeper: PublicKey, amount: bigint) => [cu(50_000), createBurnInstruction(ata(BABY, keeper), BABY, keeper, amount, [], TOKEN_2022_PROGRAM_ID)];

/** tx A: WithdrawSol of `tokens` dev r-fstacc, keeper signing as the SPL delegate; SOL to the keeper. */
export const withdrawDevIxs = (pool: Pool, keeper: PublicKey, tokens: bigint) => [cu(100_000), withdrawSolIx(pool, keeper, DEV_ATA, tokens, keeper)];

// ---------- send ----------
const firstErrorLine = (logs: string[]) => logs.find((l) => /error|failed|insufficient|custom program/i.test(l)) ?? [...logs].reverse().find((l) => l.trim()) ?? "";
export async function sendV0(conn: Connection, key: Keypair, ixs: TransactionInstruction[], label: string) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: key.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  tx.sign([key]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) throw new Error(`${label}: sim ${JSON.stringify(sim.value.err)} | ${firstErrorLine(sim.value.logs ?? [])}`);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`${label}: ${sig} failed ${JSON.stringify(res.value.err)}`);
  return sig;
}

// ---------- the sweep ----------
let carry = 0n; // $100XBRO (raw) bought for BABY but not yet converted
export const getCarry = () => carry;

/** Step d: spend `quoteIn` $100XBRO on BABY, then burn all BABY the keeper holds. Returns what was bought and burned. */
export async function convertAndBurn(conn: Connection, key: Keypair, log: Log, quoteIn: bigint, dry = false) {
  const keeper = key.publicKey;
  const { ixs, minOut, est } = await buyBabyIxs(conn, key, quoteIn);
  if (dry) return log(`SWEEP DRY buy: ${Number(quoteIn) / 1e6} $100XBRO -> ~${Number(est) / 1e6} BABY (min ${Number(minOut) / 1e6})`);
  const babyAta = ata(BABY, keeper);
  const before = await tokenBalance(conn, babyAta);
  const sigBuy = await sendV0(conn, key, ixs, "buy BABY");
  // the RPC can lag a slot behind the confirmation; a stale read here would burn 0 and strand the BABY until the next pass
  let after = before;
  for (let i = 0; i < 10 && after === before; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    after = await tokenBalance(conn, babyAta);
  }
  log(`SWEEP buy: ${Number(quoteIn) / 1e6} $100XBRO -> ${Number(after - before) / 1e6} BABY (est ${Number(est) / 1e6}) ${sigBuy}`);
  if (after === 0n) return { bought: after - before, burned: 0n, sigBuy, sigBurn: null };
  const sigBurn = await sendV0(conn, key, burnBabyIxs(keeper, after), "burn BABY");
  log(`SWEEP burn: ${Number(after) / 1e6} BABY ${sigBurn}`);
  return { bought: after - before, burned: after, sigBuy, sigBurn };
}

export async function sweepDev(conn: Connection, key: Keypair, log: Log, opts: SweepOpts = {}) {
  const min = opts.minSweep ?? MIN_SWEEP_LST;
  const keeper = key.publicKey;
  const x100Ata = ata(X100, keeper);
  try {
    // a. anything to sweep?
    const devBal = await tokenBalance(conn, DEV_ATA);
    if (devBal < min && carry === 0n) return;
    if (devBal >= min) {
      // b. tx A: dev r-fstacc -> SOL on the keeper
      const pool = await readPool(conn);
      if (opts.dry) log(`SWEEP DRY withdraw: ${Number(devBal) / 1e9} r-fstacc -> ~${(Number(devBal) * pool.rate) / 1e9} SOL`);
      else {
        const solBefore = BigInt(await conn.getBalance(keeper, "confirmed"));
        const sigA = await sendV0(conn, key, withdrawDevIxs(pool, keeper, devBal), "withdraw dev");
        const delta = BigInt(await conn.getBalance(keeper, "confirmed")) - solBefore;
        log(`SWEEP withdraw: ${Number(devBal) / 1e9} r-fstacc -> ${Number(delta) / 1e9} SOL ${sigA}`);
        // c. SOL -> $100XBRO via PumpPortal (same call shape as burn())
        const spend = delta - BUY_RESERVE_LAMPORTS;
        if (spend <= 0n) log(`SWEEP skip buy: ${Number(delta) / 1e9} SOL is under the ${Number(BUY_RESERVE_LAMPORTS) / 1e9} reserve; it stays with the keeper`);
        else {
          const spendSol = Number(spend) / 1e9;
          const invBefore = await tokenBalance(conn, x100Ata);
          const r = await fetch("https://pumpportal.fun/api/trade-local", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ publicKey: keeper.toBase58(), action: "buy", mint: X100.toBase58(), amount: spendSol, denominatedInSol: "true", slippage: 99, priorityFee: 0.0001, pool: "auto" }),
          });
          if (!r.ok) throw new Error(`pumpportal ${r.status} ${(await r.text()).split("\n")[0]}`);
          const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()));
          tx.sign([key]);
          const sigC = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
          await conn.confirmTransaction(sigC, "confirmed");
          const got = (await tokenBalance(conn, x100Ata)) - invBefore;
          carry += got;
          log(`SWEEP buy $100XBRO: ${spendSol.toFixed(6)} SOL -> ${Number(got) / 1e6} $100XBRO (carry ${Number(carry) / 1e6}) ${sigC}`);
        }
      }
    }
    // d. carry -> BABY -> burned
    if (carry > 0n) {
      const have = await tokenBalance(conn, x100Ata);
      const spend = carry < have ? carry : have; // the burn job shares this ATA; never spend what is not there
      if (spend <= 0n) { log(`SWEEP carry ${Number(carry) / 1e6} $100XBRO but the keeper holds none; dropping carry`); carry = 0n; return; }
      await convertAndBurn(conn, key, log, spend, opts.dry);
      if (!opts.dry) carry -= spend;
    }
  } catch (e) {
    log("SWEEP error:", e instanceof Error ? e.message.split("\n").find((l) => l.trim()) : e);
  }
}

// ---------- one-shot ----------
if (import.meta.main && (process.argv[2] === "once" || process.argv[2] === "baby")) {
  const conn = new Connection(process.env.RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const raw = process.env.KEEPER_KEY ?? fs.readFileSync("keeper.json", "utf8");
  const key = Keypair.fromSecretKey(raw.trim().startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw.trim()));
  const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const dry = process.env.DRY_RUN === "1";
  if (process.argv[2] === "baby") {
    const q = BigInt(process.argv[3] ?? "0");
    if (q <= 0n) throw new Error("usage: bun sweep.ts baby <raw $100XBRO>");
    log("sweep baby", key.publicKey.toBase58(), `${Number(q) / 1e6} $100XBRO`, dry ? "(dry run)" : "");
    await convertAndBurn(conn, key, log, q, dry).catch((e) => log("SWEEP error:", e instanceof Error ? e.message.split("\n").find((l) => l.trim()) : e));
  } else {
    log("sweep once", key.publicKey.toBase58(), "min", MIN_SWEEP_LST.toString(), dry ? "(dry run)" : "");
    await sweepDev(conn, key, log, { dry });
    log("sweep done, carry", carry.toString());
  }
}
