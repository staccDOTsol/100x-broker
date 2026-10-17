// Get SOL back from the house wallet (/Users/stacc/hooked.json, 331nEB): close every Orca position it owns (its coins come
// back; the position, its NFT mint and NFT account return their rent) and then every empty token account. Pools, vaults and
// tick arrays can't be closed on Orca; their rent stays. Dry run (simulates the first few) unless --send.
//
//   node scripts/rescue.mjs [--send]
//   node scripts/rescue.mjs --sweep ~/a.json ~/b.json [--send]   also move all SOL from those keypair files to the house wallet
import fs from "node:fs";
import os from "node:os";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

const env = Object.fromEntries(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^"|"$/g, "")]));
const conn = new Connection(env.HELIUS_RPC_URL, "confirmed");
const W = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const SEND = process.argv.includes("--send");
const house = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/Users/stacc/hooked.json", "utf8"))));
const me = house.publicKey;
const m = (pubkey, isWritable, isSigner = false) => ({ pubkey, isWritable, isSigner });
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u128 = (n) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(n & (2n ** 64n - 1n)); b.writeBigUInt64LE(n >> 64n, 8); return b; };
const tickArray = (pool, tick, spacing) => { const span = 88 * spacing; const start = Math.floor(tick / span) * span; return PublicKey.findProgramAddressSync([Buffer.from("tick_array"), pool.toBuffer(), Buffer.from(`${start}`)], W)[0]; };
const many = async (keys) => { const out = []; for (let i = 0; i < keys.length; i += 100) out.push(...(await conn.getMultipleAccountsInfo(keys.slice(i, i + 100)))); return out; };

async function send(label, batches) {
  const before = await conn.getBalance(me);
  let ok = 0;
  for (const [i, ixs] of batches.entries()) {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }), ...ixs.ixs);
    tx.feePayer = me;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    const signers = [house, ...(ixs.signers ?? [])];
    if (!SEND) {
      if (i < 3) {
        tx.sign(...signers);
        const s = await conn.simulateTransaction(tx);
        console.log(`  ${label} ${i + 1}: ${s.value.err ? `FAILS ${JSON.stringify(s.value.err)} ${(s.value.logs ?? []).slice(-2).join(" | ")}` : "ok"}`);
      }
      continue;
    }
    try {
      await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
      ok++;
    } catch (e) {
      console.log(`  ${label} ${i + 1} failed: ${(e.transactionLogs ?? []).slice(-1)[0] ?? e.message.slice(0, 160)}`);
    }
  }
  if (SEND) console.log(`${label}: ${ok}/${batches.length} done, house SOL ${(before / 1e9).toFixed(4)} -> ${((await conn.getBalance(me)) / 1e9).toFixed(4)}`);
}

