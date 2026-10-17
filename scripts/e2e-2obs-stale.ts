// 2-obs markets on a stale Raydium ring, on a surfpool mainnet fork: the deployed program samples the pool's live tick (a
// pushed tick is the whole TWAP at window 1), the patched one keeps reading the ring and waits for its next observation.
//
//   surfpool start --port 8929 --ws-port 8930 --rpc-url <mainnet rpc> --no-deploy --yes --no-tui --no-studio --disable-instruction-profiling
//   RPC=http://127.0.0.1:8929 NEW_SO=<patched hooked.so> bun e2e-2obs-stale.ts
//
// Env: MARKET (default the window-1 WBTC market V7Uggt…) | LONG_MARKET (a window-3960 market on the same ring, default 33HifK…)
//      PAYER (default test-payer.json) | NEW_SO (required: the patched binary; the fork is upgraded to it through the loader,
//      after the payer is written in as the fork's upgrade authority — never run against anything but a local fork).
//
// A (deployed program): consume the newest ring point -> warp past RING_STALE_SECS -> push the pool tick +100 (setAccount, i.e. a
//   push that does not write the ring) -> poke with the pool: the loser vault pays ~63 %. State is restored afterwards.
// upgrade -> B (patched): poke stale = no move; push + poke = no move; a buy through the hook still works and moves nothing;
//   create_market refuses window 1 on a stale ring or a non-CLMM kind (0x1022) but not window 3960; the window-3960 market on
//   the same ring still samples; the ring stores a new observation (tick +50 over the gap) -> poke catches up in one step.
import fs from "fs";
import os from "os";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { PROGRAM_ID, RFSTACC, type Market, createMarketIx, marketPda, pokeIx, send, sideAccounts } from "./lib";
import { depositSolIx, readPool } from "./stakepool";

