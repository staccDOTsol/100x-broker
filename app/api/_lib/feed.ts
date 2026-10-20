// Activity + leaderboards straight from chain: parse every transaction that touched a market.
import { Connection, PublicKey, type ParsedInstruction, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { getAsset } from "./das.js";
import { classify as classifyAsset } from "./category.js";
import type { Category } from "../../src/lib/category.js";
import { readMarketCard } from "./og.js";
import { memo, peek } from "./memo.js";
import { parsedTxs, recentSigs } from "./txcache.js";
import { serverConnection } from "../../src/lib/upstream.js";

// memo windows (ms): fresh / stale. Account lists and views refresh often; parsed history is incremental so it refreshes cheaply.
const LIST_TTL = 5_000, LIST_STALE = 30_000;
const FEED_TTL = 5_000, FEED_STALE = 60_000;
const BOARD_TTL = 15_000, BOARD_STALE = 120_000;

import { HISTORY_PROGRAM_IDS, HISTORY_DN_PROGRAM_IDS } from "../../src/config.js";
const DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const RFSTACC = "pSYRpDqr847kB2nD5ZhjcPsHLV2ZpUxweXm1MwiSTcc";
const MARKET_LEN = 1008;
const SWAP_DISC = Buffer.from([183, 93, 153, 40, 24, 230, 194, 151]);
const CLAIM_DISC = Buffer.from([84, 191, 71, 50, 9, 162, 55, 193]);

const conn = () => {
  const u = process.env.HELIUS_RPC_URL;
  if (!u) throw new Error("HELIUS_RPC_URL not configured");
  return serverConnection();
};
const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();

export type Ctx = {
  key: string;
  ticker: string;
  /** The coin under the market and its category (meme | major | stonk | stable | other, src/lib/category.ts). */
  underlying: string;
  category: Category;
  mints: [string, string];
  decimals: [number, number];
  vaults: [string, string];
  baseVaults: [string, string];
  quoteVaults: [string, string];
  escrows: [string, string];
};
/** A market's fixed addresses (mints, vaults, curves) plus its ticker: 5 min fresh, a day stale — none of it moves. */
export const marketCtx = (key: PublicKey): Promise<Ctx> =>
  memo(`feed:ctx:${key.toBase58()}`, 300_000, 86_400_000, async () => {
    const c = conn();
    const d = (await c.getAccountInfo(key))!.data;
    if (d.length !== MARKET_LEN) throw new Error("not a market");
    const [pB, pR, mB, mR, opool] = await c.getMultipleAccountsInfo([new PublicKey(pk(d, 232)), new PublicKey(pk(d, 264)), new PublicKey(pk(d, 8)), new PublicKey(pk(d, 40)), new PublicKey(pk(d, 104))]);
    const underlying = pk(opool!.data, d[489] ? 73 : 105);
    const asset = await getAsset(underlying).catch(() => null);
    const category = await classifyAsset({ mint: underlying, symbol: asset?.symbol, name: asset?.name }).catch((): Category => "other");
    const v: Ctx = {
      key: key.toBase58(),
      ticker: asset?.symbol ?? underlying.slice(0, 4),
      underlying,
      category,
      mints: [pk(d, 8), pk(d, 40)],
      decimals: [mB!.data[44], mR!.data[44]],
      vaults: [pk(d, 168), pk(d, 200)],
      baseVaults: [pk(d, 296), pk(d, 328)],
      quoteVaults: [pk(pB!.data, 200), pk(pR!.data, 200)],
      escrows: [pk(d, 360), pk(d, 392)],
    };
    return v;
  });

export type Ev = {
  sig: string;
  ts: number;
  kind: "buy" | "sell" | "redeem" | "settle" | "claim" | "rebalance" | "listed" | "burn";
  market: string;
  ticker: string;
  actor: string;
  side?: 0 | 1;
  tokens?: number; // ui amount of UP/DOWN
  quote?: string; // r-fstacc raw (lamports) moved to/from the actor or vault
  paid?: { from: 0 | 1; to: 0 | 1; amount: string }; // vault -> vault rebalance in this tx
  owed?: number; // settle: fraction of price taken
};

type Flow = { mint?: string; source: string; destination: string; amount: bigint };
function flows(tx: ParsedTransactionWithMeta): { transfers: Flow[]; burns: { mint: string; amount: bigint }[]; mints: { mint: string; amount: bigint }[] } {
  const transfers: Flow[] = [];
  const burns: { mint: string; amount: bigint }[] = [];
  const mints: { mint: string; amount: bigint }[] = [];
  const all: (ParsedInstruction | PartiallyDecodedInstruction)[] = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions),
  ];
  for (const ix of all) {
    if (!("parsed" in ix) || typeof ix.parsed !== "object") continue;
    const { type, info } = ix.parsed as { type: string; info: any };
    const amt = BigInt(info?.tokenAmount?.amount ?? info?.amount ?? 0);
    if (type === "transfer" || type === "transferChecked") transfers.push({ mint: info.mint, source: info.source, destination: info.destination, amount: amt });
    else if (type === "burn" || type === "burnChecked") burns.push({ mint: info.mint, amount: amt });
    else if (type === "mintTo" || type === "mintToChecked") mints.push({ mint: info.mint, amount: amt });
  }
  return { transfers, burns, mints };
}