// ---- 1) Orca positions: withdraw everything, then close ----
const t22 = await conn.getParsedTokenAccountsByOwner(me, { programId: TOKEN_2022_PROGRAM_ID });
const nfts = t22.value.filter((a) => a.account.data.parsed.info.tokenAmount.decimals === 0 && a.account.data.parsed.info.tokenAmount.amount === "1");
const posKeys = nfts.map((a) => PublicKey.findProgramAddressSync([Buffer.from("position"), new PublicKey(a.account.data.parsed.info.mint).toBuffer()], W)[0]);
const posInfos = await many(posKeys);
const live = nfts.map((a, i) => ({ nft: a, key: posKeys[i], info: posInfos[i] })).filter((x) => x.info?.owner.equals(W));
const poolKeys = [...new Set(live.map((x) => new PublicKey(x.info.data.subarray(8, 40)).toBase58()))].map((k) => new PublicKey(k));
const poolInfos = new Map((await many(poolKeys)).map((a, i) => [poolKeys[i].toBase58(), a]));
const mintKeys = [...new Set([...poolInfos.values()].flatMap((d) => [new PublicKey(d.data.subarray(101, 133)).toBase58(), new PublicKey(d.data.subarray(181, 213)).toBase58()]))].map((k) => new PublicKey(k));
const mintProg = new Map((await many(mintKeys)).map((a, i) => [mintKeys[i].toBase58(), a.owner]));
let rentBack = 0;
const posBatches = live.map((x) => {
  const d = x.info.data;
  const pool = new PublicKey(d.subarray(8, 40));
  const positionMint = new PublicKey(d.subarray(40, 72));
  const liquidity = d.readBigUInt64LE(72) + (d.readBigUInt64LE(80) << 64n);
  const lower = d.readInt32LE(88), upper = d.readInt32LE(92);
  const p = poolInfos.get(pool.toBase58()).data;
  const spacing = p.readUInt16LE(41);
  const mintA = new PublicKey(p.subarray(101, 133)), vaultA = new PublicKey(p.subarray(133, 165));
  const mintB = new PublicKey(p.subarray(181, 213)), vaultB = new PublicKey(p.subarray(213, 245));
  const progA = mintProg.get(mintA.toBase58()), progB = mintProg.get(mintB.toBase58());
  const ownerA = getAssociatedTokenAddressSync(mintA, me, false, progA), ownerB = getAssociatedTokenAddressSync(mintB, me, false, progB);
  const posAta = new PublicKey(x.nft.pubkey);
  rentBack += x.info.lamports + x.nft.account.lamports;
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(me, ownerA, me, mintA, progA), createAssociatedTokenAccountIdempotentInstruction(me, ownerB, me, mintB, progB)];
  if (liquidity > 0n) ixs.push(new TransactionInstruction({ programId: W, keys: [
    m(pool, true), m(progA, false), m(progB, false), m(MEMO, false), m(me, false, true), m(x.key, true), m(posAta, false), m(mintA, false), m(mintB, false),
    m(ownerA, true), m(ownerB, true), m(vaultA, true), m(vaultB, true), m(tickArray(pool, lower, spacing), true), m(tickArray(pool, upper, spacing), true),
  ], data: Buffer.concat([Buffer.from([58, 127, 188, 62, 79, 82, 196, 96]), u128(liquidity), u64(0n), u64(0n), Buffer.from([0])]) }));
  // fees the withdraw just settled into the position must be collected, or Orca refuses to close it
  ixs.push(new TransactionInstruction({ programId: W, keys: [
    m(pool, false), m(me, false, true), m(x.key, true), m(posAta, false), m(mintA, false), m(mintB, false),
    m(ownerA, true), m(vaultA, true), m(ownerB, true), m(vaultB, true), m(progA, false), m(progB, false), m(MEMO, false),
  ], data: Buffer.from([207, 117, 95, 191, 229, 180, 226, 15, 0]) }));
  ixs.push(new TransactionInstruction({ programId: W, keys: [m(me, false, true), m(me, true), m(x.key, true), m(positionMint, true), m(posAta, true), m(TOKEN_2022_PROGRAM_ID, false)], data: Buffer.from([1, 182, 135, 59, 155, 25, 99, 223]) }));
  return { ixs };
});
console.log(`Orca positions: ${live.length} in ${poolKeys.length} pools; closing returns ~${(rentBack / 1e9).toFixed(3)} SOL plus the position NFT mints' rent`);
await send("position", posBatches);

// ---- 2) empty token accounts (re-read: step 1 empties some) ----
const [a22, acl] = await Promise.all([conn.getParsedTokenAccountsByOwner(me, { programId: TOKEN_2022_PROGRAM_ID }), conn.getParsedTokenAccountsByOwner(me, { programId: TOKEN_PROGRAM_ID })]);
const empty = [...a22.value.map((a) => ({ a, prog: TOKEN_2022_PROGRAM_ID })), ...acl.value.map((a) => ({ a, prog: TOKEN_PROGRAM_ID }))].filter((x) => x.a.account.data.parsed.info.tokenAmount.amount === "0");
console.log(`empty token accounts: ${empty.length}, closing returns ~${(empty.reduce((s, x) => s + x.a.account.lamports, 0) / 1e9).toFixed(3)} SOL`);
const closeBatches = [];
for (let i = 0; i < empty.length; i += 10) closeBatches.push({ ixs: empty.slice(i, i + 10).map((x) => createCloseAccountInstruction(x.a.pubkey, me, me, [], x.prog)) });
await send("close", closeBatches);

// ---- 3) optional: sweep SOL from other keypair files into the house wallet ----
const si = process.argv.indexOf("--sweep");
if (si >= 0) {
  const files = process.argv.slice(si + 1).filter((a) => !a.startsWith("--"));
  const sweeps = [];
  for (const f of files) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f.replace(/^~/, os.homedir()), "utf8"))));
    const a = await conn.getAccountInfo(kp.publicKey);
    if (!a || !a.owner.equals(SystemProgram.programId) || a.data.length) { console.log(`  skip ${kp.publicKey.toBase58().slice(0, 8)}: not a plain wallet`); continue; }
    if (a.lamports <= 0) continue; // the house pays the fee, so the whole balance moves and nothing is left behind
    sweeps.push({ ixs: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: me, lamports: a.lamports })], signers: [kp] });
    console.log(`  sweep ${kp.publicKey.toBase58().slice(0, 8)}: ${(a.lamports / 1e9).toFixed(4)} SOL`);
  }
  await send("sweep", sweeps);
}
if (!SEND) console.log("dry run only; add --send to sign and send");
