// dnvault end-to-end on the surfpool fork: create a vault on the PUMP market, deposit SOL, swap + LP the
// oracle CLMM, buy the DOWN hedge, withdraw half in kind, deposit again at NAV.
//   RPC=http://127.0.0.1:8899 bun dn/e2e.ts
import fs from "fs";
import { Buffer } from "buffer";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { RFSTACC, type Market, sideAccounts } from "../lib";
import { DN_PROGRAM, WSOL, bindPositionIx, createVaultIx, decodeMarketBits, depositIx, downHookExtras, hedgeDelta, readVault, valAccounts, valuation, withdrawIx, wrapIx, type VaultState } from "./lib";
import { dbcClient, decreaseIx, ensureAtas, hedgeBuyIxs, loadRay, openPositionIxs, poolCtx, quoteBuy, rebalanceTx, send, swapIx, vaultAccounts } from "./ops";
import { ensureAlt } from "../alt";

const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const rpcUrl = new URL(RPC);
if (rpcUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(rpcUrl.hostname)) throw new Error("dn/e2e.ts only runs on a local fork");
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(new URL("../test-payer.json", import.meta.url), "utf8"))));
const MARKET = new PublicKey(process.env.MARKET ?? "GwzRwcPYSojZiNc4tC4eoLSLD7htk3akWA7qtG68zyHh");
const MAIN_ALT = new PublicKey("HR1YvAhHBXPkhFFjp2mzaAg5ojnNUQyamU8qzTW4PK7U");
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sol = (n: bigint) => `${(Number(n) / 1e9).toFixed(6)} SOL`;
const bal = async (ata: PublicKey) => BigInt((await conn.getTokenAccountBalance(ata).catch(() => ({ value: { amount: "0" } }))).value.amount);

log("program", DN_PROGRAM.toBase58(), "payer", payer.publicKey.toBase58());
const md = await conn.getAccountInfo(MARKET);
const m = decodeMarketBits(MARKET, Buffer.from(md!.data));
const pd = Buffer.from((await conn.getAccountInfo(m.oraclePool))!.data);
const spacing = pd.readUInt16LE(235);
const mint0 = new PublicKey(pd.subarray(73, 105));
const mint1 = new PublicKey(pd.subarray(105, 137));
const xMint = m.underlyingIsToken0 ? mint0 : mint1;
const xIsT22 = (await conn.getAccountInfo(xMint))!.owner.equals(TOKEN_2022_PROGRAM_ID);
const ray = await loadRay(conn, payer);
const ctx = await poolCtx(conn, ray, m.oraclePool);
// widest range whose boundary tick arrays are already initialized: a fresh tick array costs 0.072 SOL of rent each
const starts = Object.values(ctx.tickCache as Record<string, any>).map((t: any) => Number(t.startTickIndex)).sort((a, b) => a - b);
const arraySpan = 60 * spacing;
const lower = starts[0] + Number(process.env.SHIFT ?? 0) * spacing; // SHIFT=n for a fresh PDA on a reused fork
const upper = starts[starts.length - 1] + arraySpan - spacing;
log("initialized tick arrays", starts.length, "from", starts[0], "to", starts[starts.length - 1] + arraySpan, "current tick", ctx.compute.tickCurrent);
log("market", MARKET.toBase58(), "pool", m.oraclePool.toBase58(), "x", xMint.toBase58(), "spacing", spacing, "range", lower, upper);

