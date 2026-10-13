// Make a Raydium CLMM pool for a coin that only lives on PumpSwap, and seed it, so a ±100× market (oracle) and a dnvault (LP venue)
// can exist for it. Price is copied from the PumpSwap pair; liquidity comes from the payer.
//   RPC=... PAYER=~/hooked.json MINT=<coin> SEED_SOL=0.2 RANGE=4 FEE_INDEX=1 bun si-pool.ts
// Idempotent-ish: POOL=<id> skips creation and only seeds.
import fs from "fs";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as RaySdk from "@raydium-io/raydium-sdk-v2";
const { CLMM_PROGRAM_ID, TxVersion } = RaySdk as any;
import BN from "bn.js";
import Decimal from "decimal.js";
import { loadRay } from "./dn/ops";
import { tokenBalance } from "./lib";

const conn = new Connection(process.env.RPC!, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync((process.env.PAYER ?? "~/hooked.json").replace(/^~/, process.env.HOME!), "utf8"))));
const me = payer.publicKey;
const MINT = new PublicKey(process.env.MINT ?? "3VPoXaRcXxju8qgkVRN87UuXZxbdBD7zyaXPDqqmpump");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const SEED_SOL = Number(process.env.SEED_SOL ?? 0.2); // SOL side of the seed; the same value in SOL is spent buying the coin
const RANGE = Number(process.env.RANGE ?? 4); // position spans price/RANGE .. price*RANGE
const FEE_INDEX = Number(process.env.FEE_INDEX ?? 1); // Raydium config index 1 = 0.25 %, tick spacing 60
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const mintInfo = (await conn.getAccountInfo(MINT))!;
const decimals = mintInfo.data[44];
const tokenProgram = mintInfo.owner;
const ds = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${MINT.toBase58()}`).then((r) => r.json());
const pair = (ds.pairs as any[]).filter((p) => p.quoteToken.address === WSOL.toBase58()).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
if (!pair) throw new Error("no SOL-quoted pair on DexScreener to copy a price from");
const price = Number(pair.priceNative); // SOL per coin
log(`${pair.baseToken.symbol} ${price} SOL (from ${pair.dexId}, $${Math.round(pair.liquidity.usd)} liq), decimals ${decimals}, program ${tokenProgram.toBase58().slice(0, 6)}`);

const ray = await loadRay(conn, payer);
const tok = (address: PublicKey, programId: PublicKey, dec: number, symbol: string) => ({ chainId: 101, address: address.toBase58(), programId: programId.toBase58(), logoURI: "", symbol, name: symbol, decimals: dec, tags: [], extensions: {} });

// 1. pool
let poolId = process.env.POOL ? new PublicKey(process.env.POOL) : null;
if (!poolId) {
  const cfgs: any[] = await ray.api.getClmmConfigs();
  const cfg = cfgs.find((c) => c.index === FEE_INDEX)!;
  const { execute, extInfo } = await ray.clmm.createPool({
    programId: CLMM_PROGRAM_ID,
    mint1: tok(MINT, tokenProgram, decimals, pair.baseToken.symbol) as any,
    mint2: tok(WSOL, TOKEN_PROGRAM_ID, 9, "WSOL") as any,
    ammConfig: { ...cfg, id: new PublicKey(cfg.id), fundOwner: "", description: "" },
    initialPrice: new Decimal(price),
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 400_000, microLamports: 100_000 },
  } as any);
  const { txId } = await execute({ sendAndConfirm: true });
  poolId = new PublicKey((extInfo as any).address.id);
  log("pool created", poolId.toBase58(), txId);
}

// 2. buy the coin on its home venue (PumpSwap via PumpPortal), spending SEED_SOL
const coinAta = getAssociatedTokenAddressSync(MINT, me, false, tokenProgram);
let coin = await tokenBalance(conn, coinAta);
const shortSol = SEED_SOL - (Number(coin) / 10 ** decimals) * price;
if (shortSol > 0.01) {
  const r = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey: me.toBase58(), action: "buy", mint: MINT.toBase58(), amount: Number(shortSol.toFixed(4)), denominatedInSol: "true", slippage: 10, priorityFee: 0.0002, pool: "auto" }),
  });
  if (!r.ok) throw new Error(`pumpportal ${r.status} ${await r.text()}`);
  const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()));
  tx.sign([payer]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction(sig, "confirmed");
  coin = await tokenBalance(conn, coinAta);
  log(`now hold ${Number(coin) / 10 ** decimals} ${pair.baseToken.symbol} after buying ${shortSol.toFixed(4)} SOL worth`, sig);
}

// 3. seed: a wide position around the copied price, coin-side sized by what we hold, SOL capped at SEED_SOL
log("step: pool info");
// getPoolInfoFromRpc chokes on a pool with no tick arrays yet; the API already knows the pool, and open_position creates the arrays
const [poolInfo] = (await ray.api.fetchPoolById({ ids: poolId.toBase58() })) as any[];
const [poolKeys] = (await ray.api.fetchPoolKeysById({ idList: [poolId.toBase58()] })) as any[];
if (!poolInfo || !poolKeys) throw new Error("Raydium API has not indexed the pool yet; retry in a minute");
log("pool price", poolInfo.price, "mintA", poolInfo.mintA.symbol ?? poolInfo.mintA.address.slice(0, 6));
const coinIsA = poolInfo.mintA.address === MINT.toBase58();
const decA: number = poolInfo.mintA.decimals, decB: number = poolInfo.mintB.decimals;
const spacing: number = poolInfo.config.tickSpacing;
const pxA = Number(poolInfo.price); // mintB per mintA, UI units
// tick = log_1.0001(raw price); raw = ui * 10^(decB - decA). Snap outward to the spacing so the range always contains the price.
const tickOf = (ui: number) => Math.log(ui * 10 ** (decB - decA)) / Math.log(1.0001);
const tickLower = Math.floor(tickOf(pxA / RANGE) / spacing) * spacing;
const tickUpper = Math.ceil(tickOf(pxA * RANGE) / spacing) * spacing;
const sqrt = (t: number) => Math.pow(1.0001, t / 2);
const sP = Math.sqrt(pxA * 10 ** (decB - decA)), sA = sqrt(tickLower), sB = sqrt(tickUpper);
// Uniswap v3 amounts for liquidity L: amount0 = L (1/sP - 1/sB), amount1 = L (sP - sA); token0 = mintA, token1 = mintB
const coinRaw = Number(coin);
const L = coinIsA ? coinRaw / (1 / sP - 1 / sB) : coinRaw / (sP - sA);
const otherRaw = coinIsA ? L * (sP - sA) : L * (1 / sP - 1 / sB); // lamports of WSOL the coin stack pairs with
const solBudget = Math.round(SEED_SOL * 1e9);
log(`step: ticks ${tickLower}..${tickUpper} (×${RANGE} each way), coin ${coinRaw} needs ${(otherRaw / 1e9).toFixed(4)} SOL, budget ${SEED_SOL}`);
let base: "MintA" | "MintB", baseAmount: BN, otherMax: BN;
if (otherRaw <= solBudget) {
  base = coinIsA ? "MintA" : "MintB"; baseAmount = new BN(coinRaw.toString()); otherMax = new BN(Math.ceil(otherRaw * 1.03).toString());
} else {
  base = coinIsA ? "MintB" : "MintA"; baseAmount = new BN(solBudget.toString()); otherMax = new BN(coinRaw.toString());
}
log("step: open position");
const { execute: ex2 } = await ray.clmm.openPositionFromBase({
  poolInfo, poolKeys, tickUpper, tickLower, base, ownerInfo: { useSOLBalance: true }, baseAmount, otherAmountMax: otherMax,
  txVersion: TxVersion.V0, nft2022: true, computeBudgetConfig: { units: 600_000, microLamports: 100_000 },
} as any);
const { txId: seedSig } = await ex2({ sendAndConfirm: true });
log("seeded", seedSig);
console.log(`POOL=${poolId.toBase58()}`);
