// Stars War on lastbidwins.fun / 100x.broker/w.
//   GET  /api/war?g=<id>|featured   one game: state, phase, next minimum bid, every amount in token units and USD
//   GET  /api/war?list=1            recent games, live ones first
//   POST /api/war {op, g, wallet, amount?, team?, ref?, zap?}
//        op = bid | multibid | fork | settle | next | claim   ->  {txs: base64 v0 transactions to sign and send in order, summary}
//        multibid moves = [{op: bid|fork|next, g|from, amount}]; the first move may be {op:start, mint, amount}
// A token-game bid from a wallet short of the token carries a SOL -> token swap in the same transaction (zap in); a claim can
// carry token -> SOL (zap out). Swaps go through the house router first, Jupiter second.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount, type TransactionInstruction } from "@solana/web3.js";
import { serverConnection } from "../src/lib/upstream.js";
import { autoTeam, phantomLink, tokenProgramOf, bidIxs, claimDividendIxs, createGameIxs, loadGame, loadPlayer, minNextBid, nextGameId, nextWarIxs, phase, settleIxs, TEAMS, type Team, type WarGame, gamePda, decodeGame } from "../src/lib/war.js";
import { tokenBalance, usdPrice, WSOL_MINT, zapIn, zapOut } from "./_lib/warzap.js";
import { getAsset } from "./_lib/das.js";
import { getThread, getThreadPreview, setThread } from "./_lib/warthread.js";
import { allGames, bagOf } from "./_lib/warbag.js";
import { holdersOf } from "./_lib/warholders.js";
import { xPost } from "./_lib/xpost.js";
import { prewarm, lastUrl } from "./_lib/prewarm.js";
import { MAX_WAR_BIDS, packWarGroups, transactionTooLarge, warBidAmounts, warBidCount, warPlayAmounts } from "./_lib/warbatch.js";
import { parseWarTokenAmount, sortQuoteWarGames } from "../src/lib/war-routing.js";
import { toWarView as view, type WarAsset as Asset, type WarView } from "../src/lib/war-view.js";
export { view };
export type { WarView };

/** The gold run: the featured game a bare lastbidwins.fun link opens. */
export const FEATURED = Number(process.env.WAR_FEATURED ?? 1083);

const conn = serverConnection();
const isKey = (s: unknown) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
/** An omitted quote preserves the all-wallet view; SOL/null selects just native SOL games. */
const optionalMint = (value: unknown): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === "" || (typeof value === "string" && (/^sol$/i.test(value) || value === WSOL_MINT))) return null;
  if (!isKey(value)) throw new Error("bad mint");
  return String(value);
};

const assetCache = new Map<string, { at: number; a: Asset }>();
async function assetOf(g: WarGame): Promise<Asset> {
  const mint = g.mint?.toBase58() ?? null;
  const k = mint ?? "SOL";
  // decimals come from the game (SOL is always 9): some old SOL games stored 0, and the cache is shared per token
  const decimals = g.isToken ? g.decimals : 9;
  const hit = assetCache.get(k);
  if (hit && Date.now() - hit.at < 30_000) return { ...hit.a, decimals };
  const capped = <T,>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
  const [usd, metaRaw] = await Promise.all([capped(usdPrice(mint ?? WSOL_MINT), 2_000, null), mint ? capped(getAsset(mint), 2_000, null) : Promise.resolve(null)]);
  let symbol = "SOL";
  let image: string | null = null;
  if (mint) {
    const meta = metaRaw as { symbol?: string; image?: string; content?: { metadata?: { symbol?: string }; links?: { image?: string } } } | null;
    symbol = meta?.symbol ?? meta?.content?.metadata?.symbol ?? (hit?.a.symbol && hit.a.symbol !== mint.slice(0, 4) ? hit.a.symbol : mint.slice(0, 4));
    image = meta?.image ?? meta?.content?.links?.image ?? null;
  }
  const a = { mint, symbol, decimals, usd, image };
  assetCache.set(k, { at: Date.now(), a });
  return a;
}

const units = (raw: bigint, dec: number) => Number(raw) / 10 ** dec;

const viewMemo = new Map<number, { at: number; p: Promise<{ g: WarGame; v: WarView } | null> }>();
export async function readView(id: number, fresh = false) {
  const hit = viewMemo.get(id);
  if (!fresh && hit && Date.now() - hit.at < 3_000) return hit.p;
  const p = (async () => {
    const g = await loadGame(conn, id);
    if (!g) return null;
    return { g, v: view(g, await assetOf(g)) };
  })();
  viewMemo.set(id, { at: Date.now(), p });
  p.catch(() => viewMemo.delete(id));
  return p;
}

async function list() {
  // The discovery index can be a minute old. Keep every unsettled game and append IDs created since that scan.
  const [known, next] = await Promise.all([allGames(conn), nextGameId(conn)]);
  const scanned = known.reduce((max, g) => Math.max(max, g.id + 1), 0);
  const ids = [...known.filter((g) => !g.over).map((g) => g.id), ...Array.from({ length: Math.max(0, next - scanned) }, (_, i) => scanned + i)];
  const batches: number[][] = [];
  for (let i = 0; i < ids.length; i += 100) batches.push(ids.slice(i, i + 100));
  const infos = (await Promise.all(batches.map((batch) => conn.getMultipleAccountsInfo(batch.map((id) => gamePda(id)))))).flat();
  const now = Math.floor(Date.now() / 1000);
  const games = ids.flatMap((id, i) => (infos[i] ? [decodeGame(id, gamePda(id), infos[i]!.data)] : [])).filter((g) => !g.over);
  const assets = new Map<string, Promise<Asset>>();
  const views = await Promise.all(games.map(async (g) => {
    const key = `${g.mint?.toBase58() ?? "SOL"}:${g.decimals}`;
    if (!assets.has(key)) assets.set(key, assetOf(g));
    return view(g, await assets.get(key)!, now);
  }));
  const rank = (v: WarView) => (v.phase === "live" || v.phase === "ending" ? 0 : v.phase === "open" ? 1 : 2);
  return views.sort((a, b) => rank(a) - rank(b) || (a.secondsLeft ?? Infinity) - (b.secondsLeft ?? Infinity) || (b.pot.usd ?? 0) - (a.pot.usd ?? 0) || b.id - a.id);
}

