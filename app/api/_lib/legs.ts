// The 100× legs of a swap on swap.100x.broker (and anything routed through api.liquidityxyz.fun).
//
// Spec (owner, 2026-10-13): 1 bp of each hop goes to the house (the lp-zap composer takes that on chain). 10 bp of each hop
// is split in half: an irresponsible 100× long on what that hop bought, and an irresponsible 100× short on what it sold.
// badBeat flips the two. Any coin a hop touches that has no 100x.broker market gets one, idempotently.
//
// How it is paid: 10 bp of the hop's value in SOL, from the swapper's SOL, through the r-fstacc stake pool into the DBC
// curve of the UP or DOWN token — the same buy the market page's ticket makes. The tokens land in the swapper's wallet.
// SOL itself has no market (every market is priced in SOL), so a hop that buys or sells SOL takes that side on the deepest
// stable-priced-in-SOL market, flipped: long SOL = DOWN there, short SOL = UP there.
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { conn, dbc, defaultWindowSecs, loadMarketView, oracleHealth, toV0, withPendingConfig, type MarketView } from "../../src/lib/chain.js";
import { claimFeesIx, createMarketIx, cu, marketPda, sideAccounts, type MarketKeys } from "../../src/lib/hooked.js";
import { depositOut, depositSolIx, poolState, type PoolState } from "../../src/lib/zap.js";
import { marketCurve } from "../../src/lib/curve.js";
import { candidateEffectiveQuote, candidateTvlUsd, discoverPools, type PoolCandidate } from "../../src/lib/venues.js";
import { HOUSE_WALLET, PROGRAM_ID, RFSTACC } from "../../src/config.js";
import { allViews } from "./views.js";

export const WSOL = "So11111111111111111111111111111111111111112";
export const HOUSE_BPS = 1n;
export const LEG_BPS = 10n;
const BPS = 10_000n;
const SITE = "https://100x.broker";
const STABLES = new Set(["USDC", "USDT", "PYUSD", "USD1", "USDS", "USDH", "FDUSD", "TUSD", "DAI", "USDE", "CASH"]);
/** Rough rent a listing locks (config, two curves + mints + metadata, market + vaults + escrows), from /new. */
const LISTING_RENT_SOL = 0.04;

export type HopIn = { inputMint: string; outputMint: string; inAmount: string; outAmount: string; label?: string };
type Side = 0 | 1;
export type LegTarget = {
  /** The coin this leg bets on (as the hop saw it). */
  mint: string;
  /** "long" or "short" on that coin, after badBeat. */
  bet: "long" | "short";
  /** Market the bet is placed on, and which token (UP = 0, DOWN = 1). Null while the coin is being listed. */
  market: string | null;
  side: Side | null;
  token: string | null;
  ticker: string | null;
  lamports: string;
  /** "sol-inverse": the bet on SOL rides a stable-priced-in-SOL market with the sides flipped. */
  via: "market" | "sol-inverse" | "listing" | "none";
  note?: string;
  /** The opposite side's pot (r-fstacc, raw): what this bet can win from. Near zero = no counterparty, little upside. */
  counterPot?: string;
};
/** One transaction's bets: identical bets (same market + side) are merged, several orders can share a transaction. */
export type TxBets = { market: string; side: Side; lamports: string; ticker: string; bets: { hop: number; bet: "long" | "short"; mint: string }[] }[];
export type HopLegs = { hop: number; label: string; sold: string; bought: string; valueLamports: string; legBudget: string; long: LegTarget; short: LegTarget };
export type Listing = {
  mint: string;
  symbol: string | null;
  oraclePool: string;
  venue: string;
  quote: string;
  market: string;
  estRentSol: number;
  /** Base64 transactions, in order, partially signed by the throwaway config/mint keys. The swapper signs and pays. */
  txs: string[];
  steps: string[];
};
export type LegsPlan = {
  houseBps: number;
  legBps: number;
  badBeat: boolean;
  hops: HopLegs[];
  /** Total SOL the legs spend (lamports), excluding network fees and token-account rent. */
  totalLamports: string;
  listings: Listing[];
  /** Base64 v0 transactions for legs whose market exists now; one per leg. */
  txs: string[];
  txLabels: string[];
  /** Per transaction in `txs`: the merged orders it carries (for per-bet status and retry). */
  txBets: TxBets[];
  /** What a bet costs beyond its 10 bp, for the page to show before signing. */
  costs: { curveFeeBps: number; potFeeBps: number; stakeFeeBps: number; networkLamportsPerTx: number; rentPerNewAccountLamports: number };
  /** Coins whose legs wait for their listing to land: call again after the listing transactions confirm. */
  pending: string[];
  unplaceable: { mint: string; reason: string }[];
};

