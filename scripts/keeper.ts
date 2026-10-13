// The keeper: every LOOP_MS it does the chores anyone could do and keeps the 3% on burns.
//   1. burn: buy $100X on pump.fun (PumpPortal, pre/post-grad), burn it against the pot, cash the bounty to SOL
//   2. per market: make the pots pay (poke), collect owed price (settle), sweep fees (claim)
//   3. sweep: the dev fee share (r-fstacc, delegated to the keeper) -> SOL -> $100X -> BABY100X -> burned (sweep.ts)
// Env: KEEPER_KEY (JSON array or base58 secret), RPC, MEME_MINT, LOOP_MS, DRY_RUN, MIN_SWEEP_LST
import { Connection, Keypair, PublicKey, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import bs58 from "bs58";
import fs from "fs";
import {
  PROGRAM_ID, PUMP, RFSTACC, burnMemeIx, burnStatePda, burnVaultPda, claimFeesIx, cu, memeVenue, pokeIx, settleBeginIx, settleEndIx,
  sideAccounts, tokenBalance, type Market,
} from "./lib";
import { STAKE_POOL, readPool, withdrawSolIx } from "./stakepool";
import { ensureAlts, globalAccounts, marketAccounts } from "./alt";
import { sweepDev } from "./sweep";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const LOOP_MS = Number(process.env.LOOP_MS ?? 30_000);
const DRY = process.env.DRY_RUN === "1";
const MEME = new PublicKey(process.env.MEME_MINT ?? "Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump");
const MIN_BURN_LST = BigInt(process.env.MIN_BURN_LST ?? "2000000"); // min r-fstacc (raw) one burn must be worth
const MIN_POKE_LST = 500_000n; // make them pay when >= 0.0005 r-fstacc would move
const MIN_CLAIM_LST = 1_000_000n;
const MIN_OWED = 0.003; // settle when a curve owes >= 0.3%
const KEEP_SOL = 0.02; // never spend the keeper below this
const MIN_BUY_SOL = Number(process.env.MIN_BUY_SOL ?? 0.01); // restock chunk; tiny buys trip PumpSwap slippage

const conn = new Connection(RPC, "confirmed");
const key = (() => {
  const raw = process.env.KEEPER_KEY ?? fs.readFileSync("keeper.json", "utf8");
  return Keypair.fromSecretKey(raw.trim().startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw.trim()));
})();
const dbc = DynamicBondingCurveClient.create(conn, "confirmed");
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function sendV0(ixs: Parameters<TransactionMessage["constructor"]>[0]["instructions"], label: string, extra: Keypair[] = []) {
  if (DRY) return log("DRY", label);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: key.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  tx.sign([key, ...extra]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) return log("skip", label, JSON.stringify(sim.value.err), (sim.value.logs ?? []).slice(-3).join(" | "));
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  log(res.value.err ? "FAILED" : "ok", label, sig, res.value.err ? JSON.stringify(res.value.err) : "");
  return res.value.err ? null : sig;
}

// ---------- markets ----------
const u64 = (d: Buffer, o: number) => d.readBigUInt64LE(o);
async function markets(): Promise<Market[]> {
  const res = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 1008 }] });
  const out: Market[] = [];
  for (const { pubkey, account } of res) {
    const d = account.data;
    const pk = (o: number) => new PublicKey(d.subarray(o, o + 32));
    const pool = await conn.getAccountInfo(pk(232));
    out.push({ key: pubkey, bullMint: pk(8), bearMint: pk(40), oraclePool: pk(104), oracleObs: pk(136), windowSecs: d.readUInt32LE(480), underlyingIsToken0: d[489], config: new PublicKey(pool!.data.subarray(72, 104)) });
  }
  return out;
}