/** One transaction when it fits; otherwise the swap goes first in its own transaction and the game instructions follow
 *  (a router swap plus open + bid can land a byte over 1232). `split` is where the game instructions start. */
async function packAll(payer: PublicKey, ixs: TransactionInstruction[], alts: AddressLookupTableAccount[], split: number) {
  try {
    return [await pack(payer, ixs, alts)];
  } catch (e) {
    if (split <= 0 || !transactionTooLarge(e)) throw e;
    const first = await pack(payer, ixs.slice(0, split), alts);
    // the second is simulated against today's balances, so a bid that needs the swapped tokens can't be pre-checked: skip it
    return [first, await pack(payer, ixs.slice(split), [], false)];
  }
}

let bh: { at: number; v: Promise<string> } | null = null;
const blockhash = () => {
  if (!bh || Date.now() - bh.at > 5_000) bh = { at: Date.now(), v: conn.getLatestBlockhash("confirmed").then((x) => x.blockhash) };
  return bh.v;
};
/** What lastbidwins.fun/play plays right now: the war whose clock ends first, else the busiest
 *  open war that has a bid, else the gold run's successor (settle it if needed, open the next one with the same rules). */
export async function playTarget(mint?: string | null): Promise<{ id: number; action: "bid" | "next" | "start"; mint?: string | null }> {
  if (mint !== undefined && mint !== null && mint !== "") return playMint(mint);
  const games = await list();
  const running = games.filter((g) => (g.phase === "live" || g.phase === "ending") && g.bids > 0);
  if (running.length) return { id: running.sort((a, b) => a.deadline - b.deadline || (b.pot.usd ?? 0) - (a.pot.usd ?? 0))[0].id, action: "bid" };
  const open = games.filter((g) => g.phase === "open" && g.bids > 0);
  const featured = open.find((g) => g.id === FEATURED);
  if (featured || open.length) return { id: (featured ?? open.sort((a, b) => (b.pot.usd ?? 0) - (a.pot.usd ?? 0))[0]).id, action: "bid" };
  return { id: FEATURED, action: "next" };
}

/** /play/<mint>: the lowest required bid on that quote; else its last game's successor or a fresh game. */
async function playMint(mintArg: string): Promise<{ id: number; action: "bid" | "next" | "start"; mint: string | null }> {
  const sol = /^sol$/i.test(mintArg) || mintArg === WSOL_MINT;
  const mint = sol ? null : mintArg;
  const mine = (await list()).filter((g) => (sol ? !g.asset.mint : g.asset.mint === mint));
  const now = Math.floor(Date.now() / 1000);
  const views = mine.map((g) => ({ ...g, secondsLeft: g.deadline ? Math.max(0, g.deadline - now) : null }));
  const playable = sortQuoteWarGames(views, now).find((g) => !g.over && (!g.deadline || g.deadline > now));
  if (playable) return { id: playable.id, action: "bid", mint };
  const last = views.filter((v) => v.bids > 0).sort((a, b) => b.id - a.id)[0]
    ?? (await allGames(conn)).filter((g) => g.totalBids > 0 && (sol ? !g.isToken : g.mint?.toBase58() === mint)).sort((a, b) => b.id - a.id)[0];
  if (last) return { id: last.id, action: "next", mint };
  return { id: -1, action: "start", mint };
}

async function pack(payer: PublicKey, ixs: TransactionInstruction[], alts: AddressLookupTableAccount[] = [], check = true) {
  const recent = await blockhash();
  const msg = new TransactionMessage({
    payerKey: payer, recentBlockhash: recent,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }), ...ixs],
  }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  const bytes = tx.serialize();
  if (bytes.length > 1232) throw new Error(`transaction too large (${bytes.length} bytes)`);
  // simulate before handing it to a wallet, so a doomed transaction never reaches a signature prompt
  const sim = check ? await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true }) : null;
  if (sim?.value.err) {
    if (JSON.stringify(sim.value.err).includes("AccountNotFound")) throw new Error("this wallet has no SOL yet, so it can't pay the fee. Add SOL and tap again.");
    const why = (sim.value.logs ?? []).filter((l) => /Error Message|failed|insufficient/i.test(l)).slice(-1)[0] ?? JSON.stringify(sim.value.err);
    throw new Error(why.replace(/^Program log: /, ""));
  }
  return Buffer.from(bytes).toString("base64");
}

const SITE = "https://lastbidwins.fun";
const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K` : n >= 1 ? n.toFixed(2) : n.toPrecision(3));
export const money = (usd: number | null) => (usd === null ? "" : usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toPrecision(2)}`);
/** "bid $12.58 to win $49.90 (4.0×)": the line every post leads with. */
export const payoffText = (v: { minNext: { units: number; usd: number | null }; payoff: { win: { units: number; usd: number | null }; multiple: number } }, symbol: string) =>
  `bid ${v.minNext.usd !== null ? money(v.minNext.usd) : amountText(v.minNext, symbol)} to win ${v.payoff.win.usd !== null ? money(v.payoff.win.usd) : amountText(v.payoff.win, symbol)} (${v.payoff.multiple.toFixed(1)}×) if nobody tops it`;
