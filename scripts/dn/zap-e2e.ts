// Fork e2e for the site's 1-click zaps: plan on the server side (app/api/_lib/dnplan.ts), sign everything up front with
// one keypair like a wallet's signAllTransactions, send in order; then unpark half in kind and sell the X leg back.
// Run: HELIUS_RPC_URL=http://127.0.0.1:8899 bun dn/zap-e2e.ts [vault]
import fs from "fs";
import { Buffer } from "buffer";
import bs58 from "bs58";
import { AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { planUserSwapOut, planZapIn, type PlanIx } from "../../app/api/_lib/dnplan";
import { RFSTACC } from "../lib";
import { WSOL, downHookExtras, readVault, valAccounts, valuation, withdrawIx } from "./lib";
import { decreaseIx, loadRay, poolCtx, send } from "./ops";

const RPC = process.env.HELIUS_RPC_URL ?? "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEY ?? "test-payer.json", "utf8"))));
const me = payer.publicKey;
const VAULT = new PublicKey(process.argv[2] ?? "H9RwxG2ftmSCGBWjrmLaAdFYHxNb8DzfrfEhcQ7JPD1T");
const MAIN_ALT = new PublicKey("HR1YvAhHBXPkhFFjp2mzaAg5ojnNUQyamU8qzTW4PK7U");
const sol = (n: bigint) => (Number(n) / LAMPORTS_PER_SOL).toFixed(6);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const toIx = (p: PlanIx) => new TransactionInstruction({ programId: new PublicKey(p.programId), keys: p.keys.map((k) => ({ pubkey: new PublicKey(k.p), isSigner: k.s, isWritable: k.w })), data: Buffer.from(p.data, "base64") });
const bal = async (a: PublicKey) => BigInt((await conn.getTokenAccountBalance(a).catch(() => ({ value: { amount: "0" } }))).value.amount);

const tables: AddressLookupTableAccount[] = [(await conn.getAddressLookupTable(MAIN_ALT)).value!];
let v = await readVault(conn, VAULT);
const x0 = await valuation(conn, v);
log(`vault ${VAULT.toBase58().slice(0, 6)}  nav ${sol(x0.nav)}  err ${x0.errBps} bps  position ${v.position?.toBase58().slice(0, 6) ?? "none"}`);
log(`me ${me.toBase58()}  ${sol(BigInt(await conn.getBalance(me)))} SOL`);

// ---- zap in: plan, sign all, send in order (what the browser does) ----
const DEP = BigInt(Math.floor(Number(process.env.DEP_SOL ?? "0.3") * LAMPORTS_PER_SOL));
const sharesBefore = await bal(getAssociatedTokenAddressSync((await readVault(conn, VAULT)).shareMint, me));
const plan = await planZapIn(me, VAULT, DEP);
log(`plan: ${plan.steps.map((s) => `${s.label} (${s.ixs.length} ix, ${s.signers.length} signers)`).join(" | ")}${plan.note ? `  note: ${plan.note}` : ""}`);
const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
const txs = plan.steps.map((s) => {
  const msg = new TransactionMessage({ payerKey: me, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...s.ixs.map(toIx)] }).compileToV0Message(tables);
  const tx = new VersionedTransaction(msg);
  tx.sign([payer, ...s.signers.map((k) => Keypair.fromSecretKey(bs58.decode(k)))]);
  log(`  ${s.label}: ${tx.serialize().length} bytes`);
  return tx;
});
const before = BigInt(await conn.getBalance(me));
for (let i = 0; i < txs.length; i++) {
  const sig = await conn.sendRawTransaction(txs[i].serialize(), { skipPreflight: false, preflightCommitment: "confirmed" }).catch(async (e) => {
    console.log(String(e?.logs?.slice?.(-25)?.join("\n") ?? e));
    throw new Error(`${plan.steps[i].label}: preflight failed`);
  });
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) {
    const got = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    console.log((got?.meta?.logMessages ?? []).slice(-25).join("\n"));
    throw new Error(`${plan.steps[i].label}: failed ${JSON.stringify(res.value.err)}`);
  }
  log(`ok ${plan.steps[i].label}  ${sig.slice(0, 12)}`);
}
v = await readVault(conn, VAULT);
let x = await valuation(conn, v);
const userShare = getAssociatedTokenAddressSync(v.shareMint, me);
let shares = await bal(userShare);
log(`after zap-in: nav ${sol(x.nav)}  my shares ${shares}  free ${sol(x.free)}  wsol ${x.wsol}  x ${x.xTotal}  D ${sol(x.d)} D* ${sol(x.dStar)} err ${x.errBps} bps (band ${v.bandBps})  position ${v.position?.toBase58().slice(0, 6) ?? "none"}`);
log(`bounty to me (SOL delta incl. fees): ${sol(BigInt(await conn.getBalance(me)) - before + DEP)}`);
if (shares === 0n) throw new Error("no shares minted");
if (x.errBps > BigInt(v.bandBps)) throw new Error("left unhedged");
if (!v.position) throw new Error("no position after zap-in");

