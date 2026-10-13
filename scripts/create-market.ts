// Creates a ±100x market on mainnet (or any RPC): DBC hook config + UP/DOWN curves + market account.
// Idempotent: re-running with the same MARKET_KEYS file resumes where it stopped.
//   RPC=... PAYER=~/hooked.json TICKER=PUMP ORACLE_POOL=45ss... bun create-market.ts
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  ActivationType, BaseFeeMode, CollectFeeMode, DynamicBondingCurveClient, MigrationFeeOption, MigrationOption,
  TokenAuthorityOption, TokenDecimal, TokenType, buildCurveWithMarketCap,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import fs from "fs";
import os from "os";
import { PROGRAM_ID, RFSTACC, createMarketIx, cu, marketPda, send, sideAccounts, type Market } from "./lib";

const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const ORACLE_POOL = new PublicKey(process.env.ORACLE_POOL ?? "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5");
const WINDOW = Number(process.env.WINDOW_SECS ?? 3960);
const SITE = process.env.SITE ?? "https://100x.broker";
const RAYDIUM_CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const KEYS_FILE = process.env.MARKET_KEYS ?? `market-keys-${ORACLE_POOL.toBase58().slice(0, 8)}.json`;

const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync((process.env.PAYER ?? "test-payer.json").replace("~", os.homedir()), "utf8"))),
);
const client = DynamicBondingCurveClient.create(conn, "confirmed");

// persist the three keypairs so a partial run can resume with the same addresses
type Saved = { bull: number[]; bear: number[]; config: number[] };
const saved: Saved = fs.existsSync(KEYS_FILE)
  ? JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"))
  : { bull: [...Keypair.generate().secretKey], bear: [...Keypair.generate().secretKey], config: [...Keypair.generate().secretKey] };
fs.writeFileSync(KEYS_FILE, JSON.stringify(saved));
const bull = Keypair.fromSecretKey(Uint8Array.from(saved.bull));
const bear = Keypair.fromSecretKey(Uint8Array.from(saved.bear));
const configKp = Keypair.fromSecretKey(Uint8Array.from(saved.config));

const poolInfo = await conn.getAccountInfo(ORACLE_POOL);
if (!poolInfo || !poolInfo.owner.equals(RAYDIUM_CLMM)) throw new Error("ORACLE_POOL is not a Raydium CLMM pool");
const mint0 = new PublicKey(poolInfo.data.subarray(73, 105));
const mint1 = new PublicKey(poolInfo.data.subarray(105, 137));
const obs = new PublicKey(poolInfo.data.subarray(201, 233));
const underlyingIsToken0 = mint0.equals(WSOL) ? 0 : 1; // the non-SOL side is the underlying
const underlying = underlyingIsToken0 ? mint0 : mint1;

// names/symbols come from the underlying's DAS record — identical to app/api/_lib/das.ts
const DAS_RPC = process.env.DAS_RPC ?? (RPC.includes("helius") ? RPC : "https://mainnet.helius-rpc.com/?api-key=f5f1e120-3a60-4e11-a9ed-2b91856e664a");
const das: any = await (await fetch(DAS_RPC, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: underlying.toBase58() } }),
})).json();
if (!das.result) throw new Error("DAS getAsset failed (RPC must be Helius): " + JSON.stringify(das.error));
const uSymbol = String(das.result.content?.metadata?.symbol ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 7) || "TOKEN";
const uName = String(das.result.content?.metadata?.name ?? uSymbol).trim().slice(0, 20) || uSymbol;
console.log(`underlying ${underlying.toBase58()} = ${uName} (${uSymbol})`);
const key = marketPda(bull.publicKey, bear.publicKey, obs, WINDOW, underlyingIsToken0);
const m: Market = {
  key, bullMint: bull.publicKey, bearMint: bear.publicKey, oraclePool: ORACLE_POOL, oracleObs: obs,
  windowSecs: WINDOW, underlyingIsToken0, config: configKp.publicKey,
};
const B = sideAccounts(m, 0);
const R = sideAccounts(m, 1);
console.log(`payer ${payer.publicKey.toBase58()}  balance ${(await conn.getBalance(payer.publicKey)) / 1e9} SOL`);
console.log(`market ${key.toBase58()}\nUP mint ${bull.publicKey.toBase58()}\nDOWN mint ${bear.publicKey.toBase58()}\nconfig ${configKp.publicKey.toBase58()}`);

const [cfgExists, bullPool, bearPool, mkt] = await conn.getMultipleAccountsInfo([configKp.publicKey, B.pool, R.pool, key]);

if (!cfgExists) {
  const curve = buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.Token2022, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 9,
      tokenAuthorityOption: TokenAuthorityOption.PartnerUpdateAndMintAuthority, totalTokenSupply: 1_000_000_000, leftover: 0,
    },
    fee: {
      baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear, feeSchedulerParam: { startingFeeBps: 400, endingFeeBps: 400, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0, poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps25, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp, initialMarketCap: 10, migrationMarketCap: 1_000_000,
  });
  const tx = await client.partner.createConfigWithTransferHook({
    ...curve, config: configKp.publicKey, feeClaimer: key, leftoverReceiver: payer.publicKey, quoteMint: RFSTACC,
    payer: payer.publicKey, transferHookProgram: PROGRAM_ID,
  });
  const r = await send(conn, tx, [payer, configKp]);
  console.log("config created", r.sig);
} else console.log("config exists");

for (const [kp, exists, name, symbol, side] of [
  [bull, bullPool, `${uName} 100x UP`, `${uSymbol}UP`, "up"],
  [bear, bearPool, `${uName} 100x DOWN`, `${uSymbol}DN`, "down"],
] as const) {
  if (exists) {
    console.log(`${symbol} pool exists`);
    continue;
  }
  const tx = await client.creator.createPoolWithTransferHook({
    name, symbol, uri: `${SITE}/api/meta?mint=${underlying.toBase58()}&s=${side}`, payer: payer.publicKey, poolCreator: payer.publicKey,
    config: configKp.publicKey, baseMint: kp.publicKey, transferHookProgram: PROGRAM_ID,
  });
  const r = await send(conn, tx, [payer, kp]);
  console.log(`${symbol} pool created`, r.sig);
}

if (!mkt) {
  const tx = new Transaction().add(
    cu(600_000),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, B.escrow, key, bull.publicKey, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, R.escrow, key, bear.publicKey, TOKEN_2022_PROGRAM_ID),
    createMarketIx(payer.publicKey, m),
  );
  const r = await send(conn, tx, [payer]);
  console.log("market created", r.sig, "cu", r.cu);
} else console.log("market exists");

const mintAuth = new PublicKey((await conn.getAccountInfo(bull.publicKey))!.data.subarray(4, 36));
console.log(`UP mint authority = market? ${mintAuth.equals(key)}`);
console.log(`\nvaults: UP ${B.vault.toBase58()}  DOWN ${R.vault.toBase58()}`);
console.log(`balance after ${(await conn.getBalance(payer.publicKey)) / 1e9} SOL`);
console.log(`\nMARKET=${key.toBase58()}`);