export const amountText = (a: { units: number; usd: number | null }, symbol: string) => `${compact(a.units)} $${symbol}${a.usd === null ? "" : ` (~${money(a.usd)})`}`;

/** The one post @lastbidwins makes per game: it opens the thread every player replies under. */
async function announce(id: number) {
  const have = await getThread(id);
  if (have) return { thread: have.tweetId, existed: true };
  const out = await readView(id);
  if (!out) throw new Error("no such game");
  const v = out.v;
  if (v.bids < 1 || v.over) throw new Error("only an open game with an opening bid gets announced");
  const sym = v.asset.symbol;
  const clock = v.phase === "open" ? `clock starts on the 2nd bid, ${Math.round(v.roundSecs / 60)} min` : `${Math.ceil((v.secondsLeft ?? 0) / 60)} min left`;
  const text = [
    `war #${id} is open: $${sym}`,
    `pot ${amountText(v.pot, sym)}`,
    `${payoffText(v, sym)} · ${clock}`,
    `last bid when it dies takes ${v.pct.winner / 100}%. every bid mints a key that earns off every bid after it.`,
    `phone: tap, sign in Phantom, done → ${phantomLink(`${SITE}/a?op=bid&g=${id}`)}`,
    `${SITE}/a?op=bid&g=${id}&v=${v.tag}`,
  ].join("\n");
  const link = lastUrl(text);
  if (link) await prewarm(link);
  const tweetId = await xPost(text);
  await setThread(id, { tweetId, at: Date.now(), by: "lastbidwins" });
  return { thread: tweetId, existed: false };
}

/** "bull" / "snek" / "bear" or 0-2. */
export const teamOf = (t: unknown, wallet?: string): Team => {
  const s = String(t ?? "").toLowerCase();
  const i = ["bull", "snek", "bear"].indexOf(s);
  if (i >= 0) return i as Team;
  if (s !== "" && s !== "auto" && [0, 1, 2].includes(Number(s))) return Number(s) as Team;
  return wallet ? autoTeam(wallet) : 1;
};
/** A bid amount from a link: min (default), +10% / 10pct, 2x, or a number of tokens. Resolved against the live game. */
function resolveAmount(g: WarGame, spec: unknown): bigint {
  const min = minNextBid(g);
  const s = String(spec ?? "min").toLowerCase().replace(/\s/g, "");
  if (s === "" || s === "min") return min;
  if (s === "2x" || s === "2×" || s === "double") return min * 2n;
  if (s === "+10%" || s === "10pct" || s === "10%") return (min * 11n) / 10n;
  if (s === "+5%" || s === "5pct" || s === "5%") return (min * 105n) / 100n;
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m|b)?$/);
  if (m) {
    const mult = m[2] === "k" ? 1_000n : m[2] === "m" ? 1_000_000n : m[2] === "b" ? 1_000_000_000n : 1n;
    const raw = parseWarTokenAmount(m[1], g.decimals) * mult;
    return raw < min ? min : raw;
  }
  return min;
}

/** Exact creation options for a first game, previewed before it exists on chain. */
async function openingTemplate(mintStr: string | null, minimum?: unknown) {
  const mint = mintStr ? new PublicKey(mintStr) : null;
  const decimals = mint ? (await conn.getAccountInfo(mint))?.data[44] : 9;
  if (decimals === undefined) throw new Error("mint not found");
  const custom = minimum !== undefined && minimum !== null;
  if (custom && typeof minimum !== "string") throw new Error("minimum bid must be a decimal amount in token units");
  const usd = await usdPrice(mint ? mint.toBase58() : WSOL_MINT).catch(() => null);
  if (!custom && !usd) throw new Error("no price for that token yet, so the opening bid can't be sized");
  const defaultUnits = usd ? 1 / usd : 0; // about $1 unless the creator chooses a minimum
  const mag = usd ? 10 ** Math.floor(Math.log10(defaultUnits)) : 1;
  const minBid = custom ? parseWarTokenAmount(minimum as string, decimals)
    : BigInt(Math.max(1, Math.ceil(Math.ceil(defaultUnits / mag) * mag * 10 ** decimals)));
  const g: WarGame = {
    id: -1, key: PublicKey.default, creator: PublicKey.default, dev: PublicKey.default,
    roundSecs: 3600, antiSnipeSecs: 60, antiSnipeExtendSecs: 60, minBid, mint, decimals, isToken: !!mint,
    pct: { winner: 7000, dev: 500, creator: 1500, referrer: 1000 },
    pot: 0n, totalBids: 0, lastBidder: PublicKey.default, lastReferrer: null, lastBid: 0n, lastTeam: 0,
    deadline: 0, over: false, claimedAt: 0, totalKeys: 0, divPerKeyX18: 0n, teamBids: [0, 0, 0],
  };
  const asset = { ...await assetOf(g), usd };
  return { g, asset };
}
async function start(wallet: PublicKey, mintStr: string | null, team: Team, ref: PublicKey | null, minimum?: unknown) {
  const { g, asset } = await openingTemplate(mintStr, minimum);
  const { mint, minBid, decimals } = g;
  const usd = asset.usd;
  const created = await createGameIxs(conn, wallet, g);
  const ixs: TransactionInstruction[] = [];
  let alts: AddressLookupTableAccount[] = [];
  let split = 0;
  let swapIn: { lamports: string; via: string } | null = null;
  if (mint) {
    const have = await tokenBalance(conn, wallet, mint);
    if (have < minBid) {
      const z = await zapIn(conn, wallet, mint, minBid - have);
      ixs.push(...z.ixs);
      alts = z.alts;
      split = ixs.length;
      swapIn = { lamports: z.lamportsIn.toString(), via: z.via };
    }
  }
  await needSol(wallet, (mint ? BigInt(swapIn?.lamports ?? "0") : minBid) + 3_000_000n); // + the new game's rent
  ixs.push(...created.ixs);
  const stub = { id: created.id, key: created.game, isToken: !!mint, mint } as WarGame;
  ixs.push(...(await bidIxs(conn, stub, wallet, minBid, team, ref)));
  return { txs: await packAll(wallet, ixs, alts, split), summary: { op: "start", game: created.id, amount: minBid.toString(), total: minBid.toString(), count: 1, plays: 1, opening: Number(minBid) / 10 ** decimals, usd: usd === null ? null : (Number(minBid) / 10 ** decimals) * usd, swapIn } };
}

