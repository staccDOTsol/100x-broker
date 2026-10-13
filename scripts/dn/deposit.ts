// Deposit SOL into a dnvault and receive receipt shares.
//   RPC=... PAYER=~/hooked.json bun dn/deposit.ts <vault> <sol>
import fs from "fs";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { depositIx, readVault, valAccounts, valuation } from "./lib";
import { send } from "./ops";

const RPC = process.env.RPC ?? "https://mainnet.helius-rpc.com/?api-key=f5f1e120-3a60-4e11-a9ed-2b91856e664a";
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync((process.env.PAYER ?? "~/hooked.json").replace(/^~/, process.env.HOME!), "utf8"))));
const vault = new PublicKey(process.argv[2]);
const lamports = BigInt(Math.round(Number(process.argv[3]) * LAMPORTS_PER_SOL));
const v = await readVault(conn, vault);
const before = await valuation(conn, v);
const share = getAssociatedTokenAddressSync(v.shareMint, payer.publicKey);
const ixs = [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, share, payer.publicKey, v.shareMint), depositIx(payer.publicKey, v, await valAccounts(conn, v), lamports)];
const r = await send(conn, payer, ixs, [], [], "deposit");
const bal = await conn.getTokenAccountBalance(share);
const after = await valuation(conn, v);
console.log(`deposited ${Number(lamports) / 1e9} SOL -> ${bal.value.uiAmountString} shares  (nav ${Number(before.nav) / 1e9} -> ${Number(after.nav) / 1e9} SOL)  ${r.sig}`);
