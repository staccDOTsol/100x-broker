// Exercises the configured, current $100XBRO venue on a LOCAL fork. Fixture balances are synthetic.
import fs from "fs";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { PROGRAM_ID, RFSTACC, STAKE_POOL_ACCT, burnMemeIx, burnStatePda, burnVaultPda, cu, initBurnIx, memeVenue, send, tokenBalance } from "./lib";
import { readPool, withdrawSolIx } from "./stakepool";

const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const url = new URL(RPC);
if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("local fork only");
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("test-payer.json", "utf8"))));
const meme = new PublicKey(process.env.MEME_MINT ?? "Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump");
async function rpc(method: string, params: unknown[]) {
  const j: any = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); if (!ok) throw new Error(name); };
const venue = memeVenue(meme);
const [mi, bc, pool, sp] = await conn.getMultipleAccountsInfo([meme, venue.bondingCurve, venue.pool, STAKE_POOL_ACCT]);
if (!mi || !bc || !sp) throw new Error("live burn venue dependencies absent");
const memeProgram = mi.owner;
const memeAta = getAssociatedTokenAddressSync(meme, payer.publicKey, false, memeProgram);
const quoteAta = getAssociatedTokenAddressSync(RFSTACC, payer.publicKey);
await send(conn, new Transaction().add(cu(200_000), initBurnIx(payer.publicKey),
  createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, quoteAta, payer.publicKey, RFSTACC)), [payer]);
const pot = 100_000_000n;
const potData = Buffer.from((await conn.getAccountInfo(burnVaultPda()))!.data);
potData.writeBigUInt64LE(pot, 64);
await rpc("surfnet_setAccount", [burnVaultPda().toBase58(), { data: potData.toString("hex") }]);
const state = Buffer.from((await conn.getAccountInfo(burnStatePda()))!.data);
// last_ts is byte 16, after the discriminator, bumps and padding.
state.writeBigInt64LE(0n, 16);
await rpc("surfnet_setAccount", [burnStatePda().toBase58(), { data: state.toString("hex") }]);
let base = venue.pool, quote = venue.pool, vt: bigint, vs: bigint, fee: bigint;
if (bc.data[48] === 0) {
  vt = bc.data.readBigUInt64LE(8); vs = bc.data.readBigUInt64LE(16); fee = 9900n;
} else {
  if (!pool) throw new Error("graduated coin missing canonical pool");
  base = new PublicKey(pool.data.subarray(139, 171)); quote = new PublicKey(pool.data.subarray(171, 203));
  const [b, q] = await conn.getMultipleAccountsInfo([base, quote]);
  vt = b!.data.readBigUInt64LE(64); vs = q!.data.readBigUInt64LE(64); fee = 9970n;
}
const total = sp.data.readBigUInt64LE(258), supply = sp.data.readBigUInt64LE(266);
const expected = (n: bigint) => (((((vs * n) / (vt + n)) * fee) / 10000n * 10300n) / 10000n * supply) / total;
let lo = 0n, hi = 1_000_000_000n * 10n ** BigInt(mi.data[44]);
while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (expected(mid) <= pot / 100n) lo = mid; else hi = mid; }
const amount = lo, payout = expected(amount);
check("current venue provides positive bounded quote", payout > 0n && payout <= pot * 500n / 10000n, `graduated=${bc.data[48] !== 0} payout=${payout}`);
await rpc("surfnet_setTokenAccount", [payer.publicKey.toBase58(), meme.toBase58(), { amount: Number(amount * 2n) }, memeProgram.toBase58()]);
const beforeMeme = await tokenBalance(conn, memeAta), beforeQuote = await tokenBalance(conn, quoteAta);
const beforeSupply = (await conn.getAccountInfo(meme))!.data.readBigUInt64LE(36);
const ix = burnMemeIx(payer.publicKey, meme, memeProgram, memeAta, base, quote, amount);
await send(conn, new Transaction().add(cu(250_000), ix), [payer]);
check("burn reduces caller balance and mint supply", beforeMeme - await tokenBalance(conn, memeAta) === amount
  && beforeSupply - (await conn.getAccountInfo(meme))!.data.readBigUInt64LE(36) === amount);
check("bounty exactly equals current venue sell quote +3%", await tokenBalance(conn, quoteAta) - beforeQuote === payout);
check("pot pays only the calculated bounty", pot - await tokenBalance(conn, burnVaultPda()) === payout);
const cooldown = await conn.simulateTransaction(new Transaction().add(cu(250_000), ix), [payer]);
check("cooldown prevents immediate second burn", !!cooldown.value.err);
const huge = await conn.simulateTransaction(new Transaction().add(cu(250_000),
  burnMemeIx(payer.publicKey, meme, memeProgram, memeAta, base, quote, 2n ** 63n - 1n)), [payer]);
check("burn over 5% pot cap is rejected", !!huge.value.err);
const solBefore = await conn.getBalance(payer.publicKey);
await send(conn, new Transaction().add(cu(250_000), withdrawSolIx(await readPool(conn), payer.publicKey, quoteAta, payout)), [payer]);
check("earned r-fstacc bounty can exit to SOL", await conn.getBalance(payer.publicKey) > solBefore);
console.log(`ALL CURRENT BURN CHECKS PASS (${PROGRAM_ID})`);
