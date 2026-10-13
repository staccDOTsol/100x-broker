// Move SOL between vaults from a wallet: unpark `sol` worth of receipts in kind from `from`, turn every leg back into SOL, park in `to`.
// Run: HELIUS_RPC_URL=<rpc> KEY=~/hooked.json bun dn/move.ts <fromVault> <toVault> <sol>
import fs from "fs";
import { Buffer } from "buffer";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { planUserSwapOut, type PlanIx } from "../../app/api/_lib/dnplan";
import { RFSTACC, redeemIx, type Market } from "../lib";
import { listAlts } from "../alt";
import { WSOL, decodeMarketBits, depositIx, downHookExtras, readVault, valAccounts, valuation, withdrawIx } from "./lib";
import { decreaseIx, loadRay, poolCtx, rewardAtas, send } from "./ops";
import { readPool, withdrawSolIx } from "../stakepool";

const RPC = process.env.HELIUS_RPC_URL!;
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEY!, "utf8"))));
const me = payer.publicKey;
const [FROM, TO] = [new PublicKey(process.argv[2]), new PublicKey(process.argv[3])];
const SOL = BigInt(Math.round(Number(process.argv[4]) * 1e9));
const toIx = (p: PlanIx) => new TransactionInstruction({ programId: new PublicKey(p.programId), keys: p.keys.map((k) => ({ pubkey: new PublicKey(k.p), isSigner: k.s, isWritable: k.w })), data: Buffer.from(p.data, "base64") });
const bal = async (a: PublicKey) => { try { return BigInt((await conn.getTokenAccountBalance(a)).value.amount); } catch { return 0n; } };
const tables = await listAlts(conn);
const sol = (n: bigint) => (Number(n) / 1e9).toFixed(4);

// 1. unpark in kind
let v = await readVault(conn, FROM);
const x = await valuation(conn, v);
const supply = BigInt((await conn.getTokenSupply(v.shareMint)).value.amount);
const mine = await bal(getAssociatedTokenAddressSync(v.shareMint, me));
let shares = (SOL * supply) / x.nav;
if (shares > mine) shares = mine;
console.log(`from ${FROM.toBase58().slice(0, 6)}: nav ${sol(x.nav)} supply ${supply} mine ${mine} -> unpark ${shares} shares (~${sol((shares * x.nav) / supply)} SOL)`);
const md = (await conn.getAccountInfo(v.market))!.data;
const pk = (o: number) => new PublicKey(md.subarray(o, o + 32));
const opool = await conn.getAccountInfo(pk(232));
const m: Market = { key: v.market, bullMint: pk(8), bearMint: pk(40), oraclePool: pk(104), oracleObs: pk(136), windowSecs: md.readUInt32LE(480), underlyingIsToken0: md[489], config: new PublicKey(opool!.data.subarray(72, 104)) };
const bits = decodeMarketBits(v.market, Buffer.from(md));
const ray = await loadRay(conn, payer);
const ctx = await poolCtx(conn, ray, v.pool);
const aIsWsol = ctx.poolInfo.mintA.address === WSOL.toBase58();
const userX = getAssociatedTokenAddressSync(v.xMint, me, false, v.xProgram);
const userWsol = getAssociatedTokenAddressSync(WSOL, me);
const userDown = getAssociatedTokenAddressSync(v.downMint, me, false, TOKEN_2022_PROGRAM_ID);
const userQuote = getAssociatedTokenAddressSync(RFSTACC, me);
const rw = rewardAtas(ctx, me, me);
const decimals = (await conn.getAccountInfo(bits.bearMint))!.data[44];
const extras = await downHookExtras(conn, v, userDown, 1n, decimals);
const dec = await decreaseIx(conn, ctx, v, 1n, aIsWsol ? userWsol : userX, aIsWsol ? userX : userWsol, me);
dec.keys = dec.keys.map((k) => (k.pubkey.equals(v.solPda) ? { ...k, isSigner: false } : k));
const pre = [
  createAssociatedTokenAccountIdempotentInstruction(me, userX, me, v.xMint, v.xProgram),
  createAssociatedTokenAccountIdempotentInstruction(me, userWsol, me, WSOL),
  createAssociatedTokenAccountIdempotentInstruction(me, userDown, me, v.downMint, TOKEN_2022_PROGRAM_ID),
  createAssociatedTokenAccountIdempotentInstruction(me, userQuote, me, RFSTACC),
  ...rw.creates,
];
console.log("unpark", (await send(conn, payer, [...pre, withdrawIx(me, v, await valAccounts(conn, v), shares, extras, dec)], [], tables, "unpark in kind")).sig.slice(0, 12));

// 2. everything back into SOL
const [xb, downb, wsolb] = await Promise.all([bal(userX), bal(userDown), bal(userWsol)]);
const back: TransactionInstruction[] = [];
if (xb > 0n) back.push(...(await planUserSwapOut(me, FROM, xb)).ixs.map(toIx));
if (xb > 0n || wsolb > 0n) back.push(createCloseAccountInstruction(userWsol, me, me));
if (downb > 0n) back.push(redeemIx(m, me, 1, downb));
if (back.length) console.log("to SOL", (await send(conn, payer, back, [], tables, "sell X + unwrap + cash out DOWN")).sig.slice(0, 12));
const q = await bal(userQuote);
if (q > 1_000n) console.log("unstake", (await send(conn, payer, [withdrawSolIx(await readPool(conn), me, userQuote, q)], [], [], "unstake r-fstacc")).sig.slice(0, 12));
for (const a of rw.atas) { const b = await bal(a); if (b > 0n) console.log("reward token left in wallet:", a.toBase58(), b.toString()); }

// 3. park in the other vault
const tv = await readVault(conn, TO);
const got = BigInt(await conn.getBalance(me));
const amount = SOL < got - 50_000_000n ? SOL : got - 50_000_000n;
console.log("park", sol(amount), "into", TO.toBase58().slice(0, 6), (await send(conn, payer, [depositIx(me, tv, await valAccounts(conn, tv), amount)], [], [], "deposit")).sig.slice(0, 12));
console.log("wallet now", sol(BigInt(await conn.getBalance(me))), "SOL");