// ---- zap out: withdraw half in kind, then sell the X back for WSOL and unwrap (tx2 of the site's flow) ----
const ray = await loadRay(conn, payer);
const ctx = await poolCtx(conn, ray, v.pool);
const aIsWsol = ctx.poolInfo.mintA.address === WSOL.toBase58();
const userX = getAssociatedTokenAddressSync(v.xMint, me, false, v.xProgram);
const userWsol = getAssociatedTokenAddressSync(WSOL, me);
const userDown = getAssociatedTokenAddressSync(v.downMint, me, false, TOKEN_2022_PROGRAM_ID);
const userQuote = getAssociatedTokenAddressSync(RFSTACC, me);
await send(conn, payer, [
  createAssociatedTokenAccountIdempotentInstruction(me, userX, me, v.xMint, v.xProgram),
  createAssociatedTokenAccountIdempotentInstruction(me, userWsol, me, WSOL),
  createAssociatedTokenAccountIdempotentInstruction(me, userDown, me, v.downMint, TOKEN_2022_PROGRAM_ID),
  createAssociatedTokenAccountIdempotentInstruction(me, userQuote, me, RFSTACC),
], [], [], "atas");
const m = await (await import("./lib")).decodeMarketBits(v.market, Buffer.from((await conn.getAccountInfo(v.market))!.data));
const decimals = (await conn.getAccountInfo(m.bearMint))!.data[44];
const extras = await downHookExtras(conn, v, userDown, 1n, decimals);
const dec = await decreaseIx(conn, ctx, v, 1n, aIsWsol ? userWsol : userX, aIsWsol ? userX : userWsol);
dec.keys = dec.keys.map((k) => (k.pubkey.equals(v.solPda) ? { ...k, isSigner: false } : k));
// OUT=new unparks only what this run minted (mainnet smoke); default is half of everything held
const half = process.env.OUT === "new" ? shares - sharesBefore : shares / 2n;
const shareSupply = BigInt((await conn.getTokenSupply(v.shareMint)).value.amount); // read before the burn, as the site does
const b4 = { sol: BigInt(await conn.getBalance(me)), x: await bal(userX), wsol: await bal(userWsol), down: await bal(userDown), q: await bal(userQuote) };
log("withdraw", (await send(conn, payer, [withdrawIx(me, v, await valAccounts(conn, v), half, extras, dec)], [], tables, "withdraw")).sig.slice(0, 12));
const got = { x: (await bal(userX)) - b4.x, wsol: (await bal(userWsol)) - b4.wsol, down: (await bal(userDown)) - b4.down, q: (await bal(userQuote)) - b4.q };
log(`in kind: x ${got.x}  wsol ${got.wsol}  down ${got.down}  quote ${got.q}`);
// the site plans tx2 before tx1 lands, from 98% of the pro-rata estimate
const xEst = (((x.xTotal * half) / shareSupply) * 98n) / 100n;
log(`x estimate for tx2: ${xEst} (actual ${got.x})`);
if (xEst > got.x) throw new Error("98% estimate exceeded the actual X received");
const sw = await planUserSwapOut(me, VAULT, xEst);
const b5 = BigInt(await conn.getBalance(me));
log("sell X + unwrap", (await send(conn, payer, [...sw.ixs.map(toIx), createCloseAccountInstruction(userWsol, me, me)], [], tables, "tx2")).sig.slice(0, 12));
log(`tx2 minOut ${sw.minOut}  SOL delta ${sol(BigInt(await conn.getBalance(me)) - b5)}`);
x = await valuation(conn, v);
log(`vault after: nav ${sol(x.nav)}  err ${x.errBps} bps`);
log("ALL PASS");
