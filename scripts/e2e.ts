// End-to-end test against a surfpool mainnet fork: real DBC, real Raydium oracle, real r-freestacc.
// Run: surfpool on :8899 with the program deployed, then `bun e2e.ts`.
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DynamicBondingCurveClient,
  MigrationFeeOption,
  MigrationOption,
  SwapMode,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithMarketCap,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import fs from "fs";
import {
  DBC,
  DEV_ATA,
  PROGRAM_ID,
  RFSTACC,
  burnMemeIx,
  burnVaultPda,
  claimFeesIx,
  createMarketIx,
  cu,
  initBurnIx,
  marketPda,
  pokeIx,
  readMarket,
  redeemIx,
  send,
  settleBeginIx,
  settleEndIx,
  sideAccounts,
  tokenBalance,
  type Market,
} from "./lib";

const RPC = process.env.RPC ?? "http://127.0.0.1:8899";
const rpcUrl = new URL(RPC);
if (rpcUrl.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(rpcUrl.hostname)) throw new Error("e2e.ts only runs on a local fork");
const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("test-payer.json", "utf8"))));
const RAY_POOL = new PublicKey("45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5");
const RAY_OBS = new PublicKey("7oVcrScfu1jVKq1DsaVZ8HtX1RZ6sa3oik3uVhowtifK");
const WINDOW = Number(process.env.WINDOW_SECS ?? 3960);
const E9 = 1_000_000_000n;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}
const fmt = (x: bigint) => (Number(x) / 1e9).toFixed(9);

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j: any = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// ---- oracle model (mirrors programs/hooked/src/oracle.rs) ----
type Pt = { ts: number; tc: bigint };
function ring(d: Buffer) {
  const idx = d.readUInt16LE(17);
  const pts: Pt[] = [];
  for (let i = 0; i < 100; i++) pts.push({ ts: d.readUInt32LE(51 + i * 44), tc: d.readBigInt64LE(51 + i * 44 + 4) });
  return { idx, pts };
}
function modelTwap(obs: Buffer, ckpts: Pt[], window: number) {
  const { idx, pts } = ring(obs);
  const end = pts[idx];
  const target = Math.max(0, end.ts - window);
  let best: Pt | undefined;
  let oldest = end;
  for (const p of [...pts, ...ckpts]) {
    if (p.ts === 0 || p.ts > end.ts) continue;
    if (p.ts <= target && (!best || p.ts > best.ts)) best = p;
    if (p.ts < oldest.ts) oldest = p;
  }
  const start = best ?? oldest;
  return { end, twapQ32: ((end.tc - start.tc) << 32n) / BigInt(end.ts - start.ts) };
}
const keepOf = (duQ32: bigint) => Math.pow(1.0001, (-100 * Number(duQ32 < 0n ? -duQ32 : duQ32)) / 2 ** 32);

async function pushObservations(n: number, dt: number, tick: number) {
  const d = Buffer.from((await conn.getAccountInfo(RAY_OBS))!.data);
  for (let k = 0; k < n; k++) {
    const idx = d.readUInt16LE(17);
    const o = 51 + idx * 44;
    const ts = d.readUInt32LE(o);
    const tc = d.readBigInt64LE(o + 4);
    const ni = (idx + 1) % 100;
    const no = 51 + ni * 44;
    d.writeUInt32LE(ts + dt, no);
    d.writeBigInt64LE(tc + BigInt(tick * dt), no + 4);
    d.writeUInt16LE(ni, 17);
  }
  await rpc("surfnet_setAccount", [RAY_OBS.toBase58(), { data: d.toString("hex") }]);
  return d;
}

