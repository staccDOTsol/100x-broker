// Buy UP or DOWN on a market with SOL, from a script: stake SOL -> r-fstacc, swap it into the side's curve through the hook.
//   RPC=... PAYER=~/hooked.json bun punt.ts <market> <UP|DOWN> <sol>
import fs from "fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { RFSTACC, claimFeesIx, cu, sideAccounts, tokenBalance, type Market } from "./lib";
import { listAlts } from "./alt";
import { depositSolIx, readPool } from "./stakepool";
import { send } from "./dn/ops";

const conn = new Connection(process.env.RPC!, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync((process.env.PAYER ?? "~/hooked.json").replace(/^~/, process.env.HOME!), "utf8"))));
const me = payer.publicKey;
const MARKET = new PublicKey(process.argv[2]);
const side = process.argv[3].toUpperCase() === "DOWN" ? 1 : 0;
const lamports = BigInt(Math.round(Number(process.argv[4]) * 1e9));

const md = (await conn.getAccountInfo(MARKET))!.data;
const pk = (o: number) => new PublicKey(md.subarray(o, o + 32));
const opool = (await conn.getAccountInfo(pk(232)))!;
const m: Market = { key: MARKET, bullMint: pk(8), bearMint: pk(40), oraclePool: pk(104), oracleObs: pk(136), windowSecs: md.readUInt32LE(480), underlyingIsToken0: md[489], config: new PublicKey(opool.data.subarray(72, 104)) };
const a = sideAccounts(m, side);
const pool = await readPool(conn);
const quoteAta = getAssociatedTokenAddressSync(RFSTACC, me);
const sideAta = getAssociatedTokenAddressSync(a.mint, me, false, TOKEN_2022_PROGRAM_ID);
// what the stake pool mints for this SOL, after its 0.1% deposit fee; swap a hair less so the tx never over-asks
const minted = (lamports * pool.poolTokenSupply) / pool.totalLamports;
const amountIn = (minted * 9_985n) / 10_000n;
const dbc = DynamicBondingCurveClient.create(conn, "confirmed");
const swap = await dbc.pool.swap2WithTransferHook({ owner: me, pool: a.pool, swapBaseForQuote: false, referralTokenAccount: null, payer: me, swapMode: SwapMode.ExactIn, amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(0) });
const before = await tokenBalance(conn, sideAta);
// two txs: the hooked swap alone is ~1.1 KB, so staking goes first and the swap rides the site lookup table.
// r-fstacc already in the wallet counts, so a re-run after a failed swap doesn't stake twice.
const have = await tokenBalance(conn, quoteAta);
if (have < amountIn) {
  const need = ((amountIn - have) * pool.totalLamports) / pool.poolTokenSupply + 10_000n;
  await send(conn, payer, [createAssociatedTokenAccountIdempotentInstruction(me, quoteAta, me, RFSTACC), createAssociatedTokenAccountIdempotentInstruction(me, sideAta, me, a.mint, TOKEN_2022_PROGRAM_ID), depositSolIx(pool, me, quoteAta, need)], [], [], "stake");
} else {
  await send(conn, payer, [createAssociatedTokenAccountIdempotentInstruction(me, sideAta, me, a.mint, TOKEN_2022_PROGRAM_ID)], [], [], "side ata");
}
const tables = await listAlts(conn);
// spend what actually landed (pool rate / fee rounding can leave a hair less than the estimate)
const landed = await tokenBalance(conn, quoteAta);
const spend = landed < amountIn ? landed : amountIn;
const swapNow = await dbc.pool.swap2WithTransferHook({ owner: me, pool: a.pool, swapBaseForQuote: false, referralTokenAccount: null, payer: me, swapMode: SwapMode.ExactIn, amountIn: new BN(spend.toString()), minimumAmountOut: new BN(0) });
// the SDK repeats its idempotent ATA creates; the runtime rejects duplicate instructions
const seen = new Set<string>();
const swapIxs = swapNow.instructions.filter((ix) => {
  if (ix.programId.equals(new PublicKey("ComputeBudget111111111111111111111111111111"))) return false;
  const k = ix.programId.toBase58() + ix.data.toString("hex") + ix.keys.map((x) => x.pubkey.toBase58()).join(",");
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
const r = await send(conn, payer, swapIxs, [], tables, `buy ${side ? "DOWN" : "UP"}`); // send() adds its own compute budget
void claimFeesIx; void cu;
const after = await tokenBalance(conn, sideAta);
console.log(`bought ${Number(after - before) / 1e6} ${side ? "DOWN" : "UP"} on ${MARKET.toBase58().slice(0, 6)} for ${Number(spend) / 1e9} r-fstacc (~${Number(lamports) / 1e9} SOL)  ${r.sig}`);