const RPC = process.env.RPC ?? "http://127.0.0.1:8929";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(RPC)) throw new Error(`refusing to run against ${RPC}: local forks only`);
const NEW_SO = process.env.NEW_SO;
if (!NEW_SO || !fs.existsSync(NEW_SO)) throw new Error("NEW_SO=<patched hooked.so> is required");
const conn = new Connection(RPC, "confirmed");
const payerPath = (process.env.PAYER ?? "test-payer.json").replace("~", os.homedir());
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(payerPath, "utf8"))));
const MARKET = new PublicKey(process.env.MARKET ?? "V7Uggt9sqD3o3yBxsfcKZ43H99cKQTka5gznmFFRUCR");
const LONG_MARKET = new PublicKey(process.env.LONG_MARKET ?? "33HifKMSbX7CVyQCh292KrYzGNG2MDEbHcFv1xim59ka");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const RING_STALE_SECS = 3600;
const TWO_OBS_NEEDS_LIVE_RING = 0x1022;
const POOL_TICK = 269;

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
  return ok;
};
const log = (...a: unknown[]) => console.log("      ", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const data = async (k: PublicKey) => Buffer.from((await conn.getAccountInfo(k))!.data);
const setData = (k: PublicKey, d: Buffer) => rpc("surfnet_setAccount", [k.toBase58(), { data: d.toString("hex") }]);
async function chainNow() {
  return Number((await data(SYSVAR_CLOCK_PUBKEY)).readBigInt64LE(32));
}
async function warp(secs: number) {
  const t0 = await chainNow();
  await rpc("surfnet_timeTravel", [{ absoluteTimestamp: (t0 + secs) * 1000 }]);
  for (let i = 0; i < 40 && (await chainNow()) < t0 + secs; i++) await sleep(250);
  if ((await chainNow()) < t0 + secs) throw new Error("surfnet_timeTravel did not move the clock");
}

// ---- market / ring / pool views ----
const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32));
async function loadMarket(key: PublicKey): Promise<Market & { vaultBull: PublicKey; vaultBear: PublicKey; poolBull: PublicKey }> {
  const d = await data(key);
  const poolBull = pk(d, 232);
  const config = pk(await data(poolBull), 72);
  return {
    key, bullMint: pk(d, 8), bearMint: pk(d, 40), oraclePool: pk(d, 104), oracleObs: pk(d, 136), windowSecs: d.readUInt32LE(480),
    underlyingIsToken0: d[489], config, oracleKind: d[493], vaultBull: pk(d, 168), vaultBear: pk(d, 200), poolBull,
  };
}
type Snap = { twap: bigint; lastObs: number; keepBull: bigint; keepBear: bigint; ckptHead: number; bull: bigint; bear: bigint };
async function snap(m: Awaited<ReturnType<typeof loadMarket>>): Promise<Snap> {
  const d = await data(m.key);
  const amt = async (k: PublicKey) => (await data(k)).readBigUInt64LE(64);
  return {
    twap: d.readBigInt64LE(424), keepBull: d.readBigUInt64LE(432), keepBear: d.readBigUInt64LE(440), lastObs: d.readUInt32LE(484),
    ckptHead: d[492], bull: await amt(m.vaultBull), bear: await amt(m.vaultBear),
  };
}
const same = (a: Snap, b: Snap) => JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v)) === JSON.stringify(b, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const fmt = (s: Snap) => `twap tick ${Number(s.twap) / 2 ** 32} | last_obs ${s.lastObs} | ckpt_head ${s.ckptHead} | vaults UP ${s.bull} DOWN ${s.bear}`;
async function ringLatest(obs: PublicKey) {
  const d = await data(obs);
  const idx = d.readUInt16LE(17);
  return { d, idx, ts: d.readUInt32LE(51 + idx * 44), tc: d.readBigInt64LE(51 + idx * 44 + 4) };
}
async function setTick(pool: PublicKey, tick: number) {
  const d = await data(pool);
  d.writeInt32LE(tick, POOL_TICK);
  await setData(pool, d);
}
async function setVault(k: PublicKey, amount: bigint) {
  const d = await data(k);
  d.writeBigUInt64LE(amount, 64);
  await setData(k, d);
}
const poke = (m: Market) => send(conn, new Transaction().add(pokeIx(m)), [payer]);
/** 1 - keep for a Q32 TWAP move at 100x, as the program's loss_amount sees it. */
const lossOf = (duQ32: bigint) => 1 - Math.pow(1.0001, (-100 * Math.abs(Number(duQ32))) / 2 ** 32);

/** create_market with only the accounts the 2-obs guard looks at made real; everything after it is junk on purpose. */
async function simulateCreate(m: Market, window: number, kind: number) {
  const bull = Keypair.generate().publicKey;
  const bear = Keypair.generate().publicKey;
  const fake: Market = { ...m, bullMint: bull, bearMint: bear, windowSecs: window, oracleKind: kind, venuePool: m.oraclePool };
  fake.key = marketPda(bull, bear, m.oracleObs, window, m.underlyingIsToken0);
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [createMarketIx(payer.publicKey, fake)] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const r = await conn.simulateTransaction(tx, { sigVerify: false });
  const err: any = r.value.err;
  const custom = err?.InstructionError?.[1]?.Custom as number | undefined;
  return { custom, err: JSON.stringify(err) };
}

async function buyUp(m: Awaited<ReturnType<typeof loadMarket>>) {
  const dbc = DynamicBondingCurveClient.create(conn, "confirmed");
  const a = sideAccounts(m, 0);
  const quoteAta = getAssociatedTokenAddressSync(RFSTACC, payer.publicKey);
  const upAta = getAssociatedTokenAddressSync(m.bullMint, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const sp = await readPool(conn);
  const budget = 10_000_000n;
  const sdk = await dbc.pool.swap2WithTransferHook({
    owner: payer.publicKey, pool: a.pool, swapBaseForQuote: false, referralTokenAccount: null, payer: payer.publicKey,
    swapMode: SwapMode.ExactIn, amountIn: new BN(budget.toString()), minimumAmountOut: new BN(0),
  });
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, quoteAta, payer.publicKey, RFSTACC),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, upAta, payer.publicKey, m.bullMint, TOKEN_2022_PROGRAM_ID),
    depositSolIx(sp, payer.publicKey, quoteAta, (budget * 1010n) / 1000n + 10_000n),
    ...sdk.instructions.filter((i: TransactionInstruction) => i.programId.toBase58().startsWith("dbcij")),
  );
  const r = await send(conn, tx, [payer]);
  return { ...r, hookRan: r.logs.some((l) => l.includes(`Program ${PROGRAM_ID.toBase58()} invoke`)) };
}

