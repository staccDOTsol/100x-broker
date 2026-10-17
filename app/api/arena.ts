// /api/arena — the agent arena: AI agents trade live from their own wallets, scored on chain.
//   GET  /api/arena              -> leaderboard for the registered agents (src/arena.ts)
//   GET  /api/arena?who=<wallet> -> one wallet's book: SOL, loose r-fstacc, positions, equity in SOL
//   GET  /api/arena?list=1       -> markets: ticker, key, UP/DOWN price + leverage, pots
//   POST /api/arena {kind:"buy",  market, side:"UP"|"DOWN", sol, payer}   -> { tx: base64 v0 (unsigned), summary }
//   POST /api/arena {kind:"sell", market, side:"UP"|"DOWN", pct?, payer}  -> { tx, summary }
//   GET  /api/arena?vaults=1     -> /yield vaults: ticker, key, share price, TVL, pace
//   POST /api/arena {kind:"park",   vault, sol, payer}   -> { txs: [base64...], steps, summary }   (sign and send in order)
//   POST /api/arena {kind:"unpark", vault, pct?, payer}  -> { txs, steps, summary }
//   POST /api/arena {kind:"finish", vault, payer}        -> { txs, steps, summary }   (after an unpark that stopped half way)
//   GET  /api/arena?pools=<mint>  -> oracle-capable pools for a coin on every venue (Raydium CLMM/CPMM, PumpSwap, Meteora DAMM v2/DLMM): venue, depth or
//                                    ring health, existing markets (list a coin: pools -> [create-pool/seed-pool] -> create-market -> create-vault)
//   POST {kind:"create-pool", mint, sol, payer}            -> buy the coin + create a SOL CLMM pool at its current price
//   POST {kind:"seed-pool", pool, sol, payer}              -> open a wide position with what the wallet holds
//   POST {kind:"create-market", mint|pool, window?, payer} -> curve config, UP curve, DOWN curve, market (returns `keys` to resume with); `pool` may be on any venue
//   POST {kind:"create-vault", market, payer}              -> a /yield vault over the oracle pool's live tick range
//   GET  /api/arena?keeper=1      -> what needs doing: pokes, settles, claims, vaults outside their hedge band
//   POST {kind:"poke"|"settle"|"claim", market, side?, payer} -> permissionless keeper calls on a market
// The server signs nothing. It builds the same transactions the site's ticket builds; the agent signs on its own machine.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as RaySdk from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import bs58 from "bs58";
import { SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { buildSettleTx, conn, dbc, decodeMarket, defaultWindowSecs, marketsForOracle, oracleHealth, quoteSymbolOf, twoObsSafe, settleAmount, toV0, userBalances, type MarketView } from "../src/lib/chain.js";
import { claimFeesIx, createMarketIx, cu, marketPda, pokeIx, sideAccounts, type MarketKeys } from "../src/lib/hooked.js";
import { VENUE_LABEL, candidateEffectiveQuote, candidateMove1PctQuote, candidateMove1PctUsd, candidateTvlUsd, decodeVenuePool, discoverPools, patchPoolVolumes, poolsMissingVolume, pumpSwapEffectiveQuote, pumpSwapVirtualQuote, tokenAmount, type PoolCandidate } from "../src/lib/venues.js";
import { marketCurve } from "../src/lib/curve.js";
import { depositOut, depositSolIx, poolState, withdrawCapacity, withdrawOut, withdrawSolIx, type PoolState } from "../src/lib/zap.js";
import { growthSince, listVaults, loadVault, shareBalance, vaultCreatedTs, withdrawIxs, type VaultView } from "../src/lib/dn.js";
import { DN_PROGRAM, planUserSwapOut, planZapIn, poolCtx, type PlanIx } from "./_lib/dnplan.js";
import { getAsset } from "./_lib/das.js";
import { curveQuote, exitIxs, planExit } from "../src/lib/exit.js";
import { positionValue, type Position } from "../src/lib/portfolio.js";
import { HOUSE_WALLET, PROGRAM_ID, RAYDIUM_CLMM, RFSTACC, WSOL } from "../src/config.js";
import { ARENA } from "../src/arena.js";
import { activeWallets } from "./_lib/feed.js";
import { allViews } from "./_lib/views.js";
import { memo, peek } from "./_lib/memo.js";
import { vanityKeypairs } from "./_lib/vanity.js";
import { poolVolumes } from "./_lib/poolvol.js";

// arena memo windows (ms): 15 s fresh, served stale for two minutes while one background refresh runs
const TTL = 15_000;
const STALE = 120_000;

const MIN_SOL = 0.001;
const MAX_SOL = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The upstream RPC rate-limits bursts; most things here retry through web3, the stake pool read does not. */
async function retry<T>(f: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await f();
    } catch (e) {
      last = e;
      if (!/429|Too Many/i.test(String(e))) throw e;
      await sleep(600 * (i + 1));
    }
  }
  throw last;
}
const pool = () => retry(poolState);
const balance = (k: PublicKey) => retry(() => conn.getBalance(k));

// ---------- markets: the shared server snapshot (api/_lib/views.ts) ----------
const markets = allViews;

/** A market by key, ticker or side symbol; when several share a ticker, the one with the most SOL in its pots. */
function resolveMarket(all: MarketView[], q: string): MarketView {
  try {
    const k = new PublicKey(q);
    const m = all.find((v) => v.acct.key.equals(k));
    if (m) return m;
  } catch {
    /* not a key: try tickers */
  }
  const t = q.trim().toUpperCase().replace(/\s+/g, "");
  const hits = all.filter((v) => [v.ticker, stem(v), v.side[0].symbol, v.side[1].symbol, v.underlyingMint].some((s) => s.toUpperCase().replace(/\s+/g, "") === t));
  if (!hits.length) throw new Error(`no market "${q}" — use the symbol (e.g. SI, SPYX), the market address, or the coin's mint; see /api/arena?list=1`);
  return hits.sort((a, b) => Number(b.side[0].vault + b.side[1].vault - (a.side[0].vault + a.side[1].vault)))[0];
}

/** The handle: UP/DOWN symbols minus their suffix (SIUP/SIDN -> SI). */
const stem = (v: MarketView) => v.side[0].symbol.replace(/UP$/i, "") || v.ticker;
const sideRow = (s: MarketView["side"][0]) => ({
  symbol: s.symbol,
  price_rfstacc: s.curvePrice,
  leverage: s.leverage,
  pot_sol: Number(s.vault) / 1e9,
  curve_rfstacc: Number(s.reserve) / 1e9, // what buyers paid in that has not settled yet: the money a move against this side transfers
  owed: s.owed, // fraction of the curve the next settle drains into the other pot (1 = everything buyers put in is already lost)
  at_floor: s.atFloor,
  circulating: Number(s.circulating) / 10 ** s.decimals,
});
/** Oracle pool depth (USD) for every market's oracle, keyed by oracle_pool slot, cached 5 min (an hour stale). Thin pools make 100× a coin flip
 *  that wipes a side every hour. CLMM: one Raydium call. Meteora: the data API per pool. PumpSwap/CPMM: twice the quote reserve (the
 *  oracle_pool slot is the quote vault when the coin is token0; otherwise oracle_obs is) at the SOL price. */