type Pt = { ts: number; tc: bigint };
const RING_STALE_SECS = 3600;
const SAMPLE_EVERY_SECS = 150; // matches the program's checkpoint spacing
function twapNow(obs: Buffer, ckpts: Pt[], window: number, sample?: { now: number; tick: number }) {
  const idx = obs.readUInt16LE(17);
  const pts: Pt[] = [];
  for (let i = 0; i < 100; i++) pts.push({ ts: obs.readUInt32LE(51 + i * 44), tc: obs.readBigInt64LE(51 + i * 44 + 4) });
  let end = pts[idx];
  // dead ring: the program samples the pool tick itself; mirror it so our pending math matches
  if (sample && end.ts + RING_STALE_SECS < sample.now) {
    const newest = ckpts.filter((c) => c.ts > 0).sort((a, b) => b.ts - a.ts)[0];
    const base = newest && newest.ts >= end.ts ? newest : end;
    end = { ts: sample.now, tc: base.tc + BigInt(sample.tick) * BigInt(Math.max(0, sample.now - base.ts)) };
  }
  const target = Math.max(0, end.ts - window);
  let best: Pt | undefined;
  let oldest = end;
  for (const p of [...pts, ...ckpts]) {
    if (p.ts === 0 || p.ts > end.ts) continue;
    if (p.ts <= target && (!best || p.ts > best.ts)) best = p;
    if (p.ts < oldest.ts) oldest = p;
  }
  const start = best ?? oldest;
  return start.ts === end.ts ? null : { endTs: end.ts, twapQ32: ((end.tc - start.tc) << 32n) / BigInt(end.ts - start.ts) };
}

async function chores(m: Market) {
  const d = (await conn.getAccountInfo(m.key))!.data;
  const [vB, vR, obs, pB, pR, opool] = await conn.getMultipleAccountsInfo([sideAccounts(m, 0).vault, sideAccounts(m, 1).vault, m.oracleObs, sideAccounts(m, 0).pool, sideAccounts(m, 1).pool, m.oraclePool]);
  const vaults = [u64(vB!.data, 64), u64(vR!.data, 64)];
  const ckpts = Array.from({ length: 32 }, (_, i) => ({ ts: d.readUInt32LE(496 + i * 16), tc: d.readBigInt64LE(496 + i * 16 + 8) }));
  const nowTs = Math.floor(Date.now() / 1000);
  const ringTs = obs!.data.readUInt32LE(51 + obs!.data.readUInt16LE(17) * 44);
  const sampled = ringTs + RING_STALE_SECS < nowTs;
  const now = twapNow(obs!.data, ckpts, d.readUInt32LE(480), { now: nowTs, tick: opool!.data.readInt32LE(269) });
  // 0. sampled markets need a heartbeat: every poke is one more point in the window
  if (sampled && nowTs - d.readUInt32LE(484) >= SAMPLE_EVERY_SECS) {
    await sendV0([cu(60_000), pokeIx(m)], `sample ${m.key.toBase58().slice(0, 6)} tick ${opool!.data.readInt32LE(269)}`);
  }
  // 1. make them pay
  if (now && now.endTs > d.readUInt32LE(484)) {
    const dTick = now.twapQ32 - d.readBigInt64LE(424);
    const du = d[489] ? dTick : -dTick;
    if (du !== 0n) {
      const keep = Math.pow(1.0001, (-100 * Number(du < 0n ? -du : du)) / 2 ** 32);
      const payer = du > 0n ? 1 : 0;
      const amount = BigInt(Math.floor(Number(vaults[payer]) * (1 - keep)));
      if (amount >= MIN_POKE_LST) await sendV0([cu(60_000), pokeIx(m)], `poke ${m.key.toBase58().slice(0, 6)} ${payer ? "DOWN" : "UP"} pays ${Number(amount) / 1e9}`);
    }
  }
  // 2. sweep fees
  const fees = [u64(pB!.data, 272), u64(pR!.data, 272)];
  for (const side of [0, 1] as const) if (fees[side] >= MIN_CLAIM_LST) await sendV0([cu(150_000), claimFeesIx(m, side)], `claim ${m.key.toBase58().slice(0, 6)} ${side ? "DOWN" : "UP"} ${Number(fees[side]) / 1e9}`);
  // 3. collect owed price
  const fresh = (await conn.getAccountInfo(m.key))!.data;
  for (const side of [0, 1] as const) {
    const keep = Number(fresh.readBigUInt64LE(432 + 8 * side)) / 2 ** 63;
    if (1 - keep < MIN_OWED || fresh[490] === 1) continue;
    const a = sideAccounts(m, side);
    const pool = await dbc.state.getPool(a.pool);
    const cfg = pool && (await dbc.state.getPoolConfig(pool.poolState.config));
    if (!pool || !cfg || pool.poolState.sqrtPrice.lte(cfg.sqrtStartPrice.add(cfg.sqrtStartPrice.div(new BN(1_000_000_000))))) continue; // at (or a hair above) the floor: nothing to extract
    const sdk = await dbc.pool.swap2WithTransferHook({ owner: key.publicKey, pool: a.pool, swapBaseForQuote: true, referralTokenAccount: null, payer: key.publicKey, swapMode: SwapMode.ExactIn, amountIn: new BN(1), minimumAmountOut: new BN(0) });
    const swapIx = sdk.instructions.find((ix) => ix.programId.toBase58().startsWith("dbcij"))!;
    const build = (amount: bigint) => {
      const keys = swapIx.keys.map((k) => ({ ...k }));
      keys[3] = { pubkey: a.escrow, isSigner: false, isWritable: true };
      keys[4] = { pubkey: sideAccounts(m, 1 - side).vault, isSigner: false, isWritable: true };
      const data = Buffer.from(swapIx.data);
      data.writeBigUInt64LE(amount, 8);
      data.writeBigUInt64LE(0n, 16);
      return [cu(1_000_000), settleBeginIx(m, key.publicKey, side, amount), { ...swapIx, keys, data }, settleEndIx(m, side)];
    };
    const ok = async (amount: bigint) => {
      const { blockhash } = await conn.getLatestBlockhash();
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: key.publicKey, recentBlockhash: blockhash, instructions: build(amount) }).compileToV0Message());
      return !(await conn.simulateTransaction(tx, { sigVerify: false })).value.err;
    };
    let lo = 0n, hi = 10n ** 15n;
    for (let i = 0; i < 40 && hi - lo > 1n; i++) { const mid = (lo + hi) / 2n; if (await ok(mid)) lo = mid; else hi = mid; }
    if (lo > 0n) await sendV0(build(lo), `settle ${m.key.toBase58().slice(0, 6)} ${side ? "DOWN" : "UP"} owed ${((1 - keep) * 100).toFixed(2)}% amount ${lo}`);
  }
}