/** One war's keyholders: what each put in, what their keys earned, and the multiple; plus the average and the top 5 by keys. */
export async function holdersView(id: number) {
  const out = await readView(id);
  if (!out) return null;
  const { g, v } = out;
  const { holders, finalPot, payout } = await holdersOf(conn, g);
  const dec = v.asset.decimals;
  const u = (raw: bigint) => Number(raw) / 10 ** dec;
  const usd = (raw: bigint) => (v.asset.usd === null ? null : u(raw) * v.asset.usd);
  // after a payout the account's pot reads 0; the pot rebuilt from the bids is what was (or will be) paid
  const pot = g.pot > 0n ? g.pot : finalPot;
  // once paid out, what the settle transaction actually sent beats any arithmetic
  const leaderKey = g.totalBids ? g.lastBidder.toBase58() : "";
  const win = payout?.get(leaderKey) ?? (pot * BigInt(g.pct.winner)) / 10_000n;
  const refPaid = g.lastReferrer ? payout?.get(g.lastReferrer.toBase58()) : undefined;
  const rows = holders.map((h) => {
    const multiple = h.risked > 0n ? Number(h.earned) / Number(h.risked) : 0;
    // the leader's multiple if the clock died now: dividends plus the winner's cut
    const ifEnds = h.leader && h.risked > 0n ? Number(h.earned + win) / Number(h.risked) : multiple;
    return { wallet: h.wallet, keys: h.keys, leader: h.leader, risked: { units: u(h.risked), usd: usd(h.risked) }, earned: { units: u(h.earned), usd: usd(h.earned) }, multiple, ifEnds };
  }).sort((a, b) => b.keys - a.keys || b.risked.units - a.risked.units);
  const n = rows.length || 1;
  const avg = {
    keys: rows.reduce((a, r) => a + r.keys, 0) / n,
    risked: { units: rows.reduce((a, r) => a + r.risked.units, 0) / n, usd: v.asset.usd === null ? null : rows.reduce((a, r) => a + (r.risked.usd ?? 0), 0) / n },
    earned: { units: rows.reduce((a, r) => a + r.earned.units, 0) / n, usd: v.asset.usd === null ? null : rows.reduce((a, r) => a + (r.earned.usd ?? 0), 0) / n },
    multiple: rows.reduce((a, r) => a + r.multiple, 0) / n,
  };
  const winner = rows.find((r) => r.leader) ?? null;
  const ended = v.phase === "expired" || v.phase === "settled";
  return {
    id, symbol: v.asset.symbol, holders: rows.length, top: rows.slice(0, 5), avg, all: rows, ended, settled: v.phase === "settled",
    pot: { units: u(pot), usd: usd(pot) }, win: { units: u(win), usd: usd(win) },
    referrerTakes: { units: u(refPaid ?? (pot * BigInt(g.pct.referrer)) / 10_000n), usd: usd(refPaid ?? (pot * BigInt(g.pct.referrer)) / 10_000n) },
    paidOut: !!payout,
    referrer: v.leaderReferrer, winner,
    keysEarned: { units: rows.reduce((a, r) => a + r.earned.units, 0), usd: v.asset.usd === null ? null : rows.reduce((a, r) => a + (r.earned.usd ?? 0), 0) },
  };
}

/** Everything `wallet` holds across all wars: keys and claimable dividends per war, totals per asset in tokens and USD. */
export async function bagSummary(wallet: PublicKey, mint?: string | null) {
  return summarizeBag(wallet, await bagOf(conn, wallet, mint), mint);
}