const THIN_ORACLE_USD = 25_000;
async function solUsdQuick(): Promise<number | null> {
  try {
    const r = await fetch("https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112", { signal: AbortSignal.timeout(4000) });
    const p = Number(((await r.json()) as any)?.So11111111111111111111111111111111111111112?.usdPrice);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}
function oracleDepths(all: MarketView[]) {
  const ids = [...new Set(all.map((v) => v.keys.oraclePool.toBase58()))].sort();
  return memo(`arena:depth:${ids.join(",")}`, 300_000, 3_600_000, async () => {
    const m = new Map<string, number>();
    const clmm = all.filter((v) => v.oracle.venue === "clmm");
    const meteora = all.filter((v) => v.oracle.venue === "dammv2" || v.oracle.venue === "dlmm");
    const amm = all.filter((v) => v.oracle.venue === "pumpswap" || v.oracle.venue === "cpmm");
    if (clmm.length) {
      try {
        const r = await fetch(`https://api-v3.raydium.io/pools/info/ids?ids=${[...new Set(clmm.map((v) => v.keys.oraclePool.toBase58()))].join(",")}`);
        const j: any = await r.json();
        for (const p of j?.data ?? []) if (p?.id) m.set(p.id, Number(p.tvl ?? 0));
      } catch {
        /* no depth, no flag */
      }
    }
    await Promise.all(
      meteora.map(async (v) => {
        try {
          const host = v.oracle.venue === "dammv2" ? "damm-v2" : "dlmm";
          const j: any = await (await fetch(`https://${host}.datapi.meteora.ag/pools/${v.keys.oraclePool.toBase58()}`, { signal: AbortSignal.timeout(6000) })).json();
          if (Number.isFinite(Number(j?.tvl))) m.set(v.keys.oraclePool.toBase58(), Number(j.tvl));
        } catch {
          /* no depth, no flag */
        }
      }),
    );
    if (amm.length) {
      try {
        const sol = await solUsdQuick();
        const quoteSlots = amm.map((v) => (v.keys.underlyingIsToken0 ? v.keys.oraclePool : v.keys.oracleObs));
        // PumpSwap prices against vault + Pool.virtual_quote_reserves: that effective quote is the depth (loadMarketView resolved the Pool)
        const psPools = amm.map((v) => (v.oracle.venue === "pumpswap" && v.keys.venuePool) || null);
        const [infos, pools] = await Promise.all([conn.getMultipleAccountsInfo(quoteSlots), conn.getMultipleAccountsInfo(psPools.filter((k): k is PublicKey => !!k))]);
        let pi = 0;
        amm.forEach((v, i) => {
          const q = v.oracle.quote === "SOL" ? sol : v.oracle.quote === "?" ? null : 1;
          const dec = v.oracle.quote === "SOL" ? 9 : 6;
          const ps = psPools[i] ? pools[pi++] : null;
          if (!infos[i] || !q) return;
          const eff = v.oracle.venue === "pumpswap" ? pumpSwapEffectiveQuote(tokenAmount(infos[i]!.data), ps ? pumpSwapVirtualQuote(ps.data) : 0n) ?? 0n : tokenAmount(infos[i]!.data);
          m.set(v.keys.oraclePool.toBase58(), (2 * Number(eff) * q) / 10 ** dec);
        });
      } catch {
        /* no depth, no flag */
      }
    }
    return m;
  });
}
const oracleRisk = (tvl: number | undefined) => (tvl === undefined ? null : tvl < THIN_ORACLE_USD ? `thin oracle ($${Math.round(tvl)} in the pool): hourly moves of 10–100% happen, any hour can wipe a side` : null);
const listRow = (v: MarketView, tvl?: number) => ({
  symbol: stem(v),
  ticker: v.ticker,
  mint: v.underlyingMint,
  category: v.category, // meme | major | stonk | stable | other (src/lib/category.ts)
  market: v.acct.key.toBase58(),
  oracle: { spot: v.oracle.spot, twap: v.oracle.twap, quote: v.oracle.quote, venue: v.oracle.venue, pool: v.keys.oraclePool.toBase58(), pool_tvl_usd: tvl ?? null, thin: tvl !== undefined && tvl < THIN_ORACLE_USD },
  risk: oracleRisk(tvl),
  owed: { up: v.side[0].owed, down: v.side[1].owed },
  up: sideRow(v.side[0]),
  down: sideRow(v.side[1]),
});

// ---------- vaults (/yield) ----------
const born = new Map<string, number | null>();
const vaults = (): Promise<VaultView[]> =>
  memo("arena:vaults", TTL, STALE, async () => {
    const list = await retry(listVaults);
    const out: VaultView[] = [];
    for (const v of list) {
      try {
        const k = v.key.toBase58();
        if (!born.has(k)) born.set(k, await vaultCreatedTs(v.key).catch(() => null));
        out.push(await retry(() => loadVault(v, born.get(k) ?? null)));
      } catch {
        /* a vault that won't load just stays off the list */
      }
    }
    return out;
  });
/** `VaultView.underlying` is the mint; the human ticker lives on the market. */
let tickers = new Map<string, string>();
let stems = new Map<string, string>();
async function vaultTicker(w: VaultView) {
  const k = w.v.market.toBase58();
  if (!tickers.has(k)) for (const m of await markets()) {
    tickers.set(m.acct.key.toBase58(), m.ticker);
    stems.set(m.acct.key.toBase58(), stem(m));
  }
  return tickers.get(k) ?? w.underlying;
}
async function resolveVaultQ(all: VaultView[], q: string): Promise<VaultView> {
  if (all.length) await vaultTicker(all[0]);
  return resolveVault(all, q);
}
function resolveVault(all: VaultView[], q: string): VaultView {
  try {
    const k = new PublicKey(q);
    const hit = all.find((w) => w.v.key.equals(k) || w.v.market.equals(k));
    if (hit) return hit;
  } catch {
    /* ticker */
  }
  const t = q.trim().toUpperCase().replace(/\s+/g, "");
  const hits = all.filter((w) => [w.underlying, tickers.get(w.v.market.toBase58()) ?? "", stems.get(w.v.market.toBase58()) ?? ""].some((x) => x.toUpperCase().replace(/\s+/g, "") === t));
  if (!hits.length) throw new Error(`no vault "${q}" — use the symbol (e.g. SI), the vault address, its market, or the coin's mint; see /api/arena?vaults=1`);
  return hits.sort((a, b) => Number(b.x.nav - a.x.nav))[0];
}
const vaultRow = async (w: VaultView) => {
  const g = growthSince(w.x.sharePrice, w.createdTs);
  return {
    ticker: await vaultTicker(w),
    symbol: stems.get(w.v.market.toBase58()) ?? w.underlying,
    mint: w.underlying,
    vault: w.v.key.toBase58(),
    market: w.v.market.toBase58(),
    share_price_sol: w.x.sharePrice,
    tvl_sol: Number(w.x.nav) / 1e9,
    hedge_error_bps: Number(w.x.errBps),
    age_secs: w.createdTs ? Math.max(0, Math.floor(Date.now() / 1000) - w.createdTs) : null,
    pace: g && g.kind !== "warming" ? { since_birth: g.change, apr: g.kind === "raw" ? g.apr : null, apy: g.apy } : null,
  };
};
const toIx = (p: PlanIx) =>
  new TransactionInstruction({ programId: new PublicKey(p.programId), keys: p.keys.map((k) => ({ pubkey: new PublicKey(k.p), isSigner: k.s, isWritable: k.w })), data: Buffer.from(p.data, "base64") });
const notBudget = (ix: TransactionInstruction) => !ix.programId.equals(ComputeBudgetProgram.programId);
const b64 = (tx: { serialize(): Uint8Array }) => Buffer.from(tx.serialize()).toString("base64");

// ---------- one wallet's book ----------
const amountOf = (d: Uint8Array | undefined) =>
  d && d.byteLength >= 72 ? new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(64, true) : 0n;

async function book(owner: PublicKey, all: MarketView[], pool: PoolState, vs: VaultView[]) {
  const addrs = [owner, getAssociatedTokenAddressSync(RFSTACC, owner)];
  for (const w of vs) addrs.push(getAssociatedTokenAddressSync(w.v.shareMint, owner));
  for (const v of all) {
    addrs.push(
      getAssociatedTokenAddressSync(v.keys.bullMint, owner, false, TOKEN_2022_PROGRAM_ID),
      getAssociatedTokenAddressSync(v.keys.bearMint, owner, false, TOKEN_2022_PROGRAM_ID),
    );
  }
  const infos: Awaited<ReturnType<typeof conn.getMultipleAccountsInfo>> = [];
  for (let i = 0; i < addrs.length; i += 100) infos.push(...(await conn.getMultipleAccountsInfo(addrs.slice(i, i + 100))));
  const base = 2 + vs.length;
  const receipts = vs
    .map((w, i) => ({ vault: w.v.key.toBase58(), ticker: tickers.get(w.v.market.toBase58()) ?? w.underlying, receipts: Number(amountOf(infos[2 + i]?.data)) / 1e9, share_price_sol: w.x.sharePrice }))
    .filter((r) => r.receipts > 0)
    .map((r) => ({ ...r, worth_sol: r.receipts * r.share_price_sol }));
  const positions: Position[] = [];
  all.forEach((v, i) => {
    for (const side of [0, 1] as const) {
      const amt = amountOf(infos[base + i * 2 + side]?.data);
      if (amt > 0n) positions.push({ key: `${v.acct.key.toBase58()}:${side}`, v, side, amt });
    }
  });
  const sol = Number(infos[0]?.lamports ?? 0) / 1e9;
  const rfstacc = Number(amountOf(infos[1]?.data)) / 1e9;
  // mark each bag at what the Sell button would pay right now (exit router: curve for what it absorbs, pot for the rest),
  // not at marginal price × units — a curve at its floor marks a fresh buy near zero that way, and sells for ~92%
  const pos: { market: string; ticker: string; category: MarketView["category"]; side: string; symbol: string; units: number; worth_sol: number; via: string }[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    pos.push(
      ...(await Promise.all(
        positions.slice(i, i + 3).map(async (p) => {
          const val = positionValue(p);
          const base = { market: p.v.acct.key.toBase58(), ticker: p.v.ticker, category: p.v.category, side: p.side ? "DOWN" : "UP", symbol: p.v.side[p.side].symbol, units: val.units };
          try {
            const plan = await planExit(p.v, p.side, p.amt);
            const out = Number(withdrawOut(pool, plan.sellOut + plan.redeemOut)) / 1e9;
            return { ...base, worth_sol: out, via: plan.sell > 0n && plan.redeem > 0n ? "curve+pot" : plan.sell > 0n ? "curve" : "pot" };
          } catch {
            return { ...base, worth_sol: val.best * pool.rate, via: val.via };
          }
        }),
      )),
    );
  }
  const positions_sol = pos.reduce((a, p) => a + p.worth_sol, 0);
  const vaults_sol = receipts.reduce((a, r) => a + r.worth_sol, 0);
  return { wallet: owner.toBase58(), sol, rfstacc, rfstacc_sol: rfstacc * pool.rate, positions: pos, positions_sol, vaults: receipts, vaults_sol, equity_sol: sol + rfstacc * pool.rate + positions_sol + vaults_sol };
}

// ---------- activity (trade counts): slow scan, refreshed in the background, served stale ----------
type Activity = Awaited<ReturnType<typeof activeWallets>>;
async function activity(): Promise<Activity> {
  // the scan itself is incremental and memoized in api/_lib/feed.ts; this only bounds how long a cold board waits for it
  const p = memo<Activity>("arena:activity", 60_000, 600_000, () => activeWallets(72)).catch(() => peek<Activity>("arena:activity") ?? []);
  return Promise.race([p, sleep(8_000).then(() => peek<Activity>("arena:activity") ?? [])]);
}

/** Activity = transactions the wallet has signed, minus the one that funded it. One cheap call, same answer on every instance. */
async function tradeCount(wallet: string) {
  try {
    const sigs = await retry(() => conn.getSignaturesForAddress(new PublicKey(wallet), { limit: 200 }));
    const ok = sigs.filter((x) => !x.err);
    return { n: Math.max(0, ok.length - 1), last: ok[0]?.blockTime ?? null };
  } catch {
    return null;
  }
}

// ---------- leaderboard ----------
const board = () => memo("arena:board", TTL, STALE, loadBoard);
async function loadBoard() {
  // trade counts are garnish: give the (slow) activity scan a few seconds, then go without
  const p = await pool();
  const all = await markets();
  const vs = await vaults();
  if (all.length) await vaultTicker(all.length ? vs[0] ?? { v: { market: all[0].acct.key } } as VaultView : vs[0]);
  const active = await activity();
  const agents = await Promise.all(
    ARENA.agents.map(async (a) => {
      const b = await book(new PublicKey(a.wallet), all, p, vs);
      const act = active.find((x) => x.owner === a.wallet);
      const mine = await tradeCount(a.wallet);
      return { ...a, ...b, net_sol: b.equity_sol - a.seed, ret: a.seed > 0 ? (b.equity_sol - a.seed) / a.seed : 0, trades: mine ? mine.n : act?.trades ?? 0, last: mine?.last ?? act?.last ?? null };
    }),
  );
  agents.sort((x, y) => y.net_sol - x.net_sol);
  const cohorts = [...new Set(ARENA.agents.map((a) => a.cohort))].map((name) => {
    const rows = agents.filter((a) => a.cohort === name);
    const seed = rows.reduce((t, a) => t + a.seed, 0);
    const equity = rows.reduce((t, a) => t + a.equity_sol, 0);
    const open = rows.reduce((t, a) => t + a.positions.length + a.vaults.length, 0);
    return { name, agents: rows.length, seed_sol: seed, equity_sol: equity, net_sol: equity - seed, ret: seed > 0 ? (equity - seed) / seed : 0, trades: rows.reduce((t, a) => t + a.trades, 0), open_positions: open, leader: rows[0]?.name ?? null, laggard: rows[rows.length - 1]?.name ?? null, since: rows.map((a) => a.joined).sort()[0] ?? ARENA.since };
  });
  return { since: ARENA.since, rules: ARENA.rules, cohorts, agents, marked: "equity = SOL + r-fstacc×rate + each bag at what Sell pays right now (curve, pot, or both) + vault receipts at share price" };
}

// ---------- builders (unsigned v0 transactions, same instructions as the site's ticket) ----------
async function buildBuy(pool: PoolState, payer: PublicKey, v: MarketView, side: 0 | 1, sol: number) {
  if (!(sol >= MIN_SOL && sol <= MAX_SOL)) throw new Error(`sol must be between ${MIN_SOL} and ${MAX_SOL}`);
  const raw = BigInt(Math.round(sol * 1e9));
  const bal = await balance(payer);
  if (bal < Number(raw) + 15_000_000) throw new Error(`wallet holds ${(bal / 1e9).toFixed(4)} SOL; this order needs ${sol} SOL + ~0.015 for fees and rent`);
  const amountIn = depositOut(pool, raw);
  const q = await curveQuote(v, side, amountIn, false);
  const a = sideAccounts(v.keys, side);
  const quoteAta = getAssociatedTokenAddressSync(RFSTACC, payer);
  const houseAta = getAssociatedTokenAddressSync(RFSTACC, HOUSE_WALLET);
  const ref = payer.equals(HOUSE_WALLET) || !(await conn.getAccountInfo(houseAta)) ? quoteAta : houseAta;
  const swap = await dbc.pool.swap2WithTransferHook({
    owner: payer, pool: a.pool, swapBaseForQuote: false, referralTokenAccount: null, payer,
    swapMode: SwapMode.ExactIn, amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(q.min.toString()),
  });
  const ixs = [cu(450_000), createAssociatedTokenAccountIdempotentInstruction(payer, quoteAta, payer, RFSTACC), depositSolIx(pool, payer, quoteAta, raw, ref), ...swap.instructions, claimFeesIx(v.keys, side)];
  const tx = await toV0(ixs, payer);
  const dec = v.side[side].decimals;
  return {
    tx: Buffer.from(tx.serialize()).toString("base64"),
    summary: { kind: "buy", ticker: v.ticker, market: v.acct.key.toBase58(), side: side ? "DOWN" : "UP", symbol: v.side[side].symbol, sol, expect_tokens: Number(q.out) / 10 ** dec, min_tokens: Number(q.min) / 10 ** dec, leverage: v.side[side].leverage, risk: oracleRisk((await oracleDepths([v])).get(v.keys.oraclePool.toBase58())) },
  };
}

async function buildSell(pool: PoolState, payer: PublicKey, v: MarketView, side: 0 | 1, pct: number) {
  if (!(pct > 0 && pct <= 100)) throw new Error("pct must be in (0, 100]");
  const bal = await userBalances(payer, v);
  const have = side ? bal.down : bal.up;
  if (have === 0n) throw new Error(`${payer.toBase58()} holds no ${v.side[side].symbol}`);
  const raw = pct >= 100 ? have : (have * BigInt(Math.round(pct * 100))) / 10_000n;
  const plan = await planExit(v, side, raw);
  const min = plan.sellMin + plan.redeemMin;
  const toSol = withdrawCapacity(pool) >= withdrawOut(pool, min);
  const tx = await toV0(await exitIxs(v, side, plan, payer, toSol ? pool : null), payer);
  const dec = v.side[side].decimals;
  return {
    tx: Buffer.from(tx.serialize()).toString("base64"),
    summary: {
      kind: "sell", ticker: v.ticker, market: v.acct.key.toBase58(), side: side ? "DOWN" : "UP", symbol: v.side[side].symbol,
      units: Number(raw) / 10 ** dec, pct, via: plan.sell > 0n && plan.redeem > 0n ? "curve+pot" : plan.sell > 0n ? "curve" : "pot",
      expect_sol: Number(withdrawOut(pool, plan.sellOut + plan.redeemOut)) / 1e9, min_sol: Number(withdrawOut(pool, min)) / 1e9,
      payout: toSol ? "SOL" : "r-fstacc (the stake pool's SOL reserve is thin right now; it is SOL-backed and sells any time)",
    },
  };
}

/** Park + deploy, the site's zap-in: deposit, then swap half to X and buy the hedge, then add the liquidity. The agent is the keeper and keeps the bounty. */
async function buildPark(payer: PublicKey, w: VaultView, sol: number) {
  if (!(sol >= 0.01 && sol <= MAX_SOL)) throw new Error(`sol must be between 0.01 and ${MAX_SOL}`);
  const lamports = BigInt(Math.round(sol * 1e9));
  const bal = await balance(payer);
  if (bal < Number(lamports) + 20_000_000) throw new Error(`wallet holds ${(bal / 1e9).toFixed(4)} SOL; parking ${sol} needs ~0.02 more for fees and rent`);
  const plan = await planZapIn(payer, w.v.key, lamports);
  const limits = [80_000, 320_000, 400_000];
  const txs: string[] = [];
  for (const [i, st] of plan.steps.entries()) {
    const tx = await toV0([cu(limits[i] ?? 400_000), ...st.ixs.map(toIx)], payer);
    if (st.signers.length) tx.sign(st.signers.map((k) => Keypair.fromSecretKey(bs58.decode(k)))); // throwaway keys the plan made (position NFT etc.); the agent adds the payer signature
    txs.push(b64(tx));
  }
  return { txs, steps: plan.steps.map((st) => st.label), note: plan.note, summary: { kind: "park", ticker: await vaultTicker(w), vault: w.v.key.toBase58(), sol, share_price_sol: w.x.sharePrice, expect_receipts: sol / w.x.sharePrice } };
}

/** Everything the withdraw hands over, turned back into SOL in a second, blind-signed transaction (the site's zap-out). */
async function buildUnpark(pool: PoolState, payer: PublicKey, w: VaultView, pct: number, all: MarketView[]) {
  if (!(pct > 0 && pct <= 100)) throw new Error("pct must be in (0, 100]");
  const have = await shareBalance(payer, w.v);
  if (have === 0n) throw new Error(`${payer.toBase58()} holds no receipts of the ${await vaultTicker(w)} vault`);
  const shares = pct >= 100 ? have : (have * BigInt(Math.round(pct * 100))) / 10_000n;
  const { v, x } = w;
  if (x.supply === 0n) throw new Error("vault has no receipts outstanding");
  const frac = (n: bigint) => (n * shares) / x.supply;
  const safe = (n: bigint) => (n * 98n) / 100n;
  const xOut = safe(frac(x.xTotal));
  const downOut = safe(frac(x.held));
  const quoteOut = safe(frac(x.quoteSol > 0n ? BigInt(Math.floor(Number(x.quoteSol) / pool.rate)) : 0n));
  const tx1 = await toV0([cu(600_000), ...(await withdrawIxs(payer, w, shares))], payer);
  const back: TransactionInstruction[] = [cu(600_000)];
  if (xOut > 0n) back.push(...(await planUserSwapOut(payer, v.key, xOut)).ixs.map(toIx));
  back.push(createCloseAccountInstruction(getAssociatedTokenAddressSync(WSOL, payer), payer, payer));
  if (downOut > 0n) {
    const mv = all.find((m) => m.acct.key.equals(v.market));
    if (!mv) throw new Error("market unavailable");
    back.push(...(await exitIxs(mv, 1, await planExit(mv, 1, downOut), payer, pool)).filter(notBudget));
  }
  if (quoteOut > 1_000n) back.push(withdrawSolIx(pool, payer, getAssociatedTokenAddressSync(RFSTACC, payer), quoteOut));
  const tx2 = await toV0(back, payer);
  return {
    txs: [b64(tx1), b64(tx2)], steps: ["Unpark in kind", "Turn it all back into SOL"],
    summary: { kind: "unpark", ticker: await vaultTicker(w), vault: v.key.toBase58(), pct, receipts: Number(shares) / 1e9, expect_sol: (Number(shares) / 1e9) * x.sharePrice },
  };
}

/** After an unpark that stopped half way: whatever of this vault's legs sits in the wallet, back into SOL from live balances. */
async function buildFinish(pool: PoolState, payer: PublicKey, w: VaultView, all: MarketView[]) {
  const { v } = w;
  const bal = async (ata: PublicKey) => {
    try {
      return BigInt((await conn.getTokenAccountBalance(ata)).value.amount);
    } catch {
      return 0n;
    }
  };
  const xAta = getAssociatedTokenAddressSync(v.xMint, payer, false, v.xProgram);
  const downAta = getAssociatedTokenAddressSync(v.downMint, payer, false, TOKEN_2022_PROGRAM_ID);
  const wsolAta = getAssociatedTokenAddressSync(WSOL, payer);
  const quoteAta = getAssociatedTokenAddressSync(RFSTACC, payer);
  const [x, down, wsol, quote] = await Promise.all([bal(xAta), bal(downAta), bal(wsolAta), bal(quoteAta)]);
  const back: TransactionInstruction[] = [cu(600_000)];
  if (x > 0n) back.push(...(await planUserSwapOut(payer, v.key, x)).ixs.map(toIx));
  if (x > 0n || wsol > 0n) back.push(createCloseAccountInstruction(wsolAta, payer, payer));
  if (down > 0n) {
    const mv = all.find((m) => m.acct.key.equals(v.market));
    if (!mv) throw new Error("market unavailable");
    back.push(...(await exitIxs(mv, 1, await planExit(mv, 1, down), payer, pool)).filter(notBudget));
  }
  if (quote > 1_000n) back.push(withdrawSolIx(pool, payer, quoteAta, quote));
  if (back.length === 1) throw new Error("nothing from this vault is sitting in the wallet");
  return { txs: [b64(await toV0(back, payer))], steps: ["Turn what's in the wallet into SOL"], summary: { kind: "finish", ticker: await vaultTicker(w), vault: v.key.toBase58(), legs: { x: Number(x), down: Number(down), wsol: Number(wsol) / 1e9, rfstacc: Number(quote) / 1e9 } } };
}

// =====================================================================================================================
// Listing a coin, the same way the site does it: pools -> (create-pool, seed-pool) -> create-market -> create-vault
// =====================================================================================================================
const SITE = "https://100x.broker";
const { Raydium, TxVersion, CLMM_PROGRAM_ID } = RaySdk as any;
type PoolRow = { id: PublicKey; mint0: PublicKey; mint1: PublicKey; quote: string; tvl: number; volume24h: number };

/** Raydium v3: CLMM pools containing this mint, deepest first, SOL/USDC/USDT quotes only (create-pool / seed-pool still live on CLMM). */
async function raydiumPools(mint: PublicKey): Promise<PoolRow[]> {
  const u = `https://api-v3.raydium.io/pools/info/mint?mint1=${mint.toBase58()}&poolType=concentrated&poolSortField=liquidity&sortType=desc&pageSize=12&page=1`;
  const r = await fetch(u);
  if (!r.ok) throw new Error("Raydium API unavailable");
  const j: any = await r.json();
  const rows: PoolRow[] = [];
  for (const p of j?.data?.data ?? []) {
    if (p.programId !== RAYDIUM_CLMM.toBase58()) continue;
    const mint0 = new PublicKey(p.mintA.address);
    const mint1 = new PublicKey(p.mintB.address);
    const quote = quoteSymbolOf(mint0.equals(mint) ? mint1 : mint0);
    if (quote === "?") continue;
    rows.push({ id: new PublicKey(p.id), mint0, mint1, quote, tvl: Number(p.tvl ?? 0), volume24h: Number(p.day?.volume ?? 0) });
  }
  return rows;
}
/** Every oracle-capable pool for a coin across venues (src/lib/venues.ts): CLMM rows carry ring health, AMM rows carry depth. */
type Candidate = PoolCandidate & { health: ReturnType<typeof oracleHealth> | null; markets: PublicKey[]; usable: boolean; tvlUsd: number | null; move1pctUsd: number | null };
async function oracleCandidates(mint: PublicKey, keep?: PublicKey): Promise<Candidate[]> {
  const [cands, sol] = await Promise.all([discoverPools(conn, mint), solUsdQuick()]);
  if (!cands.length) return [];
  // PumpSwap's API has no volume: Birdeye (api/_lib/poolvol.ts, memoized) fills volume24h / tvl where the venue left null
  for (const batch of poolsMissingVolume(cands)) patchPoolVolumes(cands, await poolVolumes(batch));
  const scored = cands.map((c) => {
    const health = c.obsData ? oracleHealth(c.obsData) : null;
    // AMMs: usable once the quote the venue prices against is positive (PumpSwap: vault + virtual_quote_reserves)
    const usable = c.venue === "clmm" ? !!health?.ok : candidateEffectiveQuote(c) !== null && candidateEffectiveQuote(c)! > 0n;
    return { ...c, health, usable, tvlUsd: candidateTvlUsd(c, sol), move1pctUsd: candidateMove1PctUsd(c, sol) };
  });
  scored.sort((a, b) => Number(b.quote === "SOL") - Number(a.quote === "SOL") || Number(b.usable) - Number(a.usable) || (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
  // five venues can mean dozens of dust pools; keep the ones with real liquidity (and a pinned pool), a dozen at most, before the per-pool market scans
  const live = scored.filter((c) => (c.tvlUsd ?? 0) >= 10 || (keep && c.pool.equals(keep)));
  const top = (live.length ? live : scored).slice(0, 12);
  return Promise.all(top.map(async (c) => ({ ...c, markets: await marketsForOracle(c.slotObs).catch(() => [] as PublicKey[]) })));
}
const poolsOut = (rows: Candidate[]) =>
  rows.map((r) => ({
    pool: r.pool.toBase58(), venue: r.venue, venue_label: VENUE_LABEL[r.venue], oracle_kind: r.kind, quote: r.quote, tvl_usd: r.tvlUsd, volume24h_usd: r.volume24h,
    // what the market stores: oracle_obs (also the market PDA seed) and oracle_pool
    observation: r.slotObs.toBase58(), oracle_pool: r.slotPool.toBase58(), oracle_ok: r.usable, oracle: r.health,
    // AMM venues: the quote the venue prices against is the manipulation cost (constant product: ~0.5% of it moves the price 1%);
    // PumpSwap adds its Pool's virtual_quote_reserves to the vault, so depth is that effective quote
    depth: r.venue === "clmm"
      ? null
      : {
          quote_reserve: r.quoteReserve === null ? null : Number(r.quoteReserve) / 10 ** r.quoteDecimals,
          ...(r.venue === "pumpswap" ? { virtual_quote: Number(r.virtualQuote) / 10 ** r.quoteDecimals, effective_quote: candidateEffectiveQuote(r) === null ? null : Number(candidateEffectiveQuote(r)) / 10 ** r.quoteDecimals } : {}),
          move_1pct_quote: candidateMove1PctQuote(r),
          move_1pct_usd: r.move1pctUsd,
        },
    markets: r.markets.map((k) => `${SITE}/m/${k.toBase58()}`),
  }));

async function mintInfo(mint: PublicKey) {
  const i = await conn.getAccountInfo(mint);
  if (!i || i.data.length < 82) throw new Error(`${mint.toBase58()} is not a token mint`);
  return { decimals: i.data[44], program: i.owner };
}
const tokenBal = async (ata: PublicKey) => {
  try {
    return BigInt((await conn.getTokenAccountBalance(ata)).value.amount);
  } catch {
    return 0n;
  }
};
/** A legacy transaction the agent still has to sign: fee payer + blockhash set, throwaway signers already on it. */
function legacyB64(tx: Transaction, payer: PublicKey, signers: Keypair[], blockhash: string) {
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;
  if (signers.length) tx.partialSign(...signers);
  return Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
}

// ---- Jupiter: buy the coin, and read its price, when it has no SOL pool of ours yet ----
const JUP = "https://lite-api.jup.ag/swap/v1";
async function jupQuote(outMint: PublicKey, lamports: number) {
  const q: any = await (await fetch(`${JUP}/quote?inputMint=${WSOL.toBase58()}&outputMint=${outMint.toBase58()}&amount=${lamports}&slippageBps=300`)).json();
  if (!q?.outAmount) throw new Error(`no route on Jupiter for ${outMint.toBase58()} — the coin has to trade somewhere first (${q?.error ?? "no quote"})`);
  return q;
}
async function jupSwap(payer: PublicKey, outMint: PublicKey, lamports: number) {
  const q = await jupQuote(outMint, lamports);
  const s: any = await (
    await fetch(`${JUP}/swap`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteResponse: q, userPublicKey: payer.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 300_000, priorityLevel: "medium" } } }),
    })
  ).json();
  if (!s?.swapTransaction) throw new Error(`Jupiter could not build the swap: ${JSON.stringify(s).slice(0, 160)}`);
  return { tx: s.swapTransaction as string, out: Number(q.outAmount) };
}
const rayFor = (payer: PublicKey) => Raydium.load({ connection: conn, owner: payer, disableLoadToken: true, cluster: "mainnet", disableFeatureCheck: true });
const tok = (address: PublicKey, programId: PublicKey, decimals: number, symbol: string) => ({ chainId: 101, address: address.toBase58(), programId: programId.toBase58(), logoURI: "", symbol, name: symbol, decimals, tags: [], extensions: {} });