function topLevel(tx: ParsedTransactionWithMeta, program: string) {
  return tx.transaction.message.instructions.filter((ix): ix is PartiallyDecodedInstruction => !("parsed" in ix) && ix.programId.toBase58() === program);
}

export function classify(tx: ParsedTransactionWithMeta, ctx: Ctx): Ev | null {
  if (!tx.meta || tx.meta.err) return null;
  const sig = tx.transaction.signatures[0];
  const ts = tx.blockTime ?? 0;
  const actor = tx.transaction.message.accountKeys[0].pubkey.toBase58();
  const base = { sig, ts, market: ctx.key, ticker: ctx.ticker, actor };
  const { transfers, burns, mints } = flows(tx);
  const sideOfMint = (m?: string): 0 | 1 | -1 => (m === ctx.mints[0] ? 0 : m === ctx.mints[1] ? 1 : -1);
  const ui = (raw: bigint, side: 0 | 1) => Number(raw) / 10 ** ctx.decimals[side];

  // vault -> vault rebalance (the hook), present in most txs
  let paid: Ev["paid"];
  for (const t of transfers) {
    const f = ctx.vaults.indexOf(t.source);
    const to = ctx.vaults.indexOf(t.destination);
    if (f >= 0 && to >= 0 && f !== to && t.amount > 0n) paid = { from: f as 0 | 1, to: to as 0 | 1, amount: t.amount.toString() };
  }

  const ours = HISTORY_PROGRAM_IDS.flatMap((program) => topLevel(tx, program.toBase58())).map((ix) => bs58.decode(ix.data)[0]);
  const dbc = topLevel(tx, DBC).map((ix) => Buffer.from(bs58.decode(ix.data).subarray(0, 8)));

  if (ours.includes(0)) return { ...base, kind: "listed" };
  if (ours.includes(3)) {
    const m = mints.find((x) => sideOfMint(x.mint) >= 0);
    const side = m ? (sideOfMint(m.mint) as 0 | 1) : 0;
    const proceeds = transfers.filter((t) => t.destination === ctx.vaults[1 - side] && t.source === ctx.quoteVaults[side]).reduce((a, t) => a + t.amount, 0n);
    return { ...base, kind: "settle", side, tokens: m ? ui(m.amount, side) : undefined, quote: proceeds.toString(), paid };
  }
  if (ours.includes(2)) {
    const b = burns.find((x) => sideOfMint(x.mint) >= 0);
    if (b) {
      const side = sideOfMint(b.mint) as 0 | 1;
      const out = transfers.filter((t) => t.source === ctx.vaults[side] && !ctx.vaults.includes(t.destination)).reduce((a, t) => a + t.amount, 0n);
      return { ...base, kind: "redeem", side, tokens: ui(b.amount, side), quote: out.toString(), paid };
    }
  }
  if (dbc.some((d) => d.equals(SWAP_DISC))) {
    for (const t of transfers) {
      const sd = sideOfMint(t.mint);
      if (sd < 0) continue;
      const side = sd as 0 | 1;
      if (t.source === ctx.baseVaults[side]) {
        const q = transfers.filter((x) => x.destination === ctx.quoteVaults[side] && x.mint === RFSTACC).reduce((a, x) => a + x.amount, 0n);
        return { ...base, kind: "buy", side, tokens: ui(t.amount, side), quote: q.toString(), paid };
      }
      if (t.destination === ctx.baseVaults[side]) {
        const q = transfers.filter((x) => x.source === ctx.quoteVaults[side] && x.mint === RFSTACC).reduce((a, x) => a + x.amount, 0n);
        return { ...base, kind: "sell", side, tokens: ui(t.amount, side), quote: q.toString(), paid };
      }
    }
  }
  if (dbc.some((d) => d.equals(CLAIM_DISC))) {
    const q = transfers.filter((t) => ctx.quoteVaults.includes(t.source) && ctx.vaults.includes(t.destination)).reduce((a, t) => a + t.amount, 0n);
    return { ...base, kind: "claim", quote: q.toString(), paid };
  }
  if (paid) return { ...base, kind: "rebalance", paid };
  return null;
}

