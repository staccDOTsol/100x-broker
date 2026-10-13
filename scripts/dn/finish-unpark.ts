// Turn whatever of a vault's legs sits in a wallet (X, DOWN, WSOL, r-fstacc) back into SOL, from live balances.
// Run: HELIUS_RPC_URL=<rpc> KEY=~/hooked.json bun dn/finish-unpark.ts [vault]
import fs from "fs";
import { Buffer } from "buffer";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { planUserSwapOut, type PlanIx } from "../../app/api/_lib/dnplan";
import { RFSTACC, redeemIx, type Market } from "../lib";
import { listAlts } from "../alt";
import { WSOL, readVault } from "./lib";
import { send } from "./ops";
import { readPool, withdrawSolIx } from "../stakepool";

const RPC = process.env.HELIUS_RPC_URL!;
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEY ?? "keeper.json", "utf8"))));
const me = payer.publicKey;
const VAULT = new PublicKey(process.argv[2] ?? "H9RwxG2ftmSCGBWjrmLaAdFYHxNb8DzfrfEhcQ7JPD1T");
const toIx = (p: PlanIx) => new TransactionInstruction({ programId: new PublicKey(p.programId), keys: p.keys.map((k) => ({ pubkey: new PublicKey(k.p), isSigner: k.s, isWritable: k.w })), data: Buffer.from(p.data, "base64") });
const bal = async (a: PublicKey) => { try { return BigInt((await conn.getTokenAccountBalance(a)).value.amount); } catch { return 0n; } };

const v = await readVault(conn, VAULT);
const md = (await conn.getAccountInfo(v.market))!.data;
const pk = (o: number) => new PublicKey(md.subarray(o, o + 32));
const opool = await conn.getAccountInfo(pk(232));
const m: Market = { key: v.market, bullMint: pk(8), bearMint: pk(40), oraclePool: pk(104), oracleObs: pk(136), windowSecs: md.readUInt32LE(480), underlyingIsToken0: md[489], config: new PublicKey(opool!.data.subarray(72, 104)) };
const xAta = getAssociatedTokenAddressSync(v.xMint, me, false, v.xProgram);
const downAta = getAssociatedTokenAddressSync(v.downMint, me, false, TOKEN_2022_PROGRAM_ID);
const wsolAta = getAssociatedTokenAddressSync(WSOL, me);
const quoteAta = getAssociatedTokenAddressSync(RFSTACC, me);
const [x, down, wsol, quote] = await Promise.all([bal(xAta), bal(downAta), bal(wsolAta), bal(quoteAta)]);
console.log(`wallet ${me.toBase58().slice(0, 6)}: X ${x} DOWN ${down} WSOL ${wsol} r-fstacc ${quote}  SOL ${(await conn.getBalance(me)) / 1e9}`);
const pool = await readPool(conn);
const ixs: TransactionInstruction[] = [];
if (x > 0n) ixs.push(createAssociatedTokenAccountIdempotentInstruction(me, wsolAta, me, WSOL), ...(await planUserSwapOut(me, VAULT, x)).ixs.map(toIx)); // the swap lands SOL in WSOL; a closed ATA is the usual state between unparks
if (x > 0n || wsol > 0n) ixs.push(createCloseAccountInstruction(wsolAta, me, me));
// DOWN: cash out at the pot (always possible), proceeds in r-fstacc, then unstake everything r-fstacc in one go
if (down > 0n) ixs.push(redeemIx(m, me, 1, down));
const circ = async () => { const mint = (await conn.getAccountInfo(v.downMint))!.data; const bv = (await conn.getAccountInfo(m.config))!; return { supply: mint.readBigUInt64LE(36) }; };
void circ;
const before = BigInt(await conn.getBalance(me));
const sig1 = ixs.length ? (await send(conn, payer, ixs, [], await listAlts(conn), "sell X + unwrap + cash out DOWN")).sig : null;
console.log("tx1", sig1);
const quote2 = await bal(quoteAta);
if (quote2 > 1_000n) console.log("tx2", (await send(conn, payer, [withdrawSolIx(pool, me, quoteAta, quote2)], [], [], "unstake r-fstacc")).sig);
console.log(`SOL now ${(await conn.getBalance(me)) / 1e9} (Δ ${(Number(BigInt(await conn.getBalance(me)) - before) / 1e9).toFixed(4)})`);
