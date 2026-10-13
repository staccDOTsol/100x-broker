// Creates/extends the site lookup table with the global accounts + every live market. Idempotent.
//   RPC=... bun create-alt.ts            (authority/payer = keeper.json, address saved in alt.json)
import { readFileSync, writeFileSync, existsSync } from "fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { type Market, PROGRAM_ID } from "./lib";
import { readPool } from "./stakepool";
import { ensureAlt, globalAccounts, marketAccounts } from "./alt";

const conn = new Connection(process.env.RPC ?? "https://mainnet.helius-rpc.com/?api-key=f5f1e120-3a60-4e11-a9ed-2b91856e664a", "confirmed");
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.KEEPER_KEY_FILE ?? "keeper.json", "utf8"))));
const MEME = new PublicKey(process.env.MEME_MINT ?? "Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump");
const existing = existsSync("alt.json") ? new PublicKey(JSON.parse(readFileSync("alt.json", "utf8")).address) : null;

const res = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 1008 }] });
const markets: Market[] = [];
for (const { pubkey, account } of res) {
  const d = account.data;
  const pk = (o: number) => new PublicKey(d.subarray(o, o + 32));
  const pool = await conn.getAccountInfo(pk(232));
  markets.push({ key: pubkey, bullMint: pk(8), bearMint: pk(40), oraclePool: pk(104), oracleObs: pk(136), windowSecs: d.readUInt32LE(480), underlyingIsToken0: d.readUInt8(489), config: new PublicKey(pool!.data.subarray(72, 104)) });
}
console.log(`${markets.length} markets, authority ${authority.publicKey.toBase58()}, existing table ${existing?.toBase58() ?? "none"}`);
const wanted = [...globalAccounts(await readPool(conn), MEME), ...markets.flatMap(marketAccounts)];
const addr = await ensureAlt(conn, authority, existing, wanted);
writeFileSync("alt.json", JSON.stringify({ address: addr.toBase58() }, null, 2));
const table = (await conn.getAddressLookupTable(addr)).value!;
console.log(`lookup table ${addr.toBase58()} holds ${table.state.addresses.length} accounts`);
