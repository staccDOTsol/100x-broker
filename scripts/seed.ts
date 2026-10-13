// Seeds a market's vaults with r-freestacc (split evenly) and makes the first buy on each side.
//   RPC=<helius> PAYER=~/hooked.json MARKET=<market pubkey> SEED=0.5 BUY=0.03 bun seed.ts
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createTransferInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import fs from "fs";
import os from "os";
import { RFSTACC, cu, send, sideAccounts, tokenBalance, type Market } from "./lib";

const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const MARKET = new PublicKey(process.env.MARKET ?? "GwzRwcPYSojZiNc4tC4eoLSLD7htk3akWA7qtG68zyHh");
const SEED = BigInt(Math.round(Number(process.env.SEED ?? "0.5") * 1e9));
const BUY = BigInt(Math.round(Number(process.env.BUY ?? "0.03") * 1e9));
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync((process.env.PAYER ?? "test-payer.json").replace("~", os.homedir()), "utf8"))),
);
const client = DynamicBondingCurveClient.create(conn, "confirmed");

const d = (await conn.getAccountInfo(MARKET))!.data;
const pk = (o: number) => new PublicKey(d.subarray(o, o + 32));
const poolBull = await conn.getAccountInfo(pk(232));
const m: Market = {
  key: MARKET, bullMint: pk(8), bearMint: pk(40), oraclePool: pk(104), oracleObs: pk(136),
  windowSecs: d.readUInt32LE(480), underlyingIsToken0: d[489], config: new PublicKey(poolBull!.data.subarray(72, 104)),
};
const B = sideAccounts(m, 0);
const R = sideAccounts(m, 1);
const quoteAta = getAssociatedTokenAddressSync(RFSTACC, payer.publicKey);
const have = await tokenBalance(conn, quoteAta);
console.log(`payer ${payer.publicKey.toBase58()}  r-fstacc ${Number(have) / 1e9}  SOL ${(await conn.getBalance(payer.publicKey)) / 1e9}`);
if (have < SEED + 2n * BUY) throw new Error(`need ${Number(SEED + 2n * BUY) / 1e9} r-fstacc, have ${Number(have) / 1e9}`);

if (SEED > 0n) {
  const half = SEED / 2n;
  const r = await send(conn, new Transaction().add(
    createTransferInstruction(quoteAta, B.vault, payer.publicKey, half),
    createTransferInstruction(quoteAta, R.vault, payer.publicKey, SEED - half),
  ), [payer]);
  console.log(`seeded vaults ${Number(half) / 1e9} + ${Number(SEED - half) / 1e9}`, r.sig);
}

for (const [side, acc, label] of [[0, B, "UP"], [1, R, "DOWN"]] as const) {
  if (BUY === 0n) break;
  const tx = await client.pool.swap2WithTransferHook({
    owner: payer.publicKey, pool: acc.pool, swapBaseForQuote: false, referralTokenAccount: null, payer: payer.publicKey,
    swapMode: SwapMode.ExactIn, amountIn: new BN(BUY.toString()), minimumAmountOut: new BN(0),
  });
  tx.instructions.unshift(cu(400_000));
  const r = await send(conn, tx, [payer]);
  const got = await tokenBalance(conn, getAssociatedTokenAddressSync(acc.mint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID));
  console.log(`bought ${label}: ${Number(got) / 1e6} tokens for ${Number(BUY) / 1e9} r-fstacc  (cu ${r.cu})`, r.sig);
  void side;
}
console.log(`vaults now UP ${Number(await tokenBalance(conn, B.vault)) / 1e9}  DOWN ${Number(await tokenBalance(conn, R.vault)) / 1e9}`);