/** The latest `limit` signatures of one market, classified. Incremental: only signatures newer than the last refresh are fetched
 *  and only transactions not parsed before go upstream (api/_lib/txcache.ts). */
export const marketFeed = (key: PublicKey, limit = 40): Promise<Ev[]> =>
  memo(`feed:market:${key.toBase58()}:${limit}`, FEED_TTL, FEED_STALE, async () => {
    const c = conn();
    const [ctx, sigs] = await Promise.all([marketCtx(key), recentSigs(c, key, limit)]);
    const ok = sigs.filter((s) => !s.err).map((s) => s.signature);
    const txs = await parsedTxs(c, ok);
    return txs.map((t) => (t ? classify(t, ctx) : null)).filter((e): e is Ev => !!e);
  });

export const allMarkets = (): Promise<PublicKey[]> =>
  memo("feed:markets", LIST_TTL, LIST_STALE, async () => {
    const lists = await Promise.all(HISTORY_PROGRAM_IDS.map((program) => conn().getProgramAccounts(program, { dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: MARKET_LEN }, { memcmp: { offset: 0, bytes: "JU9tGcfh7on" } }] })));
    return lists.flat().map((r) => r.pubkey);
  });

// ---------- plumbing, not people ----------

/** Signs every vault rebalance, so it would top any activity list on its own. */
const KEEPER = process.env.DN_KEEPER ?? "EGa3ng1xcuB5X9tkK7czYczhD4PpAYAJF52Vo9F2Cn7";
/** The keeper plus every dnvault PDA and its SOL sub-account: they hold DOWN and trade it, but they are not wallets. 5 min fresh,
 *  an hour stale; a flaky RPC keeps the last good set rather than letting the vaults back onto the board. */
export const botAddresses = (): Promise<Set<string>> =>
  memo<Set<string>>("feed:bots", 300_000, 3_600_000, async () => {
    const v = new Set([KEEPER]);
    // "dnvault1" in base58, the same filter the client's listVaults uses
    const res = (await Promise.all(HISTORY_DN_PROGRAM_IDS.map((program) => conn().getProgramAccounts(program, { filters: [{ memcmp: { offset: 0, bytes: "HoK4CZtz9b6" } }] })))).flat();
    for (const a of res) {
      v.add(a.pubkey.toBase58());
      v.add(pk(a.account.data, 392)); // solPda
    }
    return v;
  }).catch(() => peek<Set<string>>("feed:bots") ?? new Set([KEEPER]));

const MEME = process.env.VITE_MEME_MINT ?? "Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump";
const BURN_ACCOUNTS = HISTORY_PROGRAM_IDS.map((program) => ({
  state: PublicKey.findProgramAddressSync([Buffer.from("burn-state")], program)[0],
  vault: PublicKey.findProgramAddressSync([Buffer.from("burn")], program)[0].toBase58(),
}));

function burnEv(tx: ParsedTransactionWithMeta, state: PublicKey, vault: string): Ev | null {
  if (!tx.meta || tx.meta.err) return null;
  const { transfers, burns } = flows(tx);
  const b = burns.find((x) => x.mint === MEME);
  if (!b) return null;
  const paid = transfers.filter((t) => t.source === vault).reduce((a, t) => a + t.amount, 0n);
  return { sig: tx.transaction.signatures[0], ts: tx.blockTime ?? 0, kind: "burn", market: state.toBase58(), ticker: "100XBRO", actor: tx.transaction.message.accountKeys[0].pubkey.toBase58(), tokens: Number(b.amount) / 1e6, quote: paid.toString() };
}