// ---------- burn ----------
async function burn() {
  const v = memeVenue(MEME);
  const [vault, state, mint, bc, pool, sp] = await conn.getMultipleAccountsInfo([burnVaultPda(), burnStatePda(), MEME, v.bondingCurve, v.pool, STAKE_POOL]);
  if (!vault || !state || !mint || !bc) return log("burn: pot/venue missing");
  const pot = u64(vault.data, 64);
  const lastTs = Number(state.data.readBigInt64LE(16));
  if (Math.floor(Date.now() / 1000) - lastTs < 60) return;
  const total = u64(sp!.data, 258), supply = u64(sp!.data, 266);
  const toLst = (lamports: bigint) => (((lamports * 10_300n) / 10_000n) * supply) / total;
  let quote: (n: bigint) => bigint;
  let baseAta = v.pool, quoteAta = v.pool;
  if (bc.data[48] === 0) {
    const vt = u64(bc.data, 8), vs = u64(bc.data, 16);
    quote = (n) => toLst((((vs * n) / (vt + n)) * 9_900n) / 10_000n);
  } else {
    if (!pool) return log("burn: graduated but canonical pool missing");
    baseAta = new PublicKey(pool.data.subarray(139, 171));
    quoteAta = new PublicKey(pool.data.subarray(171, 203));
    const [b, q] = await conn.getMultipleAccountsInfo([baseAta, quoteAta]);
    const bb = u64(b!.data, 64), qb = u64(q!.data, 64);
    quote = (n) => toLst((((qb * n) / (bb + n)) * 9_970n) / 10_000n);
  }
  const cap = (pot * 500n) / 10_000n;
  if (cap < MIN_BURN_LST) return;
  let lo = 0n, hi = 10n ** 18n;
  while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (quote(mid) <= cap) lo = mid; else hi = mid; }
  const memeProg = mint.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const memeAta = getAssociatedTokenAddressSync(MEME, key.publicKey, false, memeProg);
  let inv = await tokenBalance(conn, memeAta);
  // keep an inventory: buy in sane chunks (>= MIN_BUY_SOL), burn up to the cap every minute from it
  if (inv < lo) {
    const capLamports = (quote(lo) * total) / supply / 10_300n * 10_000n;
    const spendSol = Math.max(MIN_BUY_SOL, (Number(capLamports) / 1e9) * 4);
    const balance = (await conn.getBalance(key.publicKey)) / 1e9;
    if (balance - spendSol < KEEP_SOL) return log(`burn: need ${spendSol.toFixed(4)} SOL to restock, keeper has ${balance.toFixed(4)}`);
    if (DRY) return log(`DRY burn: would buy ${spendSol.toFixed(4)} SOL of $100X`);
    const r = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey: key.publicKey.toBase58(), action: "buy", mint: MEME.toBase58(), amount: spendSol, denominatedInSol: "true", slippage: 99, priorityFee: 0.0001, pool: "auto" }),
    });
    if (!r.ok) return log("burn: pumpportal", r.status, await r.text());
    const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()));
    tx.sign([key]);
    try {
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      await conn.confirmTransaction(sig, "confirmed");
      const after = await tokenBalance(conn, memeAta);
      log(`restocked: bought ${after - inv} $100X for ${spendSol.toFixed(4)} SOL`, sig);
      inv = after;
    } catch (e) {
      return log("burn: buy failed", e instanceof Error ? e.message.split("\n")[0] : e);
    }
  }
  const n = inv < lo ? inv : lo;
  if (n <= 0n || quote(n) < MIN_BURN_LST) return;
  if (DRY) return log(`DRY burn ${n} $100X for ${Number(quote(n)) / 1e9} r-fstacc`);
  const paid = quote(n);
  const p = await readPool(conn);
  const quoteAtaK = getAssociatedTokenAddressSync(RFSTACC, key.publicKey);
  await sendV0(
    [cu(250_000), createAssociatedTokenAccountIdempotentInstruction(key.publicKey, quoteAtaK, key.publicKey, RFSTACC), burnMemeIx(key.publicKey, MEME, memeProg, memeAta, baseAta, quoteAta, n), withdrawSolIx(p, key.publicKey, quoteAtaK, (paid * 97n) / 100n)],
    `BURN ${Number(n) / 1e6} $100X -> ${Number(paid) / 1e9} r-fstacc -> SOL`,
  );
}

