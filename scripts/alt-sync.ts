// Put every account the site/keepers need into our lookup tables (opening new ones when full).
//   RPC=... bun alt-sync.ts     (authority = keeper.json)
import fs from "fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ensureAlts, globalAccounts, marketAccounts } from "./alt";
import { PROGRAM_ID, type Market } from "./lib";
import { readPool } from "./stakepool";
import { DN_PROGRAM, readVault } from "./dn/lib";
import { loadRay, poolCtx, vaultAccounts } from "./dn/ops";
const conn = new Connection(process.env.RPC!, "confirmed");
const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("keeper.json", "utf8"))));
const MEME = new PublicKey("Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump");
const res = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 1008 }] });
const ms: Market[] = [];
for (const { pubkey, account } of res) {
  const d = account.data; const pk = (o: number) => new PublicKey(d.subarray(o, o + 32));
  const pool = await conn.getAccountInfo(pk(232));
  ms.push({ key: pubkey, bullMint: pk(8), bearMint: pk(40), oraclePool: pk(104), oracleObs: pk(136), windowSecs: d.readUInt32LE(480), underlyingIsToken0: d[489], config: new PublicKey(pool!.data.subarray(72, 104)) });
}
const wanted = [...globalAccounts(await readPool(conn), MEME), ...ms.flatMap(marketAccounts)];
const vaults = await conn.getProgramAccounts(DN_PROGRAM, { filters: [{ memcmp: { offset: 0, bytes: "HoK4CZtz9b6" } }] });
const ray = await loadRay(conn, key);
for (const { pubkey } of vaults) {
  const v = await readVault(conn, pubkey);
  const ctx = await poolCtx(conn, ray, v.pool).catch(() => null);
  const extra = ctx ? [new PublicKey(ctx.poolKeys.vault.A), new PublicKey(ctx.poolKeys.vault.B), ctx.compute.observationId, v.xMint] : [v.xMint];
  wanted.push(...(await vaultAccounts(conn, v, extra)));
}
const tables = await ensureAlts(conn, key, wanted);
console.log(`markets ${ms.length} vaults ${vaults.length} wanted ${wanted.length}; tables: ${tables.map((t) => `${t.key.toBase58()} (${t.state.addresses.length})`).join(", ")}`);