async function summarizeBag(wallet: PublicKey, rows: Awaited<ReturnType<typeof bagOf>>, mint?: string | null) {
  const assets = new Map<string, Promise<Asset>>();
  const items = await Promise.all(rows.map(async (r) => {
    const key = `${r.game.mint?.toBase58() ?? "SOL"}:${r.game.isToken ? r.game.decimals : 9}`;
    if (!assets.has(key)) assets.set(key, assetOf(r.game));
    const a = await assets.get(key)!;
    const units = Number(r.owed) / 10 ** a.decimals;
    return { id: r.game.id, symbol: a.symbol, mint: a.mint, decimals: a.decimals, keys: r.keys, owedRaw: r.owed.toString(), owed: units, usd: a.usd === null ? null : units * a.usd, live: !r.game.over };
  }));
  const totals: Record<string, { symbol: string; mint: string | null; decimals: number; keys: number; keysRaw: string; owed: number; owedRaw: string; usd: number | null; wars: number }> = {};
  for (const i of items) {
    const t = (totals[i.mint ?? "SOL"] ??= { symbol: i.symbol, mint: i.mint, decimals: i.decimals, keys: 0, keysRaw: "0", owed: 0, owedRaw: "0", usd: 0, wars: 0 });
    t.keysRaw = (BigInt(t.keysRaw) + BigInt(i.keys)).toString();
    t.keys = Number(t.keysRaw);
    t.owedRaw = (BigInt(t.owedRaw) + BigInt(i.owedRaw)).toString();
    t.owed = Number(t.owedRaw) / 10 ** t.decimals;
    t.usd = t.usd === null || i.usd === null ? null : t.usd + i.usd;
    t.wars += 1;
  }
  const usd = Object.values(totals).reduce((a, t) => (a === null || t.usd === null ? null : a + t.usd), 0 as number | null);
  const keysRaw = items.reduce((a, i) => a + BigInt(i.keys), 0n).toString();
  return { wallet: wallet.toBase58(), quote: mint === undefined ? undefined : mint ?? "SOL", wars: items.length, keys: Number(keysRaw), keysRaw, claimable: items.filter((i) => BigInt(i.owedRaw) > 0n), totals: Object.values(totals), usd, items };
}

/** Claim dividends from every war that owes `wallet` something, packed into as few transactions as fit. */
async function claimAll(wallet: PublicKey, mint?: string | null) {
  const rows = (await bagOf(conn, wallet, mint)).filter((r) => r.owed > 0n);
  if (!rows.length) throw new Error(mint === undefined ? "no dividends to claim in any war yet" : "no dividends to claim on this quote yet");
  const txs: string[] = [];
  let batch: TransactionInstruction[] = [];
  for (const r of rows) {
    const ixs = await claimDividendIxs(conn, r.game, wallet);
    try {
      await pack(wallet, [...batch, ...ixs], [], false);
      batch.push(...ixs);
    } catch (error) {
      if (!transactionTooLarge(error)) throw error;
      if (batch.length) txs.push(await pack(wallet, batch, [], false));
      else throw error;
      batch = [...ixs];
    }
  }
  if (batch.length) txs.push(await pack(wallet, batch, [], false));
  const sum = await summarizeBag(wallet, rows, mint);
  return { txs, summary: { op: "claimall", quote: mint === undefined ? undefined : mint ?? "SOL", wars: rows.length, totals: sum.totals, usd: sum.usd } };
}

/** Fail early, in plain words, when the wallet can't pay: an empty wallet doesn't exist on chain yet, which a simulation
 *  reports as "AccountNotFound". `lamports` is what the move spends from SOL (the swap in, or a SOL bid). */
async function needSol(wallet: PublicKey, lamports: bigint) {
  const BUFFER = 6_000_000n; // fees, priority fee, and rent for the token accounts a first bid opens
  const have = BigInt(await conn.getBalance(wallet));
  const need = lamports + BUFFER;
  if (have >= need) return;
  const solUsd = await usdPrice(WSOL_MINT).catch(() => null);
  const sol = (n: bigint) => (Number(n) / 1e9).toFixed(Number(n) < 1e8 ? 4 : 3);
  throw new Error(`this needs about ${sol(need)} SOL${solUsd ? ` (~$${((Number(need) / 1e9) * solUsd).toFixed(2)})` : ""} and the wallet has ${sol(have)}. Add SOL and tap again.`);
}

type BatchMove = { op: "bid" | "fork" | "next" | "start"; amount: string; g?: number; from?: number; mint?: string | null; min?: string };
const quoteOf = (g: WarGame) => JSON.stringify([g.mint?.toBase58() ?? null, g.isToken ? g.decimals : 9]);