// ---------------------------------------------------------------- markets per coin
const depthOf = (v: MarketView) => v.side[0].vault + v.side[1].vault;
function deepest(rows: MarketView[]) {
  return rows.sort((a, b) => (depthOf(b) > depthOf(a) ? 1 : depthOf(b) < depthOf(a) ? -1 : 0))[0] ?? null;
}
/** Deepest market on this coin, preferring a SOL-priced oracle (a bet on the coin against SOL is what a SOL-routed hop moves). */
function marketFor(views: MarketView[], mint: string): MarketView | null {
  const on = views.filter((v) => v.underlyingMint === mint);
  return deepest(on.filter((v) => v.oracle.quote === "SOL")) ?? deepest(on);
}
/** Deepest stable-priced-in-SOL market: the venue for a bet on SOL itself. */
function solInverse(views: MarketView[]): MarketView | null {
  return deepest(views.filter((v) => v.oracle.quote === "SOL" && STABLES.has((v.side[0].symbol.replace(/UP$/i, "") || v.ticker).toUpperCase())));
}

/** Where a bet on `mint` goes. Long = UP on the coin's market; on SOL it is DOWN on the stable/SOL market. */
function target(views: MarketView[], mint: string, bet: "long" | "short", lamports: bigint): LegTarget {
  const base = { mint, bet, lamports: lamports.toString() };
  if (mint === WSOL) {
    const m = solInverse(views);
    if (!m) return { ...base, market: null, side: null, token: null, ticker: null, via: "none", note: "no stable/SOL market to carry a bet on SOL" };
    const side: Side = bet === "long" ? 1 : 0;
    return { ...base, market: m.acct.key.toBase58(), side, token: (side ? m.keys.bearMint : m.keys.bullMint).toBase58(), ticker: m.ticker, via: "sol-inverse", counterPot: m.side[side ? 0 : 1].vault.toString() };
  }
  const m = marketFor(views, mint);
  if (!m) return { ...base, market: null, side: null, token: null, ticker: null, via: "listing" };
  const side: Side = bet === "long" ? 0 : 1;
  return { ...base, market: m.acct.key.toBase58(), side, token: (side ? m.keys.bearMint : m.keys.bullMint).toBase58(), ticker: m.ticker, via: "market", counterPot: m.side[side ? 0 : 1].vault.toString() };
}