/** $100X burns: every one touches the burn-state PDA. Incremental like marketFeed. */
export const burnFeed = (limit = 20): Promise<Ev[]> =>
  memo(`feed:burn:${limit}`, FEED_TTL, FEED_STALE, async () => {
    const c = conn();
    const lists = await Promise.all(BURN_ACCOUNTS.map(async ({ state, vault }) => {
      const sigs = await recentSigs(c, state, limit);
      const txs = await parsedTxs(c, sigs.filter((s) => !s.err).map((s) => s.signature));
      return txs.map((t) => (t ? burnEv(t, state, vault) : null)).filter((e): e is Ev => !!e);
    }));
    return lists.flat().sort((a, b) => b.ts - a.ts).slice(0, limit);
  });

export const globalFeed = (perMarket = 15): Promise<Ev[]> =>
  memo(`feed:global:${perMarket}`, FEED_TTL, FEED_STALE, async () => {
    const markets = await allMarkets();
    // a market whose refresh fails (rate limit, flaky upstream) keeps its last good list; it must not become [] and get memoized as "quiet"
    let failed = 0;
    const feeds = await Promise.all([
      ...markets.map((m) =>
        marketFeed(m, perMarket).catch(() => {
          failed++;
          return peek<Ev[]>(`feed:market:${m.toBase58()}:${perMarket}`) ?? ([] as Ev[]);
        }),
      ),
      burnFeed(20).catch(() => peek<Ev[]>("feed:burn:20") ?? ([] as Ev[])),
    ]);
    const all = feeds.flat().sort((a, b) => b.ts - a.ts).slice(0, 60);
    // nothing came back and something broke: that's an outage, not an empty board — throw so memo serves the previous value / retries next call
    if (all.length === 0 && failed > 0) throw new Error(`feed: ${failed}/${markets.length} markets failed upstream`);
    return all;
  });

const T22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const TOK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROG = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ataOf = (mint: PublicKey, owner: PublicKey, program = T22) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROG)[0];

/** One wallet's moves. Its UP/DOWN token accounts are the index (every buy/sell/redeem touches one), its $100X account for burns. */
export const walletFeed = (owner: PublicKey, perAccount = 40): Promise<Ev[]> =>
  memo(`feed:wallet:${owner.toBase58()}:${perAccount}`, FEED_TTL, FEED_STALE, async () => {
    const c = conn();
    const ctxs = await Promise.all((await allMarkets()).map((m) => marketCtx(m).catch(() => null)));
    const jobs: { ata: PublicKey; ctx: Ctx | null }[] = [{ ata: ataOf(new PublicKey(MEME), owner, TOK), ctx: null }];
    for (const ctx of ctxs) if (ctx) for (const m of ctx.mints) jobs.push({ ata: ataOf(new PublicKey(m), owner), ctx });
    // one `until` call per token account: an account with nothing new answers with an empty page
    const lists = await Promise.all(jobs.map((j) => recentSigs(c, j.ata, perAccount).catch(() => [])));
    const ctxOf = new Map<string, Ctx | null>();
    lists.forEach((l, i) => l.forEach((s) => !s.err && !ctxOf.has(s.signature) && ctxOf.set(s.signature, jobs[i].ctx)));
    const sigs = [...ctxOf.keys()];
    const txs = await parsedTxs(c, sigs);
    const me = owner.toBase58();
    const out: Ev[] = [];
    txs.forEach((tx, i) => {
      if (!tx) return;
      const ctx = ctxOf.get(sigs[i]);
      const burn = BURN_ACCOUNTS.find(({ state }) => tx.transaction.message.accountKeys.some(({ pubkey }) => pubkey.equals(state)));
      const ev = ctx ? classify(tx, ctx) : burn ? burnEv(tx, burn.state, burn.vault) : null;
      if (ev && ev.actor === me) out.push(ev);
    });
    return out.sort((a, b) => b.ts - a.ts).slice(0, 60);
  });

// ---------- leaderboards ----------
export type Holder = { owner: string; tokens: number; valueUsd: number | null; redeemUsd: number | null; share: number };
export type Board = { market: string; ticker: string; sides: [Holder[], Holder[]]; leverage: [number, number] };