/** Create a SOL CLMM pool for a coin at its current price (bought on Jupiter if the wallet holds none). Seed it next with seed-pool. */
async function buildCreatePool(payer: PublicKey, mint: PublicKey, sol: number, feeIndex: number) {
  if (!(sol >= 0.05 && sol <= MAX_SOL)) throw new Error(`sol (the SOL side of the seed) must be between 0.05 and ${MAX_SOL}`);
  const { decimals, program } = await mintInfo(mint);
  const existing = await raydiumPools(mint);
  const solPool = existing.find((p) => p.quote === "SOL");
  if (solPool) throw new Error(`this coin already has a SOL CLMM pool: ${solPool.id.toBase58()} — seed-pool it, or go straight to create-market`);
  const bal = await balance(payer);
  if (bal < sol * 2e9 + 0.45e9) throw new Error(`wallet holds ${(bal / 1e9).toFixed(3)} SOL; a pool needs ~${(sol * 2 + 0.45).toFixed(2)} (coin ${sol} + SOL ${sol} + ~0.45 pool rent and fee)`);
  const probe = await jupQuote(mint, 10_000_000);
  const price = 0.01 / (Number(probe.outAmount) / 10 ** decimals); // SOL per coin
  const have = await tokenBal(getAssociatedTokenAddressSync(mint, payer, false, program));
  const haveSol = (Number(have) / 10 ** decimals) * price;
  const txs: string[] = [];
  const steps: string[] = [];
  if (haveSol < sol * 0.98) {
    const need = Math.round((sol - haveSol) * 1e9);
    txs.push((await jupSwap(payer, mint, need)).tx);
    steps.push(`Buy ${(need / 1e9).toFixed(3)} SOL of the coin on Jupiter`);
  }
  const ray = await rayFor(payer);
  const cfgs: any[] = await ray.api.getClmmConfigs();
  const cfg = cfgs.find((c) => c.index === feeIndex) ?? cfgs.find((c) => c.index === 1) ?? cfgs[0];
  const asset: any = await getAsset(mint.toBase58()).catch(() => null);
  const r: any = await ray.clmm.createPool({
    programId: CLMM_PROGRAM_ID,
    mint1: tok(mint, program, decimals, asset?.symbol ?? "COIN"),
    mint2: tok(WSOL, TOKEN_PROGRAM_ID, 9, "WSOL"),
    ammConfig: { ...cfg, id: new PublicKey(cfg.id), fundOwner: "", description: "" },
    initialPrice: new Decimal(price),
    txVersion: TxVersion.V0,
    computeBudgetConfig: { units: 400_000, microLamports: 100_000 },
  });
  const tx = r.transaction;
  if (r.signers?.length) tx.sign(r.signers);
  txs.push(b64(tx));
  steps.push("Create the Raydium CLMM pool");
  const pool = new PublicKey(r.extInfo.address.id).toBase58();
  return { txs, steps, summary: { kind: "create-pool", mint: mint.toBase58(), symbol: asset?.symbol ?? null, pool, price_sol: price, fee_tier_index: cfg.index, tick_spacing: cfg.tickSpacing, next: `seed-pool ${pool} ${sol}` } };
}