// 1. vault
const { ix: cv, vault } = createVaultIx(payer.publicKey, MARKET, m.oraclePool, xMint, xIsT22, m.bearMint, lower, upper, 1500, 300, 100);
if (!(await conn.getAccountInfo(vault))) log("create_vault", (await send(conn, payer, [cv], [], [], "create_vault")).sig);
let v: VaultState = await readVault(conn, vault);
log("vault", vault.toBase58(), "solPda", v.solPda.toBase58(), "xIsToken0", v.xIsToken0);
await ensureAtas(conn, payer, v);
const me = payer.publicKey;
const userShare = getAssociatedTokenAddressSync(v.shareMint, me);
const userWsol = getAssociatedTokenAddressSync(WSOL, me);
const userX = getAssociatedTokenAddressSync(xMint, me, false, v.xProgram);
const userQuote = getAssociatedTokenAddressSync(RFSTACC, me);
const userDown = getAssociatedTokenAddressSync(m.bearMint, me, false, TOKEN_2022_PROGRAM_ID);
await send(conn, payer, [
  createAssociatedTokenAccountIdempotentInstruction(me, userShare, me, v.shareMint),
  createAssociatedTokenAccountIdempotentInstruction(me, userWsol, me, WSOL),
  createAssociatedTokenAccountIdempotentInstruction(me, userX, me, xMint, v.xProgram),
  createAssociatedTokenAccountIdempotentInstruction(me, userQuote, me, RFSTACC),
  createAssociatedTokenAccountIdempotentInstruction(me, userDown, me, m.bearMint, TOKEN_2022_PROGRAM_ID),
], [], [], "user atas");

// 2. deposit
const DEP = 2n * BigInt(LAMPORTS_PER_SOL);
log("deposit", (await send(conn, payer, [depositIx(me, v, await valAccounts(conn, v), DEP)], [], [], "deposit")).sig);
let shares = await bal(userShare);
let x = await valuation(conn, v);
log(`shares ${shares}  nav ${sol(x.nav)}  free ${sol(x.free)}`);
if (shares !== DEP) throw new Error(`first deposit should mint 1:1, got ${shares}`);

// tables
const mainAlt = (await conn.getAddressLookupTable(MAIN_ALT)).value!;
const altKey = await ensureAlt(conn, payer, null, await vaultAccounts(conn, v, [new PublicKey(ctx.poolKeys.vault.A), new PublicKey(ctx.poolKeys.vault.B), ctx.compute.observationId, new PublicKey(ctx.poolInfo.mintA.address), new PublicKey(ctx.poolInfo.mintB.address)]));
await new Promise((resolve) => setTimeout(resolve, 1500));
const alt = (await conn.getAddressLookupTable(altKey)).value!;
const tables = [...(mainAlt ? [mainAlt] : []), alt];

// 3. wrap + swap half to X + buy the hedge, all in one tx (settle refuses unhedged exposure)
const deploy = (DEP * 95n) / 100n;
const half = deploy / 2n;
const sw = await swapIx(conn, ctx, v, WSOL, half);
const dbc = await dbcClient(conn);
const est = { ...(await valuation(conn, v)), dStar: half / 100n, held: 0n };
const want = hedgeDelta(est);
log("hedge estimate: D*", sol(est.dStar), "DOWN tokens", want.toString(), "pot", est.pot.toString(), "circ", est.circulating.toString());
const q = await quoteBuy(dbc, m.poolBear, want, est.dStar * 2n + 2_000_000n);
log("hedge quote: budget", sol(q.budget), "r-fstacc -> tokens", q.out.toString(), "min", q.min.toString());
const buy = await hedgeBuyIxs(conn, dbc, v, m.poolBear, q.budget, q.min, me);
log("swap+hedge", (await rebalanceTx(conn, payer, v, [sw.ix, ...buy], [wrapIx(v, deploy)], [], [], tables, "wrap+swap+hedge")).sig, "minOut", sw.minOut.toString());
x = await valuation(conn, v);
log(`after swap+hedge: nav ${sol(x.nav)}  wsol ${x.wsol}  x ${x.xRaw}  xVal ${sol(x.xVal)}  D ${sol(x.d)}  D* ${sol(x.dStar)}  err ${x.errBps} bps  held ${x.held}`);
if (x.errBps > 1500n) throw new Error(`hedge outside band after first hedge: ${x.errBps} bps`);