export const marketLeaders = (key: PublicKey): Promise<Board> => memo(`feed:leaders:${key.toBase58()}`, BOARD_TTL, BOARD_STALE, () => loadMarketLeaders(key));
async function loadMarketLeaders(key: PublicKey): Promise<Board> {
  const c = conn();
  const [ctx, card] = await Promise.all([marketCtx(key), readMarketCard(key, false)]);
  const sides = await Promise.all(
    ([0, 1] as const).map(async (side) => {
      const largest = await c.getTokenLargestAccounts(new PublicKey(ctx.mints[side]));
      const accts = largest.value.filter((a) => a.address.toBase58() !== ctx.baseVaults[side] && a.address.toBase58() !== ctx.escrows[side] && BigInt(a.amount) > 0n);
      const infos = await c.getMultipleAccountsInfo(accts.map((a) => a.address));
      const s = card.sides[side];
      const circ = Number(s.circulating) / 10 ** s.decimals || 1;
      return accts
        .map((a, i) => {
          const owner = infos[i] ? pk(infos[i]!.data, 32) : a.address.toBase58();
          const tokens = Number(a.amount) / 10 ** s.decimals;
          return {
            owner,
            tokens,
            valueUsd: s.priceUsd === null ? null : tokens * s.priceUsd,
            redeemUsd: s.navUsd === null ? null : tokens * s.navUsd * 0.96,
            share: tokens / circ,
          };
        })
        .sort((x, y) => y.tokens - x.tokens)
        .slice(0, 10);
    }),
  );
  return { market: ctx.key, ticker: ctx.ticker, sides: sides as [Holder[], Holder[]], leverage: [card.sides[0].leverage, card.sides[1].leverage] };
}

export type Wallet = { owner: string; valueUsd: number; positions: number; biggest: { ticker: string; side: 0 | 1; valueUsd: number } | null };
export const globalLeaders = (): Promise<Wallet[]> => memo("feed:leaders", BOARD_TTL, BOARD_STALE, loadGlobalLeaders);
async function loadGlobalLeaders(): Promise<Wallet[]> {
  const [markets, bots] = await Promise.all([allMarkets(), botAddresses()]);
  const boards = await Promise.all(markets.map((m) => marketLeaders(m).catch(() => null)));
  const agg = new Map<string, Wallet>();
  for (const b of boards) {
    if (!b) continue;
    for (const side of [0, 1] as const) {
      for (const h of b.sides[side]) {
        if (bots.has(h.owner)) continue; // the vaults' hedge bags are not anyone's bags
        const w = agg.get(h.owner) ?? { owner: h.owner, valueUsd: 0, positions: 0, biggest: null };
        w.valueUsd += h.valueUsd ?? 0;
        w.positions += 1;
        if (!w.biggest || (h.valueUsd ?? 0) > w.biggest.valueUsd) w.biggest = { ticker: b.ticker, side, valueUsd: h.valueUsd ?? 0 };
        agg.set(h.owner, w);
      }
    }
  }
  return [...agg.values()].sort((a, b) => b.valueUsd - a.valueUsd).slice(0, 20);
}

/** Per-market event buffer for the activity scan: `evs` newest-first, covering everything from `since` up to the newest signature
 *  seen. Refreshes fetch only what landed after `newest` (`until`); a wider window than before back-fills from `oldest`. */
type EvBuf = { evs: Ev[]; newest?: string; oldest?: string; since: number; pending: string[] };
const evBufs = new Map<string, EvBuf>();
const evBufLocks = new Map<string, Promise<unknown>>();
const EV_BUF_KEEP_S = 8 * 86400; // the handler caps `active` at 168 h; keep a week plus a day of slack
const EV_BUF_MAX = 20_000;