/** Each routed fork pays for two opening bids atomically, so its cloned clock starts immediately. */
async function multibid(body: Record<string, unknown>) {
  if (!Array.isArray(body.moves) || !body.moves.length || body.moves.length > MAX_WAR_BIDS) throw new Error(`send between 1 and ${MAX_WAR_BIDS} moves`);
  const moves: BatchMove[] = body.moves.map((raw: unknown, index: number) => {
    if (!raw || typeof raw !== "object") throw new Error("bad bid move");
    const m = raw as Record<string, unknown>;
    if (m.op !== "bid" && m.op !== "fork" && m.op !== "next" && m.op !== "start") throw new Error("move must bid, fork or start a war");
    if (typeof m.amount !== "string" || !/^\d+$/.test(m.amount)) throw new Error("bid amounts must be raw integer strings");
    const amount = BigInt(m.amount);
    warBidAmounts(amount, 1);
    if (m.op === "start") {
      if (index !== 0 || m.g !== undefined || m.from !== undefined) throw new Error("only the first move can start a new quote");
      const mint = !m.mint || /^sol$/i.test(String(m.mint)) || m.mint === WSOL_MINT ? null : String(m.mint);
      if (mint && !isKey(mint)) throw new Error("bad mint");
      if (m.min !== undefined && m.min !== null && typeof m.min !== "string") throw new Error("minimum bid must be a decimal amount in token units");
      return { op: "start", mint, amount: amount.toString(), ...(typeof m.min === "string" ? { min: m.min } : {}) };
    }
    const hasGame = m.g !== undefined;
    const hasFrom = m.from !== undefined;
    if (hasGame === hasFrom) throw new Error("a move needs either a game or an earlier opening move");
    if (hasGame && (!Number.isSafeInteger(m.g) || Number(m.g) < 0)) throw new Error("bad game number");
    if (hasFrom && (!Number.isInteger(m.from) || Number(m.from) < 0 || Number(m.from) >= index)) throw new Error("opening move must come before its bids");
    return { op: m.op, amount: amount.toString(), ...(hasGame ? { g: Number(m.g) } : { from: Number(m.from) }) };
  });
  const firstAmount = BigInt(moves[0].amount);
  const pricing = warPlayAmounts(firstAmount, moves.map((m) => m.op));
  const amounts = pricing.moveAmounts;
  if (moves.some((m, i) => BigInt(m.amount) !== amounts[i])) throw new Error("each paid bid must increase by one raw unit; forks include two opening bids");
  const wallet = new PublicKey(String(body.wallet));
  const ref = isKey(body.ref) ? new PublicKey(String(body.ref)) : null;
  const team = teamOf(body.team, String(body.wallet));
  const ids = [...new Set(moves.flatMap((m) => m.g === undefined ? [] : [m.g]))];
  const loaded = await Promise.all(ids.map(async (id) => [id, await loadGame(conn, id)] as const));
  const games = new Map<number, WarGame>();
  for (const [id, game] of loaded) {
    if (!game) throw new Error(`no such game: ${id}`);
    games.set(id, { ...game });
  }
  const starting = moves[0].op === "start" ? await openingTemplate(moves[0].mint ?? null, moves[0].min) : null;
  const template = starting?.g ?? games.values().next().value as WarGame | undefined;
  if (!template) throw new Error("the first move needs a game template");
  const quote = quoteOf(template);
  if ([...games.values()].some((g) => quoteOf(g) !== quote)) throw new Error("all bids must use the same quote");
  const asset = starting?.asset ?? await assetOf(template);
  const total = pricing.total;
  const usd = (raw: bigint) => asset.usd === null ? null : units(raw, asset.decimals) * asset.usd;
  let alts: AddressLookupTableAccount[] = [];
  let swapIn: { lamports: string; via: string } | null = null;
  const groups: TransactionInstruction[][] = [];
  if (template.isToken) {
    const have = await tokenBalance(conn, wallet, template.mint!);
    if (have < total) {
      const z = await zapIn(conn, wallet, template.mint!, total - have);
      groups.push(z.ixs);
      alts = z.alts;
      swapIn = { lamports: z.lamportsIn.toString(), via: z.via };
    }
  }
  const openingCount = moves.filter((m) => m.op !== "bid").length;
  const existingBidTargets = new Set(moves.flatMap((m) => m.op === "bid" && m.g !== undefined ? [m.g] : []));
  // Later chunks cannot be simulated against the preceding chunks' state. Reserve rent for every new game's
  // account, player record, and token vault, plus player/vault records that bids into existing games may open.
  const rentReserve = BigInt(openingCount) * (template.isToken ? 7_000_000n : 4_500_000n)
    + BigInt(existingBidTargets.size) * (template.isToken ? 4_000_000n : 1_500_000n);
  const feeReserve = BigInt(Math.ceil((pricing.count + openingCount + (swapIn ? 1 : 0)) / 3)) * 30_000n;
  await needSol(wallet, (template.isToken ? BigInt(swapIn?.lamports ?? "0") : total) + rentReserve + feeReserve);
  let nextId = openingCount ? await nextGameId(conn) : 0;
  const created: number[] = [];
  const openedByMove = new Map<number, WarGame>();
  const results: { op: BatchMove["op"]; game: number; amount: string; units: number; usd: number | null }[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const [index, move] of moves.entries()) {
    const source = move.op === "start" ? template : move.g === undefined ? openedByMove.get(move.from!) : games.get(move.g);
    if (!source) throw new Error("that earlier move did not open a game");
    const amount = amounts[index];
    const ixs: TransactionInstruction[] = [];
    let target = source;
    if (move.op === "bid") {
      const ph = phase(source, now);
      if (ph === "expired" || ph === "settled") throw new Error(`war #${source.id} is over: start the next war`);
      const min = minNextBid(source);
      if (amount < min) throw new Error(`war #${source.id} needs at least ${units(min, asset.decimals)} ${asset.symbol}`);
    } else {
      if (amount < source.minBid) throw new Error(`the opening bid needs at least ${units(source.minBid, asset.decimals)} ${asset.symbol}`);
      if (move.op === "next") {
        const ph = phase(source, now);
        if (ph !== "expired" && ph !== "settled") throw new Error(`war #${source.id} is still running`);
        if (!source.over) {
          groups.push(await settleIxs(conn, source, wallet));
          source.over = true;
        }
      }
      // A fork creates its own game and pays both opening bids; the source game and its pot remain untouched.
      const opened = await createGameIxs(conn, wallet, {
        roundSecs: source.roundSecs, antiSnipeSecs: source.antiSnipeSecs, antiSnipeExtendSecs: source.antiSnipeExtendSecs,
        minBid: source.minBid, pct: { ...source.pct }, mint: source.mint,
      }, nextId++);
      ixs.push(...opened.ixs);
      target = { ...source, id: opened.id, key: opened.game, creator: wallet, over: false, deadline: 0, totalBids: 0, totalKeys: 0, lastBid: 0n, pot: 0n, lastReferrer: null };
      created.push(target.id);
      games.set(target.id, target);
      openedByMove.set(index, target);
    }
    const paid = move.op === "fork" ? [amount, amount + 1n] : [amount];
    for (const [paidIndex, paidAmount] of paid.entries()) {
      ixs.push(...await bidIxs(conn, target, wallet, paidAmount, team, ref));
      target.totalBids++;
      target.totalKeys++;
      target.lastBid = paidAmount;
      target.lastBidder = wallet;
      if (target.totalBids === 2 && !target.deadline) target.deadline = now + target.roundSecs;
      else if (target.deadline > now && target.deadline - now <= target.antiSnipeSecs) target.deadline += target.antiSnipeExtendSecs;
      results.push({ op: paidIndex === 0 ? move.op : "bid", game: target.id, amount: paidAmount.toString(), units: units(paidAmount, asset.decimals), usd: usd(paidAmount) });
    }
    // Keep creation plus both fork bids indivisible: a clone cannot land with only its first opening bid.
    groups.push(ixs);
  }
  // SOL instructions measured below 21k CU each, including new games and player accounts. An 18-instruction
  // bound reserves 35k each (630k total) within the 700k budget; serialization still enforces 1232 bytes.
  // Token/Token-2022 and swap routes retain their existing conservative three-group limit.
  const txs = await packWarGroups(groups, (ixs, check) => pack(wallet, ixs, alts, check), template.isToken ? 3 : MAX_WAR_BIDS, template.isToken ? Infinity : 18);
  return { txs, summary: { op: "multibid", game: results.at(-1)!.game, count: pricing.count, plays: pricing.plays, amount: firstAmount.toString(), lastAmount: pricing.lastAmount.toString(), total: total.toString(), units: units(total, asset.decimals), usd: usd(total), moves: results, created, team: TEAMS[team], symbol: asset.symbol, swapIn } };
}

