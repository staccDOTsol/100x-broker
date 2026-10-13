// Create a dnvault on a 100x market over the widest already-initialized tick range of its oracle CLMM pool,
// create its token accounts, and put every account it touches into the site lookup table.
//   RPC=... PAYER=~/hooked.json ALT_AUTHORITY=keeper.json bun dn/create-vault.ts <market> [bandBps=1500] [maxLossBps=300] [keeperBps=100]
import fs from "fs";
import { Buffer } from "buffer";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createVaultIx, decodeMarketBits, readVault, valuation, vaultPda } from "./lib";
import { ensureAtas, loadRay, poolCtx, send, vaultAlt } from "./ops";

const RPC = process.env.RPC ?? "https://mainnet.helius-rpc.com/?api-key=REDACTED";
const conn = new Connection(RPC, "confirmed");
const key = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p.replace(/^~/, process.env.HOME!), "utf8"))));
const payer = key(process.env.PAYER ?? "~/hooked.json");
const altAuthority = key(process.env.ALT_AUTHORITY ?? "keeper.json");
const MARKET = new PublicKey(process.argv[2]);
const [bandBps, maxLossBps, keeperBps] = [Number(process.argv[3] ?? 1500), Number(process.argv[4] ?? 300), Number(process.argv[5] ?? 100)];

const m = decodeMarketBits(MARKET, Buffer.from((await conn.getAccountInfo(MARKET))!.data));
const pd = Buffer.from((await conn.getAccountInfo(m.oraclePool))!.data);
const spacing = pd.readUInt16LE(235);
const xMint = m.underlyingIsToken0 ? new PublicKey(pd.subarray(73, 105)) : new PublicKey(pd.subarray(105, 137));
const xIsT22 = (await conn.getAccountInfo(xMint))!.owner.equals(TOKEN_2022_PROGRAM_ID);
const ray = await loadRay(conn, payer);
const ctx = await poolCtx(conn, ray, m.oraclePool);
const starts = Object.values(ctx.tickCache as Record<string, any>).map((t: any) => Number(t.startTickIndex)).sort((a, b) => a - b);
const lower = starts[0];
const upper = starts[starts.length - 1] + 60 * spacing - spacing;
console.log(`market ${MARKET.toBase58()} pool ${m.oraclePool.toBase58()} x ${xMint.toBase58()} (${xIsT22 ? "Token-2022" : "SPL"}) spacing ${spacing}`);
console.log(`range ${lower}..${upper} (${starts.length} live tick arrays, current tick ${ctx.compute.tickCurrent}) band ${bandBps} maxLoss ${maxLossBps} keeper ${keeperBps} bps`);
const vault = vaultPda(MARKET, lower, upper);
if (!(await conn.getAccountInfo(vault))) {
  const { ix } = createVaultIx(payer.publicKey, MARKET, m.oraclePool, xMint, xIsT22, m.bearMint, lower, upper, bandBps, maxLossBps, keeperBps);
  console.log("create_vault", (await send(conn, payer, [ix], [], [], "create_vault")).sig);
}
const v = await readVault(conn, vault);
await ensureAtas(conn, payer, v);
const alts = await vaultAlt(conn, altAuthority, null, v, [new PublicKey(ctx.poolKeys.vault.A), new PublicKey(ctx.poolKeys.vault.B), ctx.compute.observationId, xMint]);
const x = await valuation(conn, v);
console.log(`vault ${vault.toBase58()}\nshares ${v.shareMint.toBase58()}\nsol pda ${v.solPda.toBase58()}\nalts ${alts.map((a) => `${a.key.toBase58().slice(0, 6)}(${a.state.addresses.length})`).join(" ")}\nnav ${Number(x.nav) / 1e9} SOL`);