// The site's address lookup tables: new markets are permissionless, so the keeper appends their accounts as they appear,
// opening a fresh table whenever the existing ones are full (256 each).
let altSeen = "";
async function extendAlt(ms: Market[]) {
  const now = ms.map((m) => m.key.toBase58()).sort().join(",");
  if (now === altSeen) return;
  if (DRY) return log(`DRY alt extend for ${ms.length} markets`);
  await ensureAlts(conn, key, [...globalAccounts(await readPool(conn), MEME), ...ms.flatMap(marketAccounts)], (...a) => log("alt", ...a));
  altSeen = now;
}

log("keeper", key.publicKey.toBase58(), "rpc", RPC.replace(/api-key=.*/, "api-key=…"), DRY ? "(dry run)" : "");
for (;;) {
  try {
    const ms = await markets();
    await extendAlt(ms).catch((e) => log("alt", e instanceof Error ? e.message : e));
    for (const m of ms) await chores(m).catch((e) => log("chores", m.key.toBase58().slice(0, 6), e instanceof Error ? e.message : e));
    await burn().catch((e) => log("burn", e instanceof Error ? e.message : e));
    await sweepDev(conn, key, log, { dry: DRY }).catch((e) => log("sweep", e instanceof Error ? e.message : e));
  } catch (e) {
    log("loop", e instanceof Error ? e.message : e);
  }
  await new Promise((r) => setTimeout(r, LOOP_MS));
}