// ---------------------------------------------------------------- hop value in SOL
const mintDecimals = new Map<string, number>([[WSOL, 9]]);
async function decimalsOf(mints: string[]) {
  const need = mints.filter((m) => !mintDecimals.has(m));
  if (!need.length) return;
  const infos = await conn.getMultipleAccountsInfo(need.map((m) => new PublicKey(m)));
  need.forEach((m, i) => {
    const d = infos[i]?.data;
    if (d && d.length >= 45) mintDecimals.set(m, d[44]);
  });
}
/** USD prices from Jupiter's public price API (valuation only, never routing). */
async function usdPrices(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${[...new Set([...mints, WSOL])].join(",")}`, { signal: AbortSignal.timeout(6_000) });
    const j = (await r.json()) as Record<string, { usdPrice?: number }>;
    for (const [k, v] of Object.entries(j ?? {})) if (v && typeof v.usdPrice === "number" && v.usdPrice > 0) out[k] = v.usdPrice;
  } catch {
    /* fall through: hops without a SOL side and without a price are reported, not guessed */
  }
  return out;
}
/** A hop's value in lamports: exact when one side is SOL, else the input priced in SOL. */
function hopLamports(h: HopIn, usd: Record<string, number>): bigint | null {
  if (h.inputMint === WSOL) return BigInt(h.inAmount);
  if (h.outputMint === WSOL) return BigInt(h.outAmount);
  const sol = usd[WSOL];
  for (const [mint, amount] of [[h.inputMint, h.inAmount], [h.outputMint, h.outAmount]] as const) {
    const p = usd[mint], d = mintDecimals.get(mint);
    if (p && sol && d !== undefined) return BigInt(Math.floor(((Number(amount) / 10 ** d) * p * 1e9) / sol));
  }
  return null;
}

// ---------------------------------------------------------------- one leg = one transaction
async function referral(wallet: PublicKey, ref: PublicKey | null): Promise<PublicKey> {
  const self = getAssociatedTokenAddressSync(RFSTACC, wallet);
  const candidates = [ref, HOUSE_WALLET].filter((k): k is PublicKey => !!k && !k.equals(wallet));
  if (!candidates.length) return self;
  const atas = candidates.map((k) => getAssociatedTokenAddressSync(RFSTACC, k));
  const infos = await conn.getMultipleAccountsInfo(atas);
  const i = infos.findIndex(Boolean);
  return i >= 0 ? atas[i] : self;
}
type Order = { v: MarketView; side: Side; lamports: bigint; bets: { hop: number; bet: "long" | "short"; mint: string }[] };
/** The DBC buy for one order (without the SDK's repeated idempotent ATA creates, which the runtime rejects as duplicates). */
async function orderIxs(pool: PoolState, wallet: PublicKey, o: Order): Promise<TransactionInstruction[]> {
  const amountIn = depositOut(pool, o.lamports);
  if (amountIn <= 0n) throw new Error("bet too small to stake");
  const a = sideAccounts(o.v.keys, o.side);
  const swap = await dbc.pool.swap2WithTransferHook({
    owner: wallet, pool: a.pool, swapBaseForQuote: false, referralTokenAccount: null, payer: wallet,
    // a fee-funded bet sized in dust: no slippage floor (a sandwich of a few thousand lamports pays nobody)
    swapMode: SwapMode.ExactIn, amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(0),
  });
  return [...swap.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)), claimFeesIx(o.v.keys, o.side)];
}
const ixKey = (ix: TransactionInstruction) => ix.programId.toBase58() + Buffer.from(ix.data).toString("hex") + ix.keys.map((k) => k.pubkey.toBase58()).join(",");
/** SOL -> r-fstacc once for every order in the transaction, then each order's curve buy + fee claim. Null if it won't fit. */
async function betsTx(pool: PoolState, wallet: PublicKey, orders: Order[], built: TransactionInstruction[][], refAta: PublicKey): Promise<string | null> {
  const quoteAta = getAssociatedTokenAddressSync(RFSTACC, wallet);
  const total = orders.reduce((a, o) => a + o.lamports, 0n);
  const seen = new Set<string>();
  const body = built.flat().filter((ix) => {
    const k = ixKey(ix);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const ixs: TransactionInstruction[] = [
    cu(Math.min(1_400_000, 200_000 + 260_000 * orders.length)),
    createAssociatedTokenAccountIdempotentInstruction(wallet, quoteAta, wallet, RFSTACC),
    // the floors of each order's share never exceed the floor of the total, so one deposit covers every buy
    depositSolIx(pool, wallet, quoteAta, total, refAta),
    ...body,
  ];
  try {
    const tx = await toV0(ixs, wallet);
    const wire = tx.serialize();
    return wire.length <= 1232 ? Buffer.from(wire).toString("base64") : null;
  } catch {
    return null; // over the 1232-byte packet limit
  }
}

// ---------------------------------------------------------------- listing a coin (the /new page, server side)
const usable = (p: PoolCandidate) => (p.venue === "clmm" ? !!p.obsData : (candidateEffectiveQuote(p) ?? 0n) > 0n);
async function bestOracle(mint: PublicKey, solUsd: number | null): Promise<PoolCandidate | null> {
  const all = await discoverPools(conn, mint);
  const depth = (p: PoolCandidate) => candidateTvlUsd(p, solUsd) ?? 0;
  const vol = (p: PoolCandidate) => p.volume24h ?? 0;
  all.sort((a, b) => Number(usable(b)) - Number(usable(a)) || vol(b) - vol(a) || depth(b) - depth(a));
  return all.find((p) => usable(p) && depth(p) >= 10) ?? null;
}
async function listingFor(wallet: PublicKey, mint: string, solUsd: number | null): Promise<Listing | { mint: string; reason: string }> {
  const m = new PublicKey(mint);
  const pool = await bestOracle(m, solUsd);
  if (!pool) return { mint, reason: "no pool against SOL, USDC or USDT on Raydium, PumpSwap or Meteora to serve as its oracle" };
  const flag = pool.mint0.equals(m) ? 1 : 0;
  const windowSecs = defaultWindowSecs(pool.venue, pool.obsData ? oracleHealth(pool.obsData) : null);
  const kp = { bull: Keypair.generate(), bear: Keypair.generate(), config: Keypair.generate() };
  const keys: MarketKeys = {
    key: marketPda(kp.bull.publicKey, kp.bear.publicKey, pool.slotObs, windowSecs, flag),
    bullMint: kp.bull.publicKey, bearMint: kp.bear.publicKey, oraclePool: pool.slotPool, oracleObs: pool.slotObs,
    windowSecs, underlyingIsToken0: flag, config: kp.config.publicKey,
    oracleKind: pool.kind, venuePool: pool.kind === 1 || pool.kind === 2 ? pool.pool : undefined,
  };
  const meta = async (side: "up" | "down") => {
    const r = await fetch(`${SITE}/api/meta?mint=${mint}&s=${side}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error("could not derive the UP/DOWN names from the coin's metadata");
    return (await r.json()) as { name: string; symbol: string };
  };
  const [up, down] = await Promise.all([meta("up"), meta("down")]);
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const legacy = (tx: Transaction, signers: Keypair[]) => {
    tx.feePayer = wallet;
    tx.recentBlockhash = blockhash;
    if (signers.length) tx.partialSign(...signers);
    return Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
  };
  const cfgTx = await dbc.partner.createConfigWithTransferHook({
    ...marketCurve(), config: kp.config.publicKey, feeClaimer: keys.key, leftoverReceiver: wallet, quoteMint: RFSTACC, payer: wallet, transferHookProgram: PROGRAM_ID,
  } as never);
  const curve = (mintKp: Keypair, d: { name: string; symbol: string }, side: "up" | "down") =>
    withPendingConfig(kp.config.publicKey, () =>
      dbc.creator.createPoolWithTransferHook({
        name: d.name, symbol: d.symbol, uri: `${SITE}/api/meta?mint=${mint}&s=${side}`, payer: wallet, poolCreator: wallet,
        config: kp.config.publicKey, baseMint: mintKp.publicKey, transferHookProgram: PROGRAM_ID,
      } as never),
    );
  const upTx = await curve(kp.bull, up, "up");
  const downTx = await curve(kp.bear, down, "down");
  const b = sideAccounts(keys, 0), e = sideAccounts(keys, 1);
  const mktTx = new Transaction().add(
    cu(600_000),
    createAssociatedTokenAccountIdempotentInstruction(wallet, b.escrow, keys.key, keys.bullMint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(wallet, e.escrow, keys.key, keys.bearMint, TOKEN_2022_PROGRAM_ID),
    createMarketIx(wallet, keys),
  );
  return {
    mint, symbol: up.symbol.replace(/UP$/i, "") || null, oraclePool: pool.pool.toBase58(), venue: pool.venue, quote: pool.quote,
    market: keys.key.toBase58(), estRentSol: LISTING_RENT_SOL,
    txs: [legacy(cfgTx as Transaction, [kp.config]), legacy(upTx as Transaction, [kp.bull]), legacy(downTx as Transaction, [kp.bear]), legacy(mktTx, [])],
    steps: ["Curve config", `${up.symbol} curve`, `${down.symbol} curve`, "Market"],
  };
}

