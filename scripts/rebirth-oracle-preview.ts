// Defaults to read-only simulations. --execute sends the explicitly approved 0.001 SOL purchase,
// only after simulation advances the oracle and total fees/account rent fit the 0.005 SOL cap.
import fs from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import { loadRay, poolCtx, swapIx } from "./dn/ops";
import { WSOL, type VaultState } from "./dn/lib";

const conn = new Connection(process.env.RPC!, "confirmed");
const owner = new PublicKey("331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth");
const mint = new PublicKey("Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump");
const pool = new PublicKey("A7zB4JfJuEBZMpQLVtNAYMr1KAspaXKQEudwBxWeyz8V");
const ray = await loadRay(conn, Keypair.generate());
const ctx = await poolCtx(conn, ray, pool);
const wsolAta = getAssociatedTokenAddressSync(WSOL, owner);
const mintProgram = (await conn.getAccountInfo(mint))!.owner;
const xAta = getAssociatedTokenAddressSync(mint, owner, false, mintProgram);
const accountContext = { solPda: owner, wsolAta, xAta } as VaultState;
const obs = ctx.compute.observationId;
const ring = (await conn.getAccountInfo(obs))!.data;
const newest = (d: Buffer) => Math.max(...Array.from({length:100}, (_, i) => d.readUInt32LE(51+i*44)));
const execute = process.argv.includes("--execute");
console.log(JSON.stringify({ pool:pool.toBase58(), observation:obs.toBase58(), tickBefore:ctx.compute.tickCurrent, newestBefore:newest(ring), readOnly:!execute }));
if (execute && Math.floor(Date.now()/1000)-newest(ring)<3600) {
  console.log(JSON.stringify({skipped:true,reason:"Oracle already fresh; no purchase needed"}));
  process.exit(0);
}
for (const amount of execute ? [1000000n] : [1000n, 10000n, 100000n, 1000000n]) {
  const quote = await swapIx(conn, ctx, accountContext, WSOL, amount, 0.01);
  if (quote.minOut <= 0n) continue;
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({units:500000}),
    createAssociatedTokenAccountIdempotentInstruction(owner,wsolAta,owner,WSOL),
    createAssociatedTokenAccountIdempotentInstruction(owner,xAta,owner,mint,mintProgram),
    SystemProgram.transfer({fromPubkey:owner,toPubkey:wsolAta,lamports:amount}),
    createSyncNativeInstruction(wsolAta),quote.ix];
  const block = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:block.blockhash,instructions:ixs}).compileToV0Message());
  const sim = await conn.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true,accounts:{encoding:"base64",addresses:[obs.toBase58(),pool.toBase58()]}});
  const next = sim.value.accounts?.[0]?.data?.[0];
  const nextPool = sim.value.accounts?.[1]?.data?.[0];
  const newestAfter = next ? newest(Buffer.from(next,"base64")) : null;
  console.log(JSON.stringify({inputLamports:amount.toString(),minimumTokensRaw:quote.minOut.toString(),error:sim.value.err,units:sim.value.unitsConsumed,newestAfter,tickAfter:nextPool ? Buffer.from(nextPool,"base64").readInt32LE(269):null,advanced:!!newestAfter&&newestAfter>newest(ring),logs:sim.value.err?sim.value.logs:undefined}));
  if (execute) {
    if (sim.value.err || !newestAfter || newestAfter<=newest(ring)) throw new Error("Purchase did not pass the oracle-refresh simulation");
    if (await conn.getGenesisHash()!=="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d") throw new Error("Wrong cluster");
    const accounts=await conn.getMultipleAccountsInfo([wsolAta,xAta]);
    const rent=(accounts[0]?0:await conn.getMinimumBalanceForRentExemption(165))+(accounts[1]?0:await conn.getMinimumBalanceForRentExemption(1024));
    const fee=(await conn.getFeeForMessage(tx.message)).value;
    if (fee===null || Number(amount)+rent+fee>5000000) throw new Error("Purchase would exceed the approved total cap");
    const payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.PAYER!,"utf8"))));
    if (!payer.publicKey.equals(owner)) throw new Error("Unexpected payer");
    tx.sign([payer]);
    const signature=await conn.sendRawTransaction(tx.serialize());
    const result=await conn.confirmTransaction({signature,...block},"finalized");
    if(result.value.err) throw new Error(`Purchase failed ${signature}`);
    const landed=await conn.getTransaction(signature,{commitment:"finalized",maxSupportedTransactionVersion:0});
    const spent=landed?.meta ? landed.meta.preBalances[0]-landed.meta.postBalances[0] : null;
    console.log(JSON.stringify({signature,slot:landed?.slot,totalSpentLamports:spent,approvedCapLamports:5000000,oracleNewest:newest((await conn.getAccountInfo(obs))!.data)}));
  }
  if (!sim.value.err && newestAfter && newestAfter>newest(ring)) break;
}