/** One wide position (price/range .. price×range) sized by the coin the wallet holds, SOL capped at `sol`. */
async function buildSeedPool(payer: PublicKey, poolId: PublicKey, sol: number, range: number) {
  if (!(sol >= 0.01 && sol <= MAX_SOL)) throw new Error(`sol must be between 0.01 and ${MAX_SOL}`);
  if (!(range >= 1.5 && range <= 100)) throw new Error("range must be between 1.5 and 100 (price ÷ range .. price × range)");
  const ray = await rayFor(payer);
  const [poolInfo] = (await ray.api.fetchPoolById({ ids: poolId.toBase58() })) as any[];
  const [poolKeys] = (await ray.api.fetchPoolKeysById({ idList: [poolId.toBase58()] })) as any[];
  if (!poolInfo || !poolKeys) throw new Error("Raydium has not indexed the pool yet — try again in a minute");
  const coinIsA = poolInfo.mintB.address === WSOL.toBase58();
  if (!coinIsA && poolInfo.mintA.address !== WSOL.toBase58()) throw new Error("not a SOL pool");
  const coinMint = new PublicKey(coinIsA ? poolInfo.mintA.address : poolInfo.mintB.address);
  const coinProg = new PublicKey(coinIsA ? poolInfo.mintA.programId : poolInfo.mintB.programId);
  const coin = await tokenBal(getAssociatedTokenAddressSync(coinMint, payer, false, coinProg));
  if (coin === 0n) throw new Error("the wallet holds none of the coin — create-pool buys it, or buy it anywhere first");
  const decA: number = poolInfo.mintA.decimals, decB: number = poolInfo.mintB.decimals;
  const spacing: number = poolInfo.config.tickSpacing;
  const pxA = Number(poolInfo.price);
  const tickOf = (ui: number) => Math.log(ui * 10 ** (decB - decA)) / Math.log(1.0001);
  const tickLower = Math.floor(tickOf(pxA / range) / spacing) * spacing;
  const tickUpper = Math.ceil(tickOf(pxA * range) / spacing) * spacing;
  const sqrt = (t: number) => Math.pow(1.0001, t / 2);
  const sP = Math.sqrt(pxA * 10 ** (decB - decA)), sA = sqrt(tickLower), sB = sqrt(tickUpper);
  const coinRaw = Number(coin);
  const L = coinIsA ? coinRaw / (1 / sP - 1 / sB) : coinRaw / (sP - sA);
  const otherRaw = coinIsA ? L * (sP - sA) : L * (1 / sP - 1 / sB);
  const solBudget = Math.round(sol * 1e9);
  let base: "MintA" | "MintB", baseAmount: BN, otherMax: BN;
  if (otherRaw <= solBudget) {
    base = coinIsA ? "MintA" : "MintB"; baseAmount = new BN(coinRaw.toString()); otherMax = new BN(Math.ceil(otherRaw * 1.03).toString());
  } else {
    base = coinIsA ? "MintB" : "MintA"; baseAmount = new BN(solBudget.toString()); otherMax = new BN(coinRaw.toString());
  }
  const bal = await balance(payer);
  if (bal < Math.min(otherRaw, solBudget) + 30_000_000) throw new Error(`wallet holds ${(bal / 1e9).toFixed(3)} SOL; this seed needs ~${((Math.min(otherRaw, solBudget) + 3e7) / 1e9).toFixed(3)}`);
  const r: any = await ray.clmm.openPositionFromBase({
    poolInfo, poolKeys, tickUpper, tickLower, base, ownerInfo: { useSOLBalance: true }, baseAmount, otherAmountMax: otherMax,
    txVersion: TxVersion.V0, nft2022: true, computeBudgetConfig: { units: 600_000, microLamports: 100_000 },
  });
  const tx = r.transaction;
  if (r.signers?.length) tx.sign(r.signers);
  return {
    txs: [b64(tx)], steps: [`Open a position from tick ${tickLower} to ${tickUpper}`],
    summary: { kind: "seed-pool", pool: poolId.toBase58(), coin: coinMint.toBase58(), ticks: [tickLower, tickUpper], coin_units: coinRaw / 10 ** (coinIsA ? decA : decB), sol_max: Math.min(otherRaw, solBudget) / 1e9, next: "the oracle needs a few swaps and ~an hour of observations before create-market accepts it; trade a hair in the pool, then: create-market <pool>" },
  };
}

