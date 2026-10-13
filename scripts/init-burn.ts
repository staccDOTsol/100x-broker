// Creates the global burn pot (PDA token account + state). Idempotent.
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import { burnStatePda, burnVaultPda, cu, initBurnIx, send } from "./lib";
const conn = new Connection(process.env.RPC ?? "http://127.0.0.1:8899", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync((process.env.PAYER ?? "test-payer.json").replace("~", os.homedir()), "utf8"))));
const existing = await conn.getAccountInfo(burnStatePda());
if (existing) console.log("burn pot exists", burnVaultPda().toBase58());
else {
  const r = await send(conn, new Transaction().add(cu(200_000), initBurnIx(payer.publicKey)), [payer]);
  console.log("burn pot created", burnVaultPda().toBase58(), r.sig);
}