async function main() {
  const client = DynamicBondingCurveClient.create(conn, "confirmed");
  const progInfo = await conn.getAccountInfo(PROGRAM_ID);
  check("program deployed on fork", !!progInfo?.executable);
  if (!progInfo?.executable) throw new Error("deploy the test binary to the local fork first");
  // Optional fixture refresh allows repeatable fresh-market tests even when this public venue is quiet.
  // This changes only the local fork; live oracle freshness is a separate deployment preflight check.
  if (process.env.REFRESH_TEST_RING === "1") {
    const obs = Buffer.from((await conn.getAccountInfo(RAY_OBS))!.data);
    const now = Number((await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY))!.data.readBigInt64LE(32));
    const newest = obs.readUInt32LE(51 + obs.readUInt16LE(17) * 44);
    const shift = now - newest;
    for (let i = 0; i < 100; i++) {
      const offset = 51 + i * 44;
      const ts = obs.readUInt32LE(offset);
      if (ts) obs.writeUInt32LE(ts + shift, offset);
    }
    await rpc("surfnet_setAccount", [RAY_OBS.toBase58(), { data: obs.toString("hex") }]);
  }

  await rpc("surfnet_setTokenAccount", [
    payer.publicKey.toBase58(), RFSTACC.toBase58(), { amount: 1_000 * Number(E9) }, TOKEN_PROGRAM_ID.toBase58(),
  ]);
  const payerQuote = getAssociatedTokenAddressSync(RFSTACC, payer.publicKey);
  check("payer funded with r-freestacc", (await tokenBalance(conn, payerQuote)) === 1_000n * E9);

  // ---- market keys ----
  const bull = Keypair.generate();
  const bear = Keypair.generate();
  const configKp = Keypair.generate();
  const key = marketPda(bull.publicKey, bear.publicKey, RAY_OBS, WINDOW, 0);
  const m: Market = {
    key, bullMint: bull.publicKey, bearMint: bear.publicKey, oraclePool: RAY_POOL, oracleObs: RAY_OBS,
    windowSecs: WINDOW, underlyingIsToken0: 0, config: configKp.publicKey,
  };
  const B = sideAccounts(m, 0);
  const R = sideAccounts(m, 1);
  console.log("market", key.toBase58(), "bull", bull.publicKey.toBase58(), "bear", bear.publicKey.toBase58());

  // ---- DBC config: hook = our program, partner (fee_claimer) = market PDA -> mint authority ----
  const curve = buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.Token2022, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: 9,
      tokenAuthorityOption: TokenAuthorityOption.PartnerUpdateAndMintAuthority, totalTokenSupply: 1_000_000_000, leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: 400, endingFeeBps: 400, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken, creatorTradingFeePercentage: 0,
      poolCreationFee: 0, enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps25,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 100, partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    initialMarketCap: 10,
    migrationMarketCap: 1_000_000,
  });
  const cfgTx = await client.partner.createConfigWithTransferHook({
    ...curve, config: configKp.publicKey, feeClaimer: key, leftoverReceiver: payer.publicKey, quoteMint: RFSTACC,
    payer: payer.publicKey, transferHookProgram: PROGRAM_ID,
  });
  await send(conn, cfgTx, [payer, configKp]);
  check("DBC hook config created (fee_claimer = market PDA)", !!(await conn.getAccountInfo(configKp.publicKey)));

  for (const [kp, name, symbol] of [[bull, "PUMP 100x UP", "PUMPUP"], [bear, "PUMP 100x DOWN", "PUMPDN"]] as const) {
    const tx = await client.creator.createPoolWithTransferHook({
      name, symbol, uri: "https://100x.broker", payer: payer.publicKey, poolCreator: payer.publicKey,
      config: configKp.publicKey, baseMint: kp.publicKey, transferHookProgram: PROGRAM_ID,
    });
    await send(conn, tx, [payer, kp]);
  }
  const mintInfo = (await conn.getAccountInfo(bull.publicKey))!.data;
  check("DBC handed BULL mint authority to market PDA", new PublicKey(mintInfo.subarray(4, 36)).equals(key));

  // escrows (Token-2022 ATAs owned by the market PDA), then create_market
  const esc = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, B.escrow, key, bull.publicKey, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, R.escrow, key, bear.publicKey, TOKEN_2022_PROGRAM_ID),
  );
  await send(conn, esc, [payer]);
  const cm = await send(conn, new Transaction().add(cu(600_000), createMarketIx(payer.publicKey, m)), [payer]);
  check("create_market", !!(await conn.getAccountInfo(key)), `cu=${cm.cu}`);
  let st = await readMarket(conn, key);
  check("market initialised from oracle", st.lastObsTs > 0 && st.keepBullQ63 === 1n << 63n, `last_obs_ts=${st.lastObsTs}`);
  await send(conn, new Transaction().add(cu(200_000), initBurnIx(payer.publicKey)), [payer]);
  await send(conn, new Transaction().add(cu(200_000), initBurnIx(payer.publicKey)), [payer]);
  check("init_burn creates the pot and is idempotent", !!(await conn.getAccountInfo(burnVaultPda())));
  const devAta = DEV_ATA;
  const burnVault = burnVaultPda();

  // ---- seed vaults 10 r-freestacc each ----
  await send(conn, new Transaction().add(
    createTransferInstruction(payerQuote, B.vault, payer.publicKey, 10n * E9),
    createTransferInstruction(payerQuote, R.vault, payer.publicKey, 10n * E9),
  ), [payer]);

  // ---- buys go through the hook ----
  for (const [side, pool] of [[0, B.pool], [1, R.pool]] as const) {
    const tx = await client.pool.swap2WithTransferHook({
      owner: payer.publicKey, pool, swapBaseForQuote: false, referralTokenAccount: null, payer: payer.publicKey,
      swapMode: SwapMode.ExactIn, amountIn: new BN(2_000_000_000), minimumAmountOut: new BN(0),
    });
    const res = await send(conn, tx, [payer]);
    const hooked = res.logs.some((l) => l.includes(`Program ${PROGRAM_ID.toBase58()} invoke`));
    check(`buy ${side === 0 ? "BULL" : "BEAR"} via swap2_with_transfer_hook runs the hook`, hooked, `cu=${res.cu}`);
  }
  const bullAta = getAssociatedTokenAddressSync(bull.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const bearAta = getAssociatedTokenAddressSync(bear.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  check("received BULL and BEAR", (await tokenBalance(conn, bullAta)) > 0n && (await tokenBalance(conn, bearAta)) > 0n);
  check("new market belongs to fresh program ID", (await conn.getAccountInfo(key))!.owner.equals(PROGRAM_ID));
  if (process.env.TEST_DISCOVERY === "0") console.log("SKIP discovery scan: upstream proxy does not yet allow the undeployed program ID");
  else check("fresh-ID discovery finds new market", (await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 1008 }] })).some((a) => a.pubkey.equals(key)));
  if (process.env.MARKET_ONLY === "1") {
    console.log("Local funded market fixture ready:", key.toBase58());
    process.exit(failures === 0 ? 0 : 1);
  }

  if (WINDOW < 150) {
    const beforeMarket = Buffer.from((await conn.getAccountInfo(key))!.data);
    const beforeUp = await tokenBalance(conn, B.vault);
    const beforeDown = await tokenBalance(conn, R.vault);
    const originalPool = Buffer.from((await conn.getAccountInfo(RAY_POOL))!.data);
    const pushedPool = Buffer.from(originalPool);
    pushedPool.writeInt32LE(originalPool.readInt32LE(269) + 1000, 269);
    const now = Number((await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY))!.data.readBigInt64LE(32));
    await rpc("surfnet_timeTravel", [{ absoluteTimestamp: (now + 7200) * 1000 }]);
    await rpc("surfnet_setAccount", [RAY_POOL.toBase58(), { data: pushedPool.toString("hex") }]);
    await send(conn, new Transaction().add(pokeIx(m)), [payer]);
    check("2-obs stale ring ignores pushed live tick", beforeMarket.equals((await conn.getAccountInfo(key))!.data)
      && beforeUp === await tokenBalance(conn, B.vault) && beforeDown === await tokenBalance(conn, R.vault));
    await rpc("surfnet_setAccount", [RAY_POOL.toBase58(), { data: originalPool.toString("hex") }]);
  }

  // ---- PUMP dumps 1% vs SOL for 10 minutes (tick +~100 => PUMP per SOL up) ----
  st = await readMarket(conn, key);
  const before = { bull: await tokenBalance(conn, B.vault), bear: await tokenBalance(conn, R.vault) };
  const obsNow = (await conn.getAccountInfo(RAY_OBS))!.data;
  const r0 = ring(obsNow);
  const endPt = r0.pts[r0.idx];
  const prevPt = r0.pts[(r0.idx + 99) % 100];
  const spotTick = Math.round(Number(endPt.tc - prevPt.tc) / (endPt.ts - prevPt.ts));
  const newObs = await pushObservations(20, 30, spotTick + 100);
  const model = modelTwap(newObs, st.ckpts, WINDOW);
  const du = -(model.twapQ32 - st.lastTwapQ32); // underlying is token1 (PUMP)
  const keep = keepOf(du);
  const expectedLoss = BigInt(Math.floor(Number(before.bull) * (1 - keep)));
  const pk = await send(conn, new Transaction().add(pokeIx(m)), [payer]);
  const after = { bull: await tokenBalance(conn, B.vault), bear: await tokenBalance(conn, R.vault) };
  const paid = before.bull - after.bull;
  check("PUMP dump: BULL vault pays BEAR vault", du < 0n && paid > 0n && after.bear - before.bear === paid,
    `Δtwap=${(Number(model.twapQ32 - st.lastTwapQ32) / 2 ** 32).toFixed(3)} ticks paid=${fmt(paid)} cu=${pk.cu}`);
  const tol = before.bull / 1_000_000n + 2n;
  check("transfer matches 1 - 1.0001^(-100·|Δtwap|)", paid >= expectedLoss - tol && paid <= expectedLoss + tol,
    `expected=${fmt(expectedLoss)} keep=${keep.toFixed(6)}`);
  const pk2 = await send(conn, new Transaction().add(pokeIx(m)), [payer]);
  check("second poke with no new observation is a no-op", (await tokenBalance(conn, B.vault)) === after.bull, `cu=${pk2.cu}`);
  st = await readMarket(conn, key);
  check("BULL owes curve settlement (keep < 1)", st.keepBullQ63 < 1n << 63n, `keep_bull=${(Number(st.keepBullQ63) / 2 ** 63).toFixed(6)}`);

  // ---- redeem half the BEAR ----
  const bearBal = await tokenBalance(conn, bearAta);
  const amt = bearBal / 2n;
  const supply = (await conn.getAccountInfo(bear.publicKey))!.data.readBigUInt64LE(36);
  const inCurve = await tokenBalance(conn, R.baseVault);
  const circ = supply - inCurve;
  const vBear = await tokenBalance(conn, R.vault);
  const vBull = await tokenBalance(conn, B.vault);
  const gross = (vBear * amt) / circ;
  const fee = (gross * 400n) / 10_000n;
  const payout = gross - fee;
  const burnShare = (fee * 3_000n) / 10_000n;
  const devShare = (fee * 1_000n) / 10_000n;
  const mech = fee - burnShare - devShare;
  const route = vBull < vBear - payout - burnShare - devShare ? (mech * 9_000n) / 10_000n : 0n;
  const q0 = await tokenBalance(conn, payerQuote);
  const bp0 = await tokenBalance(conn, burnVault);
  const dv0 = await tokenBalance(conn, devAta);
  await send(conn, new Transaction().add(redeemIx(m, payer.publicKey, 1, amt)), [payer]);
  const q1 = await tokenBalance(conn, payerQuote);
  check("redeem BEAR pays vault share minus 4%", q1 - q0 === payout, `payout=${fmt(payout)} circ=${circ}`);
  check("BEAR burned", (await tokenBalance(conn, bearAta)) === bearBal - amt);
  check("30% of redemption fee -> burn pot", (await tokenBalance(conn, burnVault)) - bp0 === burnShare, `burn=${fmt(burnShare)}`);
  check("10% of redemption fee -> dev", (await tokenBalance(conn, devAta)) - dv0 === devShare, `dev=${fmt(devShare)}`);
  check("90% of the mechanism's 60% routed to smaller vault", (await tokenBalance(conn, B.vault)) - vBull === route, `route=${fmt(route)}`);

  // ---- settle: mint+sell BULL into its curve, proceeds to BEAR vault ----
  const swapTx = await client.pool.swap2WithTransferHook({
    owner: payer.publicKey, pool: B.pool, swapBaseForQuote: true, referralTokenAccount: null, payer: payer.publicKey,
    swapMode: SwapMode.ExactIn, amountIn: new BN(1), minimumAmountOut: new BN(0),
  });
  const dbcIx = swapTx.instructions.find((ix) => ix.programId.equals(DBC))!;
  const settleTx = (amount: bigint) => {
    const keys = dbcIx.keys.map((k) => ({ ...k }));
    keys[3] = { pubkey: B.escrow, isSigner: false, isWritable: true };
    keys[4] = { pubkey: R.vault, isSigner: false, isWritable: true };
    const data = Buffer.from(dbcIx.data);
    data.writeBigUInt64LE(amount, 8);
    data.writeBigUInt64LE(0n, 16);
    return [cu(1_000_000), settleBeginIx(m, payer.publicKey, 0, amount), { ...dbcIx, keys, data }, settleEndIx(m, 0)];
  };
  const simulate = async (amount: bigint) => {
    const msg = new TransactionMessage({
      payerKey: payer.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
      instructions: settleTx(amount) as any,
    }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
    return { ok: !sim.value.err, err: sim.value.err, logs: sim.value.logs ?? [], size: vtx.serialize().length };
  };
  const dust = await simulate(1n);
  check("settle sandwich fits in one tx", dust.size <= 1232, `bytes=${dust.size}`);
  check("settle selling dust (0 proceeds) is rejected", !dust.ok && JSON.stringify(dust.err).includes("4113"));
  let lo = 0n;
  let hi = 10n ** 15n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await simulate(mid)).ok) lo = mid;
    else hi = mid;
  }
  const poolPrice = async () => (await conn.getAccountInfo(B.pool))!.data.readBigUInt64LE(280 + 8) * 2n ** 64n +
    (await conn.getAccountInfo(B.pool))!.data.readBigUInt64LE(280);
  check("settle amount found by simulation", lo > 0n && (await simulate(lo)).ok, `amount=${lo}`);
  const s0 = await poolPrice();
  const vb0 = await tokenBalance(conn, R.vault);
  const msg = new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
    instructions: settleTx(lo) as any,
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([payer]);
  const sig = await conn.sendTransaction(vtx, { skipPreflight: true });
  await conn.confirmTransaction(sig, "confirmed");
  const got = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  check("settle sandwich lands", !got?.meta?.err, `amount=${lo} cu=${got?.meta?.computeUnitsConsumed}`);
  const s1 = await poolPrice();
  const stS = await readMarket(conn, key);
  const priceRatio = Number(s1 * s1 * 10n ** 12n / (s0 * s0)) / 1e12;
  // A large two-obs move can hit the DBC floor before paying the entire factor. The unpaid factor must remain owed.
  const owedFactor = Number(st.keepBullQ63) / 2 ** 63;
  const remainingFactor = Number(stS.keepBullQ63) / 2 ** 63;
  check("settlement pays toward the factor and retains any unpaid remainder", priceRatio < 1
    && priceRatio >= owedFactor - 1e-6 && Math.abs(priceRatio * remainingFactor - owedFactor) < 1e-6,
    `price ratio=${priceRatio.toFixed(6)} owed=${(Number(st.keepBullQ63) / 2 ** 63).toFixed(6)} remaining=${(Number(stS.keepBullQ63) / 2 ** 63).toFixed(6)}`);
  check("settle proceeds landed in BEAR vault", (await tokenBalance(conn, R.vault)) > vb0, `+${fmt((await tokenBalance(conn, R.vault)) - vb0)}`);
  check("escrow empty and settling cleared", (await tokenBalance(conn, B.escrow)) === 0n && stS.settling === 0);

  // an overshoot must fail atomically
  if (stS.keepBullQ63 < (1n << 63n) - 1000n) {
    check("overshooting settle reverts", !(await simulate(lo * 4n + 1_000_000n)).ok);
  }

  // ---- claim partner fees with 90/10 funding split ----
  for (const side of [0, 1]) {
    const own = side === 0 ? B.vault : R.vault;
    const other = side === 0 ? R.vault : B.vault;
    const o0 = await tokenBalance(conn, own);
    const x0 = await tokenBalance(conn, other);
    const fees = (await conn.getAccountInfo(side === 0 ? B.pool : R.pool))!.data.readBigUInt64LE(272);
    const bp0 = await tokenBalance(conn, burnVault);
    const dv0 = await tokenBalance(conn, devAta);
    await send(conn, new Transaction().add(claimFeesIx(m, side)), [payer]);
    const o1 = await tokenBalance(conn, own);
    const x1 = await tokenBalance(conn, other);
    const routed = x1 - x0;
    const bshare = (fees * 3_000n) / 10_000n;
    const dshare = (fees * 1_000n) / 10_000n;
    const mech = fees - bshare - dshare;
    const expectRoute = x0 < o0 + mech ? (mech * 9_000n) / 10_000n : 0n;
    check(`claim ${side === 0 ? "BULL" : "BEAR"} curve fees (${fmt(fees)}) split 60/30/10`,
      o1 - o0 + routed === mech && routed === expectRoute && (await tokenBalance(conn, burnVault)) - bp0 === bshare && (await tokenBalance(conn, devAta)) - dv0 === dshare,
      `mech kept=${fmt(o1 - o0)} routed=${fmt(routed)} burn=${fmt(bshare)} dev=${fmt(dshare)}`);
  }

  if (process.env.TEST_BURN === "0") {
    console.log("SKIP burn bounty: core trading scope; burn requires a current venue fixture");
    console.log(failures === 0 ? "\nALL CORE TRADING CHECKS PASS" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  }
  // ---- burn bounty against the real $100X bonding curve (pre-graduation path) ----
  const coin = JSON.parse(fs.readFileSync(process.env.BURN_FIXTURE ?? "/tmp/claude-502/coin.json", "utf8")) as { mint: string; program: string; decimals: number; bondingCurve: string };
  const meme = new PublicKey(coin.mint);
  const memeProg = new PublicKey(coin.program);
  const memeUnits = 10n ** BigInt(coin.decimals);
  await rpc("surfnet_setTokenAccount", [payer.publicKey.toBase58(), meme.toBase58(), { amount: Number(5_000_000n * memeUnits) }, memeProg.toBase58()]);
  const memeAta = getAssociatedTokenAddressSync(meme, payer.publicKey, false, memeProg);
  await send(conn, new Transaction().add(createTransferInstruction(payerQuote, burnVault, payer.publicKey, 20n * E9)), [payer]);
  const pot0 = await tokenBalance(conn, burnVault);
  const bcd = (await conn.getAccountInfo(new PublicKey(coin.bondingCurve)))!.data;
  const vt = bcd.readBigUInt64LE(8);
  const vs = bcd.readBigUInt64LE(16);
  check("venue is the pre-graduation bonding curve", bcd[48] === 0);
  const spd = (await conn.getAccountInfo(new PublicKey("SzoSoRxsrL9sbFcwpbjbH5bRrzuvFtuytZTeuqZCfQ6")))!.data;
  const spTotal = spd.readBigUInt64LE(258);
  const spSupply = spd.readBigUInt64LE(266);
  const quoteFor = (n: bigint) => (((vs * n) / (vt + n)) * 9_900n / 10_000n * 10_300n / 10_000n) * spSupply / spTotal;
  let nUse = 1_000_000n * memeUnits;
  while (quoteFor(nUse) > (pot0 * 500n) / 10_000n) nUse /= 2n;
  const expUse = quoteFor(nUse);
  const mq0 = await tokenBalance(conn, payerQuote);
  const mm0 = await tokenBalance(conn, memeAta);
  const { pool } = (await import("./lib")).memeVenue(meme);
  const bres = await send(conn, new Transaction().add(cu(200_000), burnMemeIx(payer.publicKey, meme, memeProg, memeAta, pool, pool, nUse)), [payer]);
  check("burn_meme burns the caller's $100X", mm0 - (await tokenBalance(conn, memeAta)) === nUse, `burned ${nUse / memeUnits} cu=${bres.cu}`);
  check("burn_meme pays the curve's sell quote + 3% from the pot", (await tokenBalance(conn, payerQuote)) - mq0 === expUse, `paid ${fmt(expUse)} r-fstacc for ${nUse / memeUnits} tokens`);
  check("pot debited exactly", pot0 - (await tokenBalance(conn, burnVault)) === expUse);
  const again = await conn.simulateTransaction(new Transaction().add(cu(200_000), burnMemeIx(payer.publicKey, meme, memeProg, memeAta, pool, pool, nUse)), [payer]);
  check("second burn inside the cooldown is rejected", !!again.value.err, JSON.stringify(again.value.err));
  const huge = await conn.simulateTransaction(new Transaction().add(cu(200_000), burnMemeIx(payer.publicKey, meme, memeProg, memeAta, pool, pool, 4_000_000n * memeUnits)), [payer]);
  check("burn above 5% of the pot is rejected", !!huge.value.err, JSON.stringify(huge.value.err));

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