async function upgradeFork() {
  const [programData] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER);
  const pd = await data(programData);
  // ProgramData: tag u32 = 3 | slot u64 | Option<Pubkey> authority (1 + 32) | ELF
  pd[12] = 1;
  payer.publicKey.toBuffer().copy(pd, 13);
  await setData(programData, pd);
  const elf = fs.readFileSync(NEW_SO!);
  // as scripts/deploy-mainnet.sh: grow the program data first, by at least the loader's 10240-byte minimum
  const grow = elf.length - (pd.length - 45);
  if (grow > 0) {
    const e = Bun.spawnSync(["solana", "program", "extend", PROGRAM_ID.toBase58(), String(Math.max(grow + 4096, 10240)), "-k", payerPath, "-u", RPC], { stdout: "pipe", stderr: "pipe" });
    log(`extend: ${`${e.stdout}${e.stderr}`.trim().split("\n").pop()}`);
  }
  const p = Bun.spawnSync(
    ["solana", "program", "deploy", NEW_SO!, "--program-id", PROGRAM_ID.toBase58(), "--upgrade-authority", payerPath, "-k", payerPath, "-u", RPC, "--use-rpc"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = `${p.stdout}${p.stderr}`.trim();
  log(out.split("\n").slice(-3).join(" | "));
  const after = await data(programData);
  return p.exitCode === 0 && after.subarray(45, 45 + elf.length).equals(elf);
}

async function main() {
  const progInfo = await conn.getAccountInfo(PROGRAM_ID);
  if (!check("program present on fork", !!progInfo?.executable)) process.exit(1);
  await rpc("surfnet_setAccount", [payer.publicKey.toBase58(), { lamports: 100_000_000_000 }]);

  const m = await loadMarket(MARKET);
  const long = await loadMarket(LONG_MARKET);
  check("market is a window-1 Raydium CLMM market", m.windowSecs === 1 && m.oracleKind === 0, `window ${m.windowSecs} kind ${m.oracleKind}`);
  check("long market shares its ring", long.oracleObs.equals(m.oracleObs) && long.windowSecs >= 150, `window ${long.windowSecs}`);
  const POT = 100_000_000_000n; // 100 r-fstacc per side before the catch-up poke, so a payout is visible
  for (const v of [m.vaultBull, m.vaultBear]) await setVault(v, POT);

  // ---------------- A: the deployed program ----------------
  console.log("\n== A: deployed program ==");
  await poke(m); // consume the ring's newest stored point so last_twap is current
  const a0 = await snap(m);
  const ring0 = await ringLatest(m.oracleObs);
  const tick0 = (await data(m.oraclePool)).readInt32LE(POOL_TICK);
  log(`after catch-up poke: ${fmt(a0)} | ring newest ${ring0.ts} | pool tick ${tick0}`);
  check("market consumed the ring's newest point", a0.lastObs === ring0.ts);
  await warp(RING_STALE_SECS + 100);
  const nowA = await chainNow();
  check("ring is stale", ring0.ts + RING_STALE_SECS < nowA, `${nowA - ring0.ts}s since the last observation`);
  const createA = await simulateCreate(m, 1, 0);
  check("deployed: create_market window 1 on the stale ring gets past the oracle check", createA.custom !== TWO_OBS_NEEDS_LIVE_RING, createA.err);

  const saved = await Promise.all([m.key, m.vaultBull, m.vaultBear].map(data));
  await setTick(m.oraclePool, tick0 + 100); // +100 ticks ~ a 1 % push that leaves no ring observation
  await poke(m);
  const a1 = await snap(m);
  const [moved, loserPot] = a0.bull > a1.bull ? [a0.bull - a1.bull, a0.bull] : [a0.bear - a1.bear, a0.bear];
  log(`after push + poke: ${fmt(a1)}`);
  check("deployed: the sampled read hands the TWAP to the pushed tick", Number(a1.twap >> 32n) === tick0 + 100, `twap tick ${Number(a1.twap) / 2 ** 32}`);
  check("deployed: the losing pot pays out", moved > 0n, `${moved} of ${loserPot} (${((Number(moved) / Number(loserPot)) * 100).toFixed(1)} %, ${(lossOf(a1.twap - a0.twap) * 100).toFixed(1)} % expected)`);
  await Promise.all([m.key, m.vaultBull, m.vaultBear].map((k, i) => setData(k, saved[i])));
  await setTick(m.oraclePool, tick0);
  check("A state restored", same(await snap(m), a0));

  // ---------------- upgrade ----------------
  console.log("\n== upgrade the fork to the patched binary ==");
  if (!check("loader upgrade landed", await upgradeFork())) process.exit(1);

  // ---------------- B: the patched program ----------------
  console.log("\n== B: patched program ==");
  await poke(m);
  check("patched: poke on the stale ring moves nothing", same(await snap(m), a0));
  await setTick(m.oraclePool, tick0 + 100);
  await poke(m);
  const b1 = await snap(m);
  check("patched: push + poke moves nothing (no sample, no checkpoint)", same(b1, a0), fmt(b1));
  const buy = await buyUp(m);
  check("patched: a buy through the hook still lands while frozen", buy.hookRan, `${buy.sig.slice(0, 16)}… cu ${buy.cu}`);
  check("patched: ... and moves nothing", same(await snap(m), a0));

  const c1 = await simulateCreate(m, 1, 0);
  check("patched: create_market window 1 on a stale ring -> TwoObsNeedsLiveRing", c1.custom === TWO_OBS_NEEDS_LIVE_RING, c1.err);
  const c2 = await simulateCreate(m, 1, 1);
  check("patched: create_market window 1 kind 1 (PumpSwap) -> TwoObsNeedsLiveRing", c2.custom === TWO_OBS_NEEDS_LIVE_RING, c2.err);
  const c3 = await simulateCreate(m, 3960, 0);
  check("patched: create_market window 3960 on the stale ring gets past the oracle check", c3.custom !== TWO_OBS_NEEDS_LIVE_RING, c3.err);

  const l0 = await snap(long);
  await poke(long);
  const l1 = await snap(long);
  const nowB = await chainNow();
  check("patched: the window-3960 market on the same ring still samples", l1.lastObs > ring0.ts && l1.lastObs <= nowB && l1.lastObs !== l0.lastObs, `last_obs ${l0.lastObs} -> ${l1.lastObs}, now ${nowB}`);

  // resume: the ring stores a new observation; Raydium integrates the tick held over the gap (here 50 above the last TWAP)
  await setTick(m.oraclePool, tick0);
  const held = Number(a0.twap >> 32n) + 50;
  const r = await ringLatest(m.oracleObs);
  const ts = await chainNow();
  const ni = (r.idx + 1) % 100;
  r.d.writeUInt32LE(ts, 51 + ni * 44);
  r.d.writeBigInt64LE(r.tc + BigInt(held) * BigInt(ts - r.ts), 51 + ni * 44 + 4);
  r.d.writeUInt16LE(ni, 17);
  await setData(m.oracleObs, r.d);
  await poke(m);
  const b2 = await snap(m);
  const du = b2.twap - a0.twap;
  const [paid, pot] = a0.bull > b2.bull ? [a0.bull - b2.bull, a0.bull] : [a0.bear - b2.bear, a0.bear];
  const want = lossOf(du) * Number(pot);
  log(`after the ring writes: ${fmt(b2)}`);
  check("patched: resumes on the new stored observation", b2.lastObs === ts && Number(b2.twap >> 32n) === held, `twap tick ${Number(b2.twap) / 2 ** 32}`);
  check("patched: catches up the whole move in one step", Math.abs(Number(paid) - want) / want < 1e-3, `${paid} paid, ${want.toFixed(0)} expected`);

  console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
