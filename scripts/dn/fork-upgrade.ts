// Upgrade a program on the surfpool fork without the loader: overwrite the programdata bytes via surfnet_setAccount.
//   bun dn/fork-upgrade.ts <program id> <path/to/program.so>
import fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const program = new PublicKey(process.argv[2]);
const so = fs.readFileSync(process.argv[3]);
const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER);
const cur = await conn.getAccountInfo(programData);
if (!cur) throw new Error("programdata not found on fork — deploy once with the CLI first");
const header = Buffer.from(cur.data.subarray(0, 45)); // [3,0,0,0] slot u64 | Option<authority>
const slot = await conn.getSlot();
header.writeBigUInt64LE(BigInt(slot), 4);
const body = Buffer.alloc(Math.max(cur.data.length - 45, so.length));
so.copy(body);
const data = Buffer.concat([header, body]);
const rpc = async (method: string, params: unknown[]) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
};
await rpc("surfnet_setAccount", [programData.toBase58(), { data: data.toString("hex") }]);
const after = await conn.getAccountInfo(programData);
console.log(`programdata ${programData.toBase58()} now ${after?.data.length} bytes, elf ${so.length} bytes, slot ${slot}`);