/** Signatures of `key` newest-first between `until` (exclusive, newer bound) and the `since` cutoff / `before` start; `maxSigs` bounds a pass. */
async function sigRange(c: Connection, key: PublicKey, o: { before?: string; until?: string; since: number; maxSigs: number }) {
  const rows: { signature: string; err: boolean }[] = [];
  let before = o.before;
  let crossed = false;
  while (rows.length < o.maxSigs) {
    const page = await c.getSignaturesForAddress(key, { limit: 1000, before, until: o.until });
    for (const s of page) {
      if ((s.blockTime ?? 0) < o.since) {
        crossed = true;
        break;
      }
      rows.push({ signature: s.signature, err: !!s.err });
    }
    if (crossed || page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  return rows;
}

/** Every event on one market since `since` (unix s). `drop` skips whole txs. Incremental per market (see EvBuf). */
async function marketEventsSince(key: PublicKey, since: number, drop?: (tx: ParsedTransactionWithMeta) => boolean, maxSigs = 3000): Promise<Ev[]> {
  const k = key.toBase58();
  // one refresh per market at a time: concurrent callers (different windows) queue on the same buffer
  const prev = evBufLocks.get(k) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => refreshEvents(key, since, drop, maxSigs));
  evBufLocks.set(k, run);
  run.finally(() => evBufLocks.get(k) === run && evBufLocks.delete(k)).catch(() => {});
  return run;
}
async function refreshEvents(key: PublicKey, since: number, drop: ((tx: ParsedTransactionWithMeta) => boolean) | undefined, maxSigs: number): Promise<Ev[]> {
  const c = conn();
  const k = key.toBase58();
  const ctx = await marketCtx(key);
  const buf: EvBuf = evBufs.get(k) ?? { evs: [], since, pending: [] };
  const parse = async (sigs: string[]) => {
    const txs = await parsedTxs(c, sigs);
    const out: Ev[] = [];
    const missing: string[] = [];
    txs.forEach((t, i) => {
      if (!t) return void missing.push(sigs[i]); // not indexed yet: ask again next pass
      const e = !drop?.(t) ? classify(t, ctx) : null;
      if (e) out.push(e);
    });
    return { out, missing };
  };
  // forward: everything newer than the newest signature already folded in (first pass: the whole window)
  const fwd = await sigRange(c, key, { until: buf.newest, since: buf.newest ? 0 : since, maxSigs });
  const fresh = await parse([...buf.pending, ...fwd.filter((r) => !r.err).map((r) => r.signature)]);
  buf.pending = fresh.missing.slice(0, 200);
  let evs = [...fresh.out, ...buf.evs];
  if (fwd.length) {
    buf.newest = fwd[0].signature;
    buf.oldest ??= fwd[fwd.length - 1].signature;
  }
  // back-fill: a wider window than the buffer covers
  if (since < buf.since && buf.oldest) {
    const back = await sigRange(c, key, { before: buf.oldest, since, maxSigs });
    const older = await parse(back.filter((r) => !r.err).map((r) => r.signature));
    evs = [...evs, ...older.out];
    if (back.length) buf.oldest = back[back.length - 1].signature;
    buf.since = since;
  }
  const seen = new Set<string>();
  const keep = Math.floor(Date.now() / 1000) - EV_BUF_KEEP_S;
  buf.evs = evs
    .filter((e) => e.ts >= keep && !seen.has(e.sig) && seen.add(e.sig))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, EV_BUF_MAX);
  buf.since = Math.max(buf.since, keep);
  evBufs.set(k, buf);
  return buf.evs.filter((e) => e.ts >= since);
}

export type Active = {
  owner: string;
  in: string; // r-fstacc raw bought
  out: string; // r-fstacc raw sold + cashed out
  net: string; // out − in
  trades: number;
  markets: number;
  last: number;
  top: { market: string; ticker: string; side: 0 | 1; quote: string } | null;
};

/** A tx that touches a vault is vault plumbing (keeper rebalance, park-and-deploy hedge) whoever paid for it. Every caller of
 *  marketEventsSince must pass this same filter: the per-market event buffer is shared and stores what the filter let through. */
const plumbingOf = (bots: Set<string>) => (tx: ParsedTransactionWithMeta) => tx.transaction.message.accountKeys.some((k) => bots.has(k.pubkey.toBase58()));