async function build(body: Record<string, unknown>) {
  const op = String(body.op ?? "");
  if (op === "announce") return announce(body.g === "featured" || body.g === undefined ? FEATURED : Number(body.g));
  if (op === "prewarm") {
    const url = String(body.url ?? "");
    if (!/^https:\/\/(www\.)?lastbidwins\.fun\//.test(url)) throw new Error("only lastbidwins.fun links");
    await prewarm(url);
    return { warmed: url };
  }
  if (!isKey(body.wallet)) throw new Error("wallet required");
  if (op === "multibid") return multibid(body);
  if (op === "claimall") return claimAll(new PublicKey(String(body.wallet)), optionalMint(body.mint));
  if (op === "play") {
    const t = await playTarget(body.mint ? String(body.mint) : null);
    if (t.action === "start") return build({ ...body, op: "start", mint: t.mint ?? "SOL" });
    return build({ ...body, op: t.action, g: t.id, amt: "min" });
  }
  if (op === "start") {
    const mint = body.mint && String(body.mint).toUpperCase() !== "SOL" ? String(body.mint) : null;
    if (mint && !isKey(mint)) throw new Error("bad mint");
    return start(new PublicKey(String(body.wallet)), mint, teamOf(body.team, String(body.wallet)), isKey(body.ref) ? new PublicKey(String(body.ref)) : null, body.min);
  }
  const wallet = new PublicKey(String(body.wallet));
  const id = body.g === "featured" || body.g === undefined ? FEATURED : Number(body.g);
  const g = await loadGame(conn, id);
  if (!g) throw new Error("no such game");
  if (op === "fork" || (op === "bid" && body.count !== undefined)) {
    const count = warBidCount(body.count ?? 1);
    const first = body.amount !== undefined ? BigInt(String(body.amount)) : op === "fork" ? g.minBid : resolveAmount(g, body.amt);
    const operations = Array.from({ length: count }, (_, index) => index === 0 ? op : "bid");
    const moves = warPlayAmounts(first, operations).moveAmounts.map((amount, index) => ({
      op: operations[index], amount: amount.toString(),
      ...(op === "fork" && index > 0 ? { from: 0 } : { g: id }),
    }));
    const batch = await multibid({ ...body, moves });
    return { ...batch, summary: { ...batch.summary, op, ...(op === "fork" ? { prev: id, opening: units(first, g.isToken ? g.decimals : 9) } : {}) } };
  }
  // warm what the build needs next while the price loads: the mint's program, the token balance, a blockhash
  const balP = g.isToken ? tokenBalance(conn, new PublicKey(String(body.wallet)), g.mint!).catch(() => null) : Promise.resolve(null);
  const [a] = await Promise.all([assetOf(g), g.isToken ? tokenProgramOf(conn, g.mint!).catch(() => null) : null, balP]);
  const ref = isKey(body.ref) ? new PublicKey(String(body.ref)) : null;
  const team = teamOf(body.team, String(body.wallet));
  const usd = (raw: bigint) => (a.usd === null ? null : units(raw, a.decimals) * a.usd);
  const ixs: TransactionInstruction[] = [];
  let alts: AddressLookupTableAccount[] = [];
  let swapIn: { lamports: string; via: string } | null = null;
  let split = 0;

  // a token bid needs the tokens in hand by the time the bid runs: swap the shortfall in from SOL first
  const fund = async (need: bigint) => {
    if (!g.isToken) return;
    const have = (await balP) ?? (await tokenBalance(conn, wallet, g.mint!));
    if (have >= need) return;
    const z = await zapIn(conn, wallet, g.mint!, need - have);
    ixs.push(...z.ixs);
    alts = z.alts;
    swapIn = { lamports: z.lamportsIn.toString(), via: z.via };
    split = ixs.length;
  };

  if (op === "bid") {
    const min = minNextBid(g);
    const amount = body.amount ? BigInt(String(body.amount)) : resolveAmount(g, body.amt);
    if (amount < min) throw new Error(`the bid has to be at least ${units(min, a.decimals)} ${a.symbol}`);
    const ph = phase(g);
    if (ph === "expired" || ph === "settled") throw new Error("this round is over: start the next war");
    await fund(amount);
    await needSol(wallet, g.isToken ? BigInt((swapIn as { lamports: string } | null)?.lamports ?? "0") : amount);
    ixs.push(...(await bidIxs(conn, g, wallet, amount, team, ref)));
    return { txs: await packAll(wallet, ixs, alts, split), summary: { op, game: id, amount: amount.toString(), units: units(amount, a.decimals), usd: usd(amount), team: TEAMS[team], symbol: a.symbol, swapIn } };
  }
  if (op === "settle") {
    if (phase(g) !== "expired") throw new Error("nothing to settle: the clock is still running or the pot is paid");
    ixs.push(...(await settleIxs(conn, g, wallet)));
    return { txs: [await pack(wallet, ixs)], summary: { op, game: id, pot: units(g.pot, a.decimals), usd: usd(g.pot), winner: g.lastBidder.toBase58() } };
  }
  if (op === "next") {
    const ph = phase(g);
    if (ph !== "expired" && ph !== "settled") throw new Error("this round is still running");
    await fund(g.minBid);
    await needSol(wallet, (g.isToken ? BigInt((swapIn as { lamports: string } | null)?.lamports ?? "0") : g.minBid) + 3_000_000n);
    const n = await nextWarIxs(conn, g, wallet, team, ref);
    ixs.push(...n.ixs);
    return { txs: await packAll(wallet, ixs, alts, split), summary: { op, game: n.id, prev: id, opening: units(g.minBid, a.decimals), usd: usd(g.minBid), symbol: a.symbol, swapIn } };
  }
  if (op === "claim") {
    const me = await loadPlayer(conn, g, wallet);
    if (me.owed <= 0n) throw new Error("no dividends to claim yet");
    ixs.push(...(await claimDividendIxs(conn, g, wallet)));
    let swapOut: { lamports: string; via: string } | null = null;
    if (g.isToken && body.zap) {
      const z = await zapOut(conn, wallet, g.mint!, me.owed);
      ixs.push(...z.ixs);
      alts = z.alts;
      swapOut = { lamports: z.expectedLamports.toString(), via: z.via };
    }
    return { txs: [await pack(wallet, ixs, alts)], summary: { op, game: id, owed: units(me.owed, a.decimals), usd: usd(me.owed), symbol: a.symbol, swapOut } };
  }
  throw new Error("op must be bid, multibid, fork, settle, next or claim");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("access-control-allow-origin", "*").setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body ?? {});
      return res.setHeader("cache-control", "no-store").status(200).json(await build(body));
    }
    if (req.query.start) {
      const mintArg = typeof req.query.mint === "string" ? req.query.mint : "SOL";
      const mint = /^sol$/i.test(mintArg) || mintArg === WSOL_MINT ? null : mintArg;
      if (mint && !isKey(mint)) throw new Error("bad mint");
      const preview = await openingTemplate(mint, req.query.min);
      return res.setHeader("cache-control", "no-store").json({ start: true, mint, phase: "none", template: view(preview.g, preview.asset) });
    }
    const fresh = req.query.fresh === "1";
    if (req.query.list) return res.setHeader("cache-control", fresh ? "no-store" : "public, s-maxage=5, stale-while-revalidate=30").json({ games: await list(), featured: FEATURED });
    if (isKey(req.query.bag)) return res.setHeader("cache-control", "no-store").json(await bagSummary(new PublicKey(String(req.query.bag)), optionalMint(req.query.mint)));
    if (req.query.holders) {
      const hid = req.query.g === "play" ? (await playTarget()).id : req.query.g === "featured" || req.query.g === undefined ? FEATURED : Number(req.query.g);
      const hv = await holdersView(hid);
      return hv ? res.setHeader("cache-control", "public, s-maxage=10, stale-while-revalidate=60").json(hv) : res.status(404).json({ error: "no such game" });
    }
    const target = req.query.g === "play" ? await playTarget(typeof req.query.mint === "string" ? req.query.mint : null) : null;
    if (target?.action === "start") {
      const preview = await openingTemplate(target.mint ?? null);
      return res.setHeader("cache-control", "no-store").json({ start: true, mint: target.mint, phase: "none", template: view(preview.g, preview.asset) });
    }
    const id = target ? target.id : req.query.g === "featured" || req.query.g === undefined ? FEATURED : Number(req.query.g);
    const [out, threadRecord] = await Promise.all([readView(id, fresh), getThreadPreview(id)]);
    if (!out) return res.status(404).json({ error: "no such game" });
    let me = null;
    if (isKey(req.query.wallet)) {
      const w = new PublicKey(String(req.query.wallet));
      const [p, tokens, lamports] = await Promise.all([
        loadPlayer(conn, out.g, w),
        out.g.isToken ? tokenBalance(conn, w, out.g.mint!) : Promise.resolve(null),
        conn.getBalance(w),
      ]);
      const u = (raw: bigint) => ({ raw: raw.toString(), units: units(raw, out.v.asset.decimals), usd: out.v.asset.usd === null ? null : units(raw, out.v.asset.decimals) * out.v.asset.usd });
      me = { keys: p.keys, owed: u(p.owed), tokenBalance: tokens === null ? null : u(tokens), solBalance: lamports / 1e9 };
    }
    const thread = threadRecord?.tweetId ?? null;
    return res.setHeader("cache-control", me || fresh ? "no-store" : "public, s-maxage=2, stale-while-revalidate=10").json({ ...out.v, me, thread, featured: FEATURED });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : "failed" });
  }
}
