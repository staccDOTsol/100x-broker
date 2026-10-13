// Unsigned mainnet simulation of the 0/20 leg for a wallet: SOL -> USDC via Jupiter, then Backable `fund`. Run: bun tools/sim-020.ts <wallet> <lamports>
import { PublicKey } from "@solana/web3.js";
import { conn, toV0 } from "../src/lib/chain";
import { backIxs } from "../src/lib/backable";
import { cu } from "../src/lib/hooked";
const user = new PublicKey(process.argv[2] ?? "331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth");
const lamports = BigInt(process.argv[3] ?? "1000000");
const b = await backIxs(user, lamports);
console.log("usdc to fund:", Number(b.usdc) / 1e6, "ixs:", b.ixs.length, "tables:", b.tables.length);
const tx = await toV0([cu(600_000), ...b.ixs], user, b.tables);
console.log("tx bytes:", tx.serialize().length);
const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
console.log("err:", JSON.stringify(sim.value.err), "cu:", sim.value.unitsConsumed);
for (const l of sim.value.logs ?? []) if (/Instruction:|failed|Error|error|success \[1\]|invoke \[1\]/.test(l)) console.log(" ", l.slice(0, 160));