// 4. open position with everything in WSOL/X (exposure unchanged, so no hedge move needed)
v = await readVault(conn, vault);
const aIsWsol = ctx.poolInfo.mintA.address === WSOL.toBase58();
const [amtA, amtB] = aIsWsol ? [await bal(v.wsolAta), await bal(v.xAta)] : [await bal(v.xAta), await bal(v.wsolAta)];
const op = await openPositionIxs(ctx, v, me, amtA, amtB);
const clmmIxs = op.instructions.filter((i) => i.programId.toBase58() === ctx.poolInfo.programId);
log("open keys[0..3]", clmmIxs[0].keys.slice(0, 3).map((k) => `${k.pubkey.toBase58().slice(0, 6)}${k.isSigner ? "(s)" : ""}${k.isWritable ? "(w)" : ""}`).join(" "));
const otherIxs = op.instructions.filter((i) => i.programId.toBase58() !== ctx.poolInfo.programId);
const addr: any = op.address;
log("open position: liquidity", op.liquidity.toString(), "nft", addr.nftMint.toBase58(), "pre-ixs", otherIxs.length, "clmm-ixs", clmmIxs.length);
log("open", (await rebalanceTx(conn, payer, v, clmmIxs, otherIxs, [bindPositionIx(v, addr.personalPosition, addr.positionNftAccount)], op.signers, tables, "open position", addr.personalPosition)).sig);
v = await readVault(conn, vault);
x = await valuation(conn, v);
log(`after LP: position ${v.position?.toBase58()}  nav ${sol(x.nav)}  xTotal ${x.xTotal}  xVal ${sol(x.xVal)}  solPos ${sol(x.solPos)}  D* ${sol(x.dStar)}  D ${sol(x.d)}  err ${x.errBps} bps`);

// 5. top-up hedge if drifted
if (x.errBps > BigInt(v.bandBps)) {
  const t = hedgeDelta(x);
  log("re-hedge: tokens", t.toString());
  if (t > 0n) {
    const q2 = await quoteBuy(dbc, m.poolBear, t, x.dStar + 2_000_000n);
    const buy2 = await hedgeBuyIxs(conn, dbc, v, m.poolBear, q2.budget, q2.min, me);
    log("re-hedge", (await rebalanceTx(conn, payer, v, buy2, [], [], [], tables, "re-hedge")).sig);
    x = await valuation(conn, v);
    log(`after re-hedge: D ${sol(x.d)}  D* ${sol(x.dStar)}  err ${x.errBps} bps`);
  }
}

// 6. withdraw half in kind
const before = { sol: BigInt(await conn.getBalance(me)), x: await bal(userX), down: await bal(userDown), wsol: await bal(userWsol), q: await bal(userQuote) };
const decimals = (await conn.getAccountInfo(m.bearMint))!.data[44];
const extras = await downHookExtras(conn, v, userDown, 1n, decimals);
const dec = await decreaseIx(conn, ctx, v, 1n, aIsWsol ? userWsol : userX, aIsWsol ? userX : userWsol);
dec.keys = dec.keys.map((k) => (k.pubkey.equals(v.solPda) ? { ...k, isSigner: false } : k));
const halfShares = shares / 2n;
log("withdraw", (await send(conn, payer, [withdrawIx(me, v, await valAccounts(conn, v), halfShares, extras, dec)], [], tables, "withdraw")).sig);
const after = { sol: BigInt(await conn.getBalance(me)), x: await bal(userX), down: await bal(userDown), wsol: await bal(userWsol), q: await bal(userQuote) };
log(`got: sol ${sol(after.sol - before.sol)} (incl. fee)  wsol ${after.wsol - before.wsol}  x ${after.x - before.x}  down ${after.down - before.down}  quote ${after.q - before.q}`);
shares = await bal(userShare);
x = await valuation(conn, v);
log(`vault after withdraw: nav ${sol(x.nav)}  shares left ${shares}  err ${x.errBps} bps`);

// 7. deposit again at NAV
const navBefore = x.nav;
const supplyBefore = shares;
log("deposit2", (await send(conn, payer, [depositIx(me, v, await valAccounts(conn, v), 500_000_000n)], [], tables, "deposit2")).sig);
const minted = (await bal(userShare)) - supplyBefore;
const expect = (500_000_000n * supplyBefore) / navBefore;
log(`deposit2 minted ${minted} (expected ~${expect})`);
if (minted < (expect * 99n) / 100n || minted > (expect * 101n) / 100n) throw new Error("NAV-based mint off");
log("ALL PASS");