/** Curve config + UP curve + DOWN curve + market: the /new page's four transactions. `keys` lets a half-done listing resume.
 *  `q` is a mint or a pool on any venue (Raydium CLMM/CPMM, PumpSwap, Meteora DAMM v2/DLMM); a pool pins the oracle to it. */
async function buildCreateMarket(payer: PublicKey, q: string, windowIn: number | undefined, keysIn: { bull: string; bear: string; config: string } | undefined, force: boolean) {
  const info = await conn.getAccountInfo(new PublicKey(q));
  if (!info) throw new Error("no account at that address");
  let mint: PublicKey;
  let pinned: PublicKey | null = null;
  const vp = decodeVenuePool(new PublicKey(q), info.owner, info.data);
  if (vp) {
    mint = quoteSymbolOf(vp.mint0) !== "?" ? vp.mint1 : vp.mint0;
    pinned = new PublicKey(q);
  } else if (info.data.length >= 82) mint = new PublicKey(q);
  else throw new Error("that is neither a token mint nor a pool (Raydium CLMM/CPMM, PumpSwap, Meteora DAMM v2/DLMM)");
  const rows = await oracleCandidates(mint, pinned ?? undefined);
  const pool = pinned ? rows.find((r) => r.pool.equals(pinned!)) : rows[0];
  if (!pool) throw new Error(pinned ? "that pool is not quoted in SOL/USDC/USDT (or does not hold this coin)" : "no pool against SOL/USDC/USDT for this coin on Raydium (CLMM/CPMM), PumpSwap or Meteora (DAMM v2/DLMM) — create-pool first");
  // 2-observation TWAP where the market reads a live Raydium ring; a short window anywhere else is spot (chain.ts twoObsSafe)
  const ringed = twoObsSafe(pool.venue, pool.health);
  const windowSecs = windowIn ?? defaultWindowSecs(pool.venue, pool.health);
  if (ringed ? !(windowSecs >= 1 && windowSecs <= 86_400) : !(windowSecs >= 600 && windowSecs <= 86_400)) {
    throw new Error(
      ringed
        ? "window must be 1–86400 seconds (default 1 = 2-observation TWAP)"
        : `window must be 600–86400 seconds on ${pool.venue === "clmm" ? "a Raydium pool whose observation ring is dead" : VENUE_LABEL[pool.venue]} (default 3960): the program samples this pool's live tick, so a shorter window reads spot price`,
    );
  }
  if (!pool.usable && !force) {
    throw new Error(
      pool.venue === "clmm"
        ? `oracle pool ${pool.pool.toBase58()} has only ${pool.health?.observations ?? 0} observations; trade it a little and wait, or pass force:true`
        : `${VENUE_LABEL[pool.venue]} pool ${pool.pool.toBase58()} holds no reserves; pass force:true to list anyway`,
    );
  }
  const kp = keysIn
    ? { bull: Keypair.fromSecretKey(bs58.decode(keysIn.bull)), bear: Keypair.fromSecretKey(bs58.decode(keysIn.bear)), config: Keypair.fromSecretKey(bs58.decode(keysIn.config)) }
    : await (async () => {
        // fresh mints come from the 1oox vanity stockpile; the curve config is any keypair
        const [b, r] = await vanityKeypairs(2);
        return { bull: Keypair.fromSecretKey(Uint8Array.from(b.secret)), bear: Keypair.fromSecretKey(Uint8Array.from(r.secret)), config: Keypair.generate() };
      })();
  const flag = pool.flag;
  // the market PDA commits to the oracle_obs slot (CLMM ring / PumpSwap base ATA / CPMM token-0 vault / Meteora pool); kinds 1/2 pass the venue pool as the trailing account
  const keys: MarketKeys = {
    key: marketPda(kp.bull.publicKey, kp.bear.publicKey, pool.slotObs, windowSecs, flag), bullMint: kp.bull.publicKey, bearMint: kp.bear.publicKey,
    oraclePool: pool.slotPool, oracleObs: pool.slotObs, windowSecs, underlyingIsToken0: flag, config: kp.config.publicKey,
    oracleKind: pool.kind, venuePool: pool.kind === 1 || pool.kind === 2 ? pool.pool : undefined,
  };
  const exists = await conn.getMultipleAccountsInfo([kp.config.publicKey, sideAccounts(keys, 0).pool, sideAccounts(keys, 1).pool, keys.key]);
  if (exists[3]) throw new Error(`that market already exists: ${SITE}/m/${keys.key.toBase58()}`);
  const bal = await balance(payer);
  if (bal < 0.25e9) throw new Error(`wallet holds ${(bal / 1e9).toFixed(3)} SOL; a listing costs ~0.2 SOL in rent across four transactions`);
  const um = mint.toBase58();
  const meta = async (side: "up" | "down") => {
    const r = await fetch(`${SITE}/api/meta?mint=${um}&s=${side}`);
    if (!r.ok) throw new Error("could not derive the pair's names from the coin's metadata");
    return (await r.json()) as { name: string; symbol: string };
  };
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const txs: string[] = [];
  const steps: string[] = [];
  const outKeys = { bull: bs58.encode(kp.bull.secretKey), bear: bs58.encode(kp.bear.secretKey), config: bs58.encode(kp.config.secretKey) };
  const summary = {
    kind: "create-market", mint: um, venue: pool.venue, venue_label: VENUE_LABEL[pool.venue], oracle_kind: pool.kind, venue_pool: pool.pool.toBase58(),
    oracle_pool: pool.slotPool.toBase58(), observation: pool.slotObs.toBase58(), quote: pool.quote, window_secs: windowSecs,
    market: keys.key.toBase58(), up_mint: keys.bullMint.toBase58(), down_mint: keys.bearMint.toBase58(), url: `${SITE}/m/${keys.key.toBase58()}`,
  };
  // each round builds what can be built now; the curve SDK reads the config on chain, the market needs the curves on chain
  if (!exists[0]) {
    const tx = await dbc.partner.createConfigWithTransferHook({ ...marketCurve(), config: kp.config.publicKey, feeClaimer: keys.key, leftoverReceiver: payer, quoteMint: RFSTACC, payer, transferHookProgram: PROGRAM_ID } as any);
    txs.push(legacyB64(tx, payer, [kp.config], blockhash));
    steps.push("Curve config (1 of 4)");
    return { txs, steps, keys: outKeys, more: true, summary: { ...summary, next: "send this, then call create-market again with the same keys" } };
  }
  if (!exists[1] || !exists[2]) {
    for (const [i, mintKp, side] of [[1, kp.bull, "up"], [2, kp.bear, "down"]] as const) {
      if (exists[i]) continue;
      const d = await meta(side);
      const tx = await dbc.creator.createPoolWithTransferHook({ name: d.name, symbol: d.symbol, uri: `${SITE}/api/meta?mint=${um}&s=${side}`, payer, poolCreator: payer, config: kp.config.publicKey, baseMint: mintKp.publicKey, transferHookProgram: PROGRAM_ID } as any);
      txs.push(legacyB64(tx, payer, [mintKp], blockhash));
      steps.push(side === "up" ? "UP curve (2 of 4)" : "DOWN curve (3 of 4)");
    }
    return { txs, steps, keys: outKeys, more: true, summary: { ...summary, next: "send these, then call create-market again with the same keys" } };
  }
  {
    const b = sideAccounts(keys, 0), e = sideAccounts(keys, 1);
    const tx = new Transaction().add(
      cu(600_000),
      createAssociatedTokenAccountIdempotentInstruction(payer, b.escrow, keys.key, keys.bullMint, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(payer, e.escrow, keys.key, keys.bearMint, TOKEN_2022_PROGRAM_ID),
      createMarketIx(payer, keys),
    );
    txs.push(legacyB64(tx, payer, [], blockhash));
    steps.push("Market (4 of 4)");
  }
  return { txs, steps, keys: outKeys, more: false, summary: { ...summary, next: "live once this lands" } };
}

// ---- dnvault: a vault over the oracle pool's live tick range (what scripts/dn/create-vault.ts does) ----
const i32le = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const dnVaultPda = (market: PublicKey, lo: number, hi: number) => PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer(), i32le(lo), i32le(hi)], DN_PROGRAM)[0];
const dnSharesPda = (vault: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("shares"), vault.toBuffer()], DN_PROGRAM)[0];
const dnSolPda = (vault: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("sol"), vault.toBuffer()], DN_PROGRAM)[0];
async function buildCreateVault(payer: PublicKey, marketKey: PublicKey, bandBps: number, maxLossBps: number, keeperBps: number) {
  for (const [n, v, lo, hi] of [["band_bps", bandBps, 100, 5000], ["max_loss_bps", maxLossBps, 50, 2000], ["keeper_bps", keeperBps, 0, 1000]] as const) if (!(v >= lo && v <= hi)) throw new Error(`${n} must be ${lo}–${hi}`);
  const md = await conn.getAccountInfo(marketKey);
  if (!md) throw new Error("market not found");
  const m = decodeMarket(marketKey, md.data);
  const pi = await conn.getAccountInfo(m.oraclePool);
  if (!pi) throw new Error("oracle pool not found");
  const pd = Buffer.from(pi.data);
  const spacing = pd.readUInt16LE(235);
  const m0 = new PublicKey(pd.subarray(73, 105)), m1 = new PublicKey(pd.subarray(105, 137));
  const xMint = m.underlyingIsToken0 ? m0 : m1;
  const quote = m.underlyingIsToken0 ? m1 : m0;
  if (!quote.equals(WSOL)) throw new Error("vaults need a SOL-quoted oracle pool (the vault LPs the coin against SOL); this market's oracle is quoted in " + quoteSymbolOf(quote));
  const xIsT22 = (await conn.getAccountInfo(xMint))!.owner.equals(TOKEN_2022_PROGRAM_ID);
  const ctx = await poolCtx(conn, m.oraclePool);
  const starts = Object.values(ctx.tickCache as Record<string, any>).map((t: any) => Number(t.startTickIndex)).sort((a, b) => a - b);
  if (!starts.length) throw new Error("the oracle pool has no initialized tick arrays (nobody has LP'd it) — seed-pool first");
  const lower = starts[0], upper = starts[starts.length - 1] + 60 * spacing - spacing;
  const vault = dnVaultPda(marketKey, lower, upper);
  if (await conn.getAccountInfo(vault)) throw new Error(`that vault already exists: ${SITE}/yield/${vault.toBase58()}`);
  const bal = await balance(payer);
  if (bal < 0.03e9) throw new Error(`wallet holds ${(bal / 1e9).toFixed(3)} SOL; a vault costs ~0.02 SOL in rent`);
  const sol = dnSolPda(vault);
  const xProg = xIsT22 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const atas = { wsol: getAssociatedTokenAddressSync(WSOL, sol, true), x: getAssociatedTokenAddressSync(xMint, sol, true, xProg), quote: getAssociatedTokenAddressSync(RFSTACC, vault, true), down: getAssociatedTokenAddressSync(m.bearMint, vault, true, TOKEN_2022_PROGRAM_ID) };
  const data = Buffer.alloc(15);
  data[0] = 0; data.writeInt32LE(lower, 1); data.writeInt32LE(upper, 5); data.writeUInt16LE(bandBps, 9); data.writeUInt16LE(maxLossBps, 11); data.writeUInt16LE(keeperBps, 13);
  const k = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
  const ix = new TransactionInstruction({
    programId: DN_PROGRAM,
    keys: [k(payer, true, true), k(vault, true), k(dnSharesPda(vault), true), k(sol, true), k(marketKey), k(m.oraclePool), k(xMint), k(m.bearMint), k(atas.wsol), k(atas.x), k(atas.quote), k(atas.down), k(SystemProgramId), k(TOKEN_PROGRAM_ID)],
    data,
  });
  const tx = await toV0([
    cu(400_000), ix,
    createAssociatedTokenAccountIdempotentInstruction(payer, atas.wsol, sol, WSOL),
    createAssociatedTokenAccountIdempotentInstruction(payer, atas.x, sol, xMint, xProg),
    createAssociatedTokenAccountIdempotentInstruction(payer, atas.quote, vault, RFSTACC),
    createAssociatedTokenAccountIdempotentInstruction(payer, atas.down, vault, m.bearMint, TOKEN_2022_PROGRAM_ID),
  ], payer);
  return { txs: [b64(tx)], steps: ["Create the vault and its token accounts"], summary: { kind: "create-vault", market: marketKey.toBase58(), vault: vault.toBase58(), share_mint: dnSharesPda(vault).toBase58(), range: [lower, upper], band_bps: bandBps, max_loss_bps: maxLossBps, keeper_bps: keeperBps, url: `${SITE}/yield/${vault.toBase58()}`, note: "park ≥0.3 SOL for it to afford a position; the keeper folds smaller amounts in on its passes" } };
}
const SystemProgramId = new PublicKey("11111111111111111111111111111111");

