// Exercise a market whose Raydium ring is dead: poke twice (sampling mode), then buy a sliver of UP so the
// transfer hook itself runs with the 6-entry meta list. Prints TWAP / checkpoints after each step.
//   RPC=http://127.0.0.1:8899 PAYER=test-payer.json bun sample-test.ts <market>
import fs from "fs";
import os from "os";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { PROGRAM_ID, RFSTACC, type Market, pokeIx, readMarket, send, sideAccounts } from "./lib";
import { depositSolIx, readPool } from "./stakepool";

const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync((process.env.PAYER ?? "test-payer.json").replace("~", os.homedir()), "utf8"))));
const key = new PublicKey(process.argv[2]);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const d = (await conn.getAccountInfo(key))!.data;
const pk = (o: number) => new PublicKey(d.subarray(o, o + 32));
const poolBull = await conn.getAccountInfo(pk(232));
const m: Market = { key, bullMint: pk(8), bearMint: pk(40), oraclePool: pk(104), oracleObs: pk(136), windowSecs: d.readUInt32LE(480), underlyingIsToken0: d[489], config: new PublicKey(poolBull!.data.subarray(72, 104)) };
const show = async (label: string) => {
  const s = await readMarket(conn, key);
  const pool = (await conn.getAccountInfo(m.oraclePool))!.data;
  const ck = s.ckpts.filter((c) => c.ts > 0);
  log(`${label}: twap tick ${(s.lastTwapQ32 >> 32n).toString()} | pool tick ${pool.readInt32LE(269)} | last_obs_ts ${s.lastObsTs} (${Math.round(Date.now() / 1000 - s.lastObsTs)} s ago) | ckpts ${ck.length} newest ${ck.length ? Math.max(...ck.map((c) => c.ts)) : 0} | keep UP ${(Number(s.keepBullQ63) / 2 ** 63).toFixed(6)} DOWN ${(Number(s.keepBearQ63) / 2 ** 63).toFixed(6)}`);
};
await show("before");
log("poke", (await send(conn, new Transaction().add(pokeIx(m)), [payer])).sig);
await show("after poke 1");
await new Promise((r) => setTimeout(r, 2500));
log("poke", (await send(conn, new Transaction().add(pokeIx(m)), [payer])).sig);
await show("after poke 2");

// a tiny UP buy through the curve: hook Execute must resolve the 6 extra metas (incl. the pool) and rebalance
const dbc = DynamicBondingCurveClient.create(conn, "confirmed");
const a = sideAccounts(m, 0);
const quoteAta = getAssociatedTokenAddressSync(RFSTACC, payer.publicKey);
const upAta = getAssociatedTokenAddressSync(m.bullMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
const sp = await readPool(conn);
const budget = 10_000_000n;
const sdk = await dbc.pool.swap2WithTransferHook({ owner: payer.publicKey, pool: a.pool, swapBaseForQuote: false, referralTokenAccount: null, payer: payer.publicKey, swapMode: SwapMode.ExactIn, amountIn: new BN(budget.toString()), minimumAmountOut: new BN(0) });
const tx = new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, quoteAta, payer.publicKey, RFSTACC),
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, upAta, payer.publicKey, m.bullMint, TOKEN_2022_PROGRAM_ID),
  depositSolIx(sp, payer.publicKey, quoteAta, (budget * 1010n) / 1000n + 10_000n),
  ...sdk.instructions.filter((i) => i.programId.toBase58().startsWith("dbcij")),
);
const r = await send(conn, tx, [payer]);
log("buy UP", r.sig, "cu", r.cu, "| hook ran:", r.logs.some((l) => l.includes(PROGRAM_ID.toBase58())));
await show("after buy");
log("UP balance", (await conn.getTokenAccountBalance(upAta)).value.uiAmountString);