/** Who actually traded in the window, closed positions included — the bags board only sees what is still held. */
export const activeWallets = (hours = 24): Promise<Active[]> => memo(`feed:active:${hours}`, BOARD_TTL, 300_000, () => loadActiveWallets(hours));
async function loadActiveWallets(hours: number): Promise<Active[]> {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const [markets, bots] = await Promise.all([allMarkets(), botAddresses()]);
  const plumbing = plumbingOf(bots);
  const evs = (await Promise.all(markets.map((m) => marketEventsSince(m, since, plumbing).catch(() => [] as Ev[])))).flat();
  type Acc = { in: bigint; out: bigint; trades: number; mk: Set<string>; last: number; tops: Map<string, { ticker: string; side: 0 | 1; q: bigint }> };
  const agg = new Map<string, Acc>();
  for (const e of evs) {
    if (e.ts < since || bots.has(e.actor)) continue;
    if (e.kind !== "buy" && e.kind !== "sell" && e.kind !== "redeem") continue;
    const q = BigInt(e.quote ?? 0);
    const a = agg.get(e.actor) ?? { in: 0n, out: 0n, trades: 0, mk: new Set<string>(), last: 0, tops: new Map() };
    if (e.kind === "buy") a.in += q;
    else a.out += q;
    a.trades += 1;
    a.mk.add(e.market);
    a.last = Math.max(a.last, e.ts);
    const k = `${e.market}:${e.side ?? 0}`;
    const t = a.tops.get(k) ?? { ticker: e.ticker, side: e.side ?? 0, q: 0n };
    t.q += q;
    a.tops.set(k, t);
    agg.set(e.actor, a);
  }
  const rows: Active[] = [...agg].map(([owner, a]) => {
    const top = [...a.tops].sort(([, x], [, y]) => (y.q > x.q ? 1 : y.q < x.q ? -1 : 0))[0];
    return {
      owner,
      in: a.in.toString(),
      out: a.out.toString(),
      net: (a.out - a.in).toString(),
      trades: a.trades,
      markets: a.mk.size,
      last: a.last,
      top: top ? { market: top[0].split(":")[0], ticker: top[1].ticker, side: top[1].side, quote: top[1].q.toString() } : null,
    };
  });
  // most trades first; same count, more money moved wins
  const vol = (r: Active) => BigInt(r.in) + BigInt(r.out);
  // ranked by volume moved (in + out): the number that pays the pots, not the click count
  return rows.sort((x, y) => (vol(y) > vol(x) ? 1 : vol(y) < vol(x) ? -1 : 0) || y.trades - x.trades).slice(0, 20);
}

/** When a market was listed: the blockTime of the oldest signature on its account. That never changes, so it is kept a day fresh
 *  and a week stale; null when the account's history is deeper than BIRTH_PAGES pages (the board then sorts it as the oldest). */
const BIRTH_PAGES = 20;
export const marketBirth = (key: PublicKey): Promise<number | null> =>
  memo(`feed:birth:${key.toBase58()}`, 86_400_000, 7 * 86_400_000, async () => {
    const c = conn();
    let before: string | undefined;
    for (let i = 0; i < BIRTH_PAGES; i++) {
      const page = await c.getSignaturesForAddress(key, { limit: 1000, before });
      if (!page.length) return null;
      if (page.length < 1000) return page[page.length - 1].blockTime ?? null;
      before = page[page.length - 1].signature;
    }
    return null;
  });

/** One market's trading over a window. `vol` is r-fstacc raw (buys + sells + cash-outs, vault plumbing and bots excluded, the same
 *  rule as activeWallets), null when its history could not be read this pass. `born` is marketBirth. */
export type MarketStat = { market: string; vol: string | null; trades: number; traders: number; last: number | null; born: number | null };

/** Per-market volume, trade count and listing time: what the board and the market switcher sort by (volume · oldest · newest). */
export const marketStats = (hours = 24): Promise<MarketStat[]> => memo(`feed:mstats:${hours}`, BOARD_TTL, 300_000, () => loadMarketStats(hours));
async function loadMarketStats(hours: number): Promise<MarketStat[]> {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const [markets, bots] = await Promise.all([allMarkets(), botAddresses()]);
  const plumbing = plumbingOf(bots);
  return Promise.all(
    markets.map(async (m): Promise<MarketStat> => {
      const [evs, born] = await Promise.all([marketEventsSince(m, since, plumbing).catch(() => null), marketBirth(m).catch(() => null)]);
      if (!evs) return { market: m.toBase58(), vol: null, trades: 0, traders: 0, last: null, born };
      let vol = 0n;
      let trades = 0;
      let last: number | null = null;
      const who = new Set<string>();
      for (const e of evs) {
        if (e.ts < since || bots.has(e.actor)) continue;
        if (e.kind !== "buy" && e.kind !== "sell" && e.kind !== "redeem") continue;
        vol += BigInt(e.quote ?? 0);
        trades++;
        who.add(e.actor);
        last = Math.max(last ?? 0, e.ts);
      }
      return { market: m.toBase58(), vol: vol.toString(), trades, traders: who.size, last, born };
    }),
  );
}