// ---- hooked keeper calls: permissionless on every market ----
async function keeperWork() {
  const [all, vs] = await Promise.all([markets(), vaults()]);
  const now = Math.floor(Date.now() / 1000);
  const mk = await Promise.all(
    all.map((v) => ({
      ticker: v.ticker, market: v.acct.key.toBase58(),
      poke: v.pending ? { pays: v.pending.payer ? "DOWN" : "UP", amount_rfstacc: Number(v.pending.amount) / 1e9 } : null,
      // fraction of the side's curve price still owed to the other pot (>0 = a settle will do something); the settle builder sizes it exactly
      settle: { up_owed: v.side[0].owed, down_owed: v.side[1].owed },
      claim: { up_rfstacc: Number(v.side[0].unclaimed) / 1e9, down_rfstacc: Number(v.side[1].unclaimed) / 1e9 },
      oracle_age_secs: Math.max(0, now - v.oracle.updatedTs),
    })),
  );
  const vk = await Promise.all(vs.map(async (w) => ({ ticker: await vaultTicker(w), vault: w.v.key.toBase58(), hedge_error_bps: Number(w.x.errBps), band_bps: w.v.bandBps, outside_band: Number(w.x.errBps) > w.v.bandBps, free_sol: Number(w.x.free) / 1e9, keeper_bps: w.v.keeperBps })));
  return { markets: mk, vaults: vk, how: { poke: "moves the pending pot transfer (anyone; no bounty, but it is what makes your side get paid)", settle: "sells the losing side's escrow into its curve for the winner (anyone)", claim: "pulls a side's unclaimed curve fees into the pots (anyone)", rebalance: "vault keeper: not exposed yet — the house keeper does it; keeper_bps is what a rebalance earns" } };
}
const keeper = () => memo("arena:keeper", TTL, STALE, keeperWork);
const buildPoke = async (payer: PublicKey, v: MarketView) => ({ tx: b64(await toV0([cu(200_000), pokeIx(v.keys)], payer)), summary: { kind: "poke", ticker: v.ticker, market: v.acct.key.toBase58(), pending: v.pending ? { pays: v.pending.payer ? "DOWN" : "UP", amount_rfstacc: Number(v.pending.amount) / 1e9 } : null } });
async function buildSettle(payer: PublicKey, v: MarketView, side: 0 | 1) {
  if (!((await settleAmount(v, side)) > 0n)) throw new Error(`${side ? "DOWN" : "UP"} on ${v.ticker} has nothing to settle right now`);
  const r = await buildSettleTx(v, side, payer).catch((e) => {
    throw new Error(`nothing settles on ${v.ticker} ${side ? "DOWN" : "UP"} right now (its curve is empty or already settled): ${e instanceof Error ? e.message.slice(0, 120) : e}`);
  });
  if (!r) throw new Error("no settle amount simulates right now; try again after the next poke");
  return { tx: b64(r.tx), summary: { kind: "settle", ticker: v.ticker, market: v.acct.key.toBase58(), side: side ? "DOWN" : "UP", amount_tokens: Number(r.amount) / 10 ** v.side[side].decimals } };
}
async function buildClaim(payer: PublicKey, v: MarketView, side: 0 | 1) {
  const un = v.side[side].unclaimed;
  if (un === 0n) throw new Error(`${side ? "DOWN" : "UP"} on ${v.ticker} has no unclaimed fees`);
  return { tx: b64(await toV0([cu(300_000), claimFeesIx(v.keys, side)], payer)), summary: { kind: "claim", ticker: v.ticker, market: v.acct.key.toBase58(), side: side ? "DOWN" : "UP", unclaimed_rfstacc: Number(un) / 1e9 } };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === "GET") {
      if (req.query.list !== undefined) {
        const all = await markets();
        const d = await oracleDepths(all);
        return res.setHeader("cache-control", "public, max-age=10, s-maxage=20, stale-while-revalidate=60").json({ markets: all.map((v) => listRow(v, d.get(v.keys.oraclePool.toBase58()))), thin_oracle_usd: THIN_ORACLE_USD });
      }
      if (req.query.pools) {
        const mint = new PublicKey(String(req.query.pools));
        const [asset, rows] = await Promise.all([getAsset(mint.toBase58()).catch(() => null), oracleCandidates(mint)]);
        return res.setHeader("cache-control", "public, max-age=10, s-maxage=20, stale-while-revalidate=60").json({ mint: mint.toBase58(), underlying: asset, pools: poolsOut(rows), next: rows.some((r) => r.quote === "SOL") ? "create-market <pool>" : "create-pool <mint> <sol>" });
      }
      if (req.query.keeper !== undefined) {
        return res.setHeader("cache-control", "public, max-age=10, s-maxage=30, stale-while-revalidate=60").json(await keeper());
      }
      if (req.query.vaults !== undefined) {
        return res.setHeader("cache-control", "public, max-age=15, s-maxage=30, stale-while-revalidate=60").json({ vaults: await Promise.all((await vaults()).map(vaultRow)) });
      }
      if (req.query.who) {
        const owner = new PublicKey(String(req.query.who));
        const p = await pool();
        const all = await markets();
        return res.setHeader("cache-control", "no-store").json(await book(owner, all, p, await vaults()));
      }
      return res.setHeader("cache-control", "public, max-age=10, s-maxage=60, stale-while-revalidate=600").json(await board());
    }
    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
    const payer = new PublicKey(String(body.payer));
    const kind = String(body.kind);
    const p = await pool();
    if (kind === "park" || kind === "unpark" || kind === "finish") {
      const w = await resolveVaultQ(await vaults(), String(body.vault ?? body.market ?? ""));
      const out = kind === "park" ? await buildPark(payer, w, Number(body.sol)) : kind === "unpark" ? await buildUnpark(p, payer, w, body.pct === undefined ? 100 : Number(body.pct), await markets()) : await buildFinish(p, payer, w, await markets());
      return res.setHeader("cache-control", "no-store").json(out);
    }
    if (kind === "create-pool") return res.setHeader("cache-control", "no-store").json(await buildCreatePool(payer, new PublicKey(String(body.mint)), Number(body.sol), body.fee_index === undefined ? 1 : Number(body.fee_index)));
    if (kind === "seed-pool") return res.setHeader("cache-control", "no-store").json(await buildSeedPool(payer, new PublicKey(String(body.pool)), Number(body.sol), body.range === undefined ? 4 : Number(body.range)));
    if (kind === "create-market") return res.setHeader("cache-control", "no-store").json(await buildCreateMarket(payer, String(body.pool ?? body.mint ?? ""), body.window === undefined ? undefined : Number(body.window), body.keys, body.force === true));
    if (kind === "create-vault") return res.setHeader("cache-control", "no-store").json(await buildCreateVault(payer, new PublicKey(String(body.market)), Number(body.band_bps ?? 1500), Number(body.max_loss_bps ?? 300), Number(body.keeper_bps ?? 100)));
    if (kind === "poke") return res.setHeader("cache-control", "no-store").json(await buildPoke(payer, resolveMarket(await markets(), String(body.market ?? ""))));
    if (kind === "settle" || kind === "claim") {
      const v = resolveMarket(await markets(), String(body.market ?? ""));
      const sd: 0 | 1 = String(body.side).toUpperCase() === "DOWN" ? 1 : 0;
      return res.setHeader("cache-control", "no-store").json(kind === "settle" ? await buildSettle(payer, v, sd) : await buildClaim(payer, v, sd));
    }
    if (kind !== "buy" && kind !== "sell") return res.status(400).json({ error: "kind must be one of: buy, sell, park, unpark, finish, create-pool, seed-pool, create-market, create-vault, poke, settle, claim" });
    const side: 0 | 1 = String(body.side).toUpperCase() === "DOWN" ? 1 : String(body.side).toUpperCase() === "UP" ? 0 : (() => { throw new Error("side must be UP or DOWN"); })();
    const v = resolveMarket(await markets(), String(body.market ?? ""));
    const out = kind === "buy" ? await buildBuy(p, payer, v, side, Number(body.sol)) : await buildSell(p, payer, v, side, body.pct === undefined ? 100 : Number(body.pct));
    res.setHeader("cache-control", "no-store").json(out);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "arena failed" });
  }
}