// ---------------------------------------------------------------- the plan
/** `only`: build just the legs betting on these coins (the second call after a listing lands), and no listings. */
export async function planLegs(args: { wallet: string | null; hops: HopIn[]; badBeat: boolean; ref?: string | null; build: boolean; only?: string[] | null; markets?: string[] | null; orders?: string[] | null }): Promise<LegsPlan> {
  // `markets`: markets just listed by this swap. The shared snapshot is cached and will not have them for a while, so they
  // are read straight from chain and take precedence for their coin.
  const fresh = (await Promise.all((args.markets ?? []).slice(0, 16).map((k) => loadMarketView(new PublicKey(k)).catch(() => null)))).filter((v): v is MarketView => !!v);
  const freshMints = new Set(fresh.map((v) => v.underlyingMint));
  const views = [...fresh, ...(await allViews()).filter((v) => !freshMints.has(v.underlyingMint) || fresh.some((f) => f.acct.key.equals(v.acct.key)))];
  const mints = [...new Set(args.hops.flatMap((h) => [h.inputMint, h.outputMint]))];
  await decimalsOf(mints);
  const usd = await usdPrices(mints.filter((m) => m !== WSOL));
  const hops: HopLegs[] = [];
  const unplaceable: { mint: string; reason: string }[] = [];
  let total = 0n;
  args.hops.forEach((h, i) => {
    const value = hopLamports(h, usd);
    if (value === null) {
      unplaceable.push({ mint: h.inputMint, reason: `hop ${i + 1} has no SOL side and no price to value it` });
      return;
    }
    const budget = (value * LEG_BPS) / BPS;
    const longHalf = budget / 2n, shortHalf = budget - longHalf;
    const longMint = args.badBeat ? h.inputMint : h.outputMint;
    const shortMint = args.badBeat ? h.outputMint : h.inputMint;
    hops.push({
      hop: i + 1, label: h.label ?? `hop ${i + 1}`, sold: h.inputMint, bought: h.outputMint, valueLamports: value.toString(), legBudget: budget.toString(),
      long: target(views, longMint, "long", longHalf), short: target(views, shortMint, "short", shortHalf),
    });
    total += budget;
  });
  for (const h of hops) {
    for (const t of [h.long, h.short]) {
      if (t.via === "none") unplaceable.push({ mint: t.mint, reason: `hop ${h.hop} ${t.bet}: ${t.note ?? "no available market"}` });
    }
  }
  const plan: LegsPlan = {
    houseBps: Number(HOUSE_BPS), legBps: Number(LEG_BPS), badBeat: args.badBeat, hops, totalLamports: total.toString(),
    listings: [], txs: [], txLabels: [], txBets: [], pending: [], unplaceable,
    costs: { curveFeeBps: 400, potFeeBps: 400, stakeFeeBps: 10, networkLamportsPerTx: 5_000, rentPerNewAccountLamports: 2_074_080 },
  };
  const only = args.only?.length ? new Set(args.only) : null;
  const wanted = (t: LegTarget) => !only || only.has(t.mint);
  const toList = only || args.orders?.length ? [] : [...new Set(hops.flatMap((h) => [h.long, h.short]).filter((t) => t.via === "listing").map((t) => t.mint))];
  if (only) plan.pending = [...new Set(hops.flatMap((h) => [h.long, h.short]).filter((t) => wanted(t) && t.via === "listing").map((t) => t.mint))];
  if (!args.build || !args.wallet) {
    if (!only) plan.pending = toList;
    return plan;
  }
  const wallet = new PublicKey(args.wallet);
  const ref = args.ref ? new PublicKey(args.ref) : null;
  const solUsd = usd[WSOL] ?? null;
  for (const mint of toList) {
    const l = await listingFor(wallet, mint, solUsd).catch((e) => ({ mint, reason: e instanceof Error ? e.message : String(e) }));
    if ("txs" in l) {
      plan.listings.push(l);
      plan.pending.push(mint);
    } else plan.unplaceable.push(l);
  }
  const [pool, refAta] = await Promise.all([poolState(), referral(wallet, ref)]);
  const byKey = new Map(views.map((v) => [v.acct.key.toBase58(), v]));
  // identical bets merge: on a SOL<->stable hop "long SOL" and "short USDC" are the same token on the same market
  const orders = new Map<string, Order>();
  for (const h of hops) {
    for (const t of [h.long, h.short]) {
      if (!wanted(t) || !t.market || t.side === null || BigInt(t.lamports) <= 0n) continue;
      const k = `${t.market}:${t.side}`;
      if (args.orders?.length && !args.orders.includes(k)) continue; // a retry of specific orders only
      const o = orders.get(k) ?? { v: byKey.get(t.market)!, side: t.side, lamports: 0n, bets: [] };
      o.lamports += BigInt(t.lamports);
      o.bets.push({ hop: h.hop, bet: t.bet, mint: t.mint });
      orders.set(k, o);
    }
  }
  // pack orders into as few transactions as fit (fewer network fees, fewer half-done states)
  const ready: { o: Order; ixs: TransactionInstruction[] }[] = [];
  for (const o of orders.values()) {
    try {
      ready.push({ o, ixs: await orderIxs(pool, wallet, o) });
    } catch (e) {
      for (const b of o.bets) plan.unplaceable.push({ mint: b.mint, reason: `hop ${b.hop} ${b.bet}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  const label = (o: Order) => `100× ${o.side ? "DOWN" : "UP"} $${o.v.ticker} (${o.bets.map((b) => `${b.bet} ${b.mint === WSOL ? "SOL" : o.v.ticker}`).join(" + ")})`;
  const meta = (os: Order[]): TxBets => os.map((o) => ({ market: o.v.acct.key.toBase58(), side: o.side, lamports: o.lamports.toString(), ticker: o.v.ticker, bets: o.bets }));
  let group: typeof ready = [];
  let groupWire: string | null = null;
  const flush = () => {
    if (!group.length || !groupWire) return;
    plan.txs.push(groupWire);
    plan.txLabels.push(group.map((g) => label(g.o)).join(" · "));
    plan.txBets.push(meta(group.map((g) => g.o)));
    group = [];
    groupWire = null;
  };
  for (const r of ready) {
    const tryGroup = [...group, r];
    const wire = tryGroup.length <= 4 ? await betsTx(pool, wallet, tryGroup.map((g) => g.o), tryGroup.map((g) => g.ixs), refAta) : null;
    if (wire) {
      group = tryGroup;
      groupWire = wire;
      continue;
    }
    flush();
    const alone = await betsTx(pool, wallet, [r.o], [r.ixs], refAta);
    if (alone) {
      group = [r];
      groupWire = alone;
    } else for (const b of r.o.bets) plan.unplaceable.push({ mint: b.mint, reason: `hop ${b.hop} ${b.bet}: the bet does not fit in one transaction` });
  }
  flush();
  return plan;
}
