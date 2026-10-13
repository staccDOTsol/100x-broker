// Two dust swaps in a fresh CLMM pool so its observation ring accrues real tick-time (the 100x oracle reads ~0 until then).
//   RPC=... PAYER=~/hooked.json POOL=<clmm> bun si-kick.ts
import fs from "fs";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadRay, poolCtx, send, swapIx } from "./dn/ops";
import { tokenBalance } from "./lib";
import { listAlts } from "./alt";
const conn = new Connection(process.env.RPC!, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync((process.env.PAYER ?? "~/hooked.json").replace(/^~/, process.env.HOME!), "utf8"))));
const me = payer.publicKey;
const POOL = new PublicKey(process.env.POOL ?? "ATwrVQsD1mAEQsR5WFoNuomTtWUNTaxmbpzUT3teWZNe");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const LAM = BigInt(process.env.LAMPORTS ?? 2_000_000);
const ray = await loadRay(conn, payer);
const ctx = await poolCtx(conn, ray, POOL);
const aIsWsol = ctx.poolInfo.mintA.address === WSOL.toBase58();
const xMint = new PublicKey(aIsWsol ? ctx.poolInfo.mintB.address : ctx.poolInfo.mintA.address);
const xProg = (await conn.getAccountInfo(xMint))!.owner;
const wsolAta = getAssociatedTokenAddressSync(WSOL, me);
const xAta = getAssociatedTokenAddressSync(xMint, me, false, xProg);
const fake = { solPda: me, wsolAta, xAta } as any; // swapIx only needs these three
const tables = await listAlts(conn);
const pre = [
  createAssociatedTokenAccountIdempotentInstruction(me, wsolAta, me, WSOL, TOKEN_PROGRAM_ID),
  createAssociatedTokenAccountIdempotentInstruction(me, xAta, me, xMint, xProg),
  SystemProgram.transfer({ fromPubkey: me, toPubkey: wsolAta, lamports: LAM }),
  createSyncNativeInstruction(wsolAta),
];
const s1 = await swapIx(conn, ctx, fake, WSOL, LAM, 0.05);
const r1 = await send(conn, payer, [...pre, s1.ix], [], tables, "kick: SOL -> X");
console.log("swap 1", r1.sig);
await new Promise((r) => setTimeout(r, 5000));
const got = await tokenBalance(conn, xAta);
const ctx2 = await poolCtx(conn, ray, POOL);
const s2 = await swapIx(conn, ctx2, fake, xMint, got, 0.05);
const r2 = await send(conn, payer, [s2.ix, createCloseAccountInstruction(wsolAta, me, me)], [], tables, "kick: X -> SOL");
console.log("swap 2", r2.sig, "x sold", got.toString());
