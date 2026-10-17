// Stars War (stacc's fomo3d / war of attrition) on Solana: program Hbu4EByG…, shared by the page, the API and the share cards.
// Every bid must beat the last one and mints a key; ~10% of each later bid goes to earlier keys, the rest to the pot. The clock
// starts on the second bid; a bid inside the anti-snipe window pushes the deadline out. When it runs out, anyone settles: the pot
// splits winner / dev / creator / referrer (the referrer of the winning bid). SOL games, or any SPL / Token-2022 mint.
// Encoded by hand from the program's Anchor IDL (staccbot-tg server/lib/sol-idl.json), so no Anchor runtime in the bundle.
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

export const WAR_PROGRAM = new PublicKey("Hbu4EByGc17GxHYyiazxDMvtL6VvKxV4aRsZW95uzfu7");
export const TEAMS = ["Bull", "Snek", "Bear"] as const; // team byte 0 counts as bull_bids, 1 as snek_bids (checked on chain)
export type Team = 0 | 1 | 2;

const DISC = {
  create_game: [124, 69, 75, 66, 184, 220, 72, 206],
  bid_sol: [111, 148, 12, 118, 216, 85, 109, 76],
  bid_token: [112, 27, 251, 177, 231, 26, 102, 195],
  claim: [62, 198, 214, 193, 213, 159, 108, 210],
  distribute_sol_pot: [128, 75, 164, 207, 90, 158, 94, 244],
  distribute_token_pot: [209, 70, 153, 116, 102, 183, 156, 221],
  claim_dividend_sol: [152, 158, 219, 50, 188, 167, 24, 192],
  claim_dividend_token: [166, 137, 201, 206, 148, 211, 206, 233],
} as const;
const GAME_DISC = [27, 90, 166, 125, 74, 100, 121, 18];
const FACTORY_DISC = [159, 68, 192, 61, 48, 249, 216, 202];

export const factoryPda = () => PublicKey.findProgramAddressSync([Buffer.from("factory")], WAR_PROGRAM)[0];
export const gamePda = (id: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(id));
  return PublicKey.findProgramAddressSync([Buffer.from("game"), b], WAR_PROGRAM)[0];
};
export const playerPda = (game: PublicKey, wallet: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("player"), game.toBuffer(), wallet.toBuffer()], WAR_PROGRAM)[0];

export type WarGame = {
  id: number;
  key: PublicKey;
  creator: PublicKey;
  dev: PublicKey;
  roundSecs: number;
  antiSnipeSecs: number;
  antiSnipeExtendSecs: number;
  minBid: bigint;
  pct: { winner: number; dev: number; creator: number; referrer: number };
  pot: bigint; // raw units of the game's asset (lamports for SOL games)
  totalBids: number;
  lastBidder: PublicKey;
  lastReferrer: PublicKey | null;
  lastBid: bigint;
  lastTeam: number;
  deadline: number; // unix seconds; 0 until the second bid
  over: boolean;
  claimedAt: number;
  totalKeys: number;
  divPerKeyX18: bigint;
  isToken: boolean;
  mint: PublicKey | null;
  decimals: number;
  teamBids: [number, number, number]; // bull, snek, bear
};

const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32));
const u128 = (d: Buffer, o: number) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);

export function decodeGame(id: number, key: PublicKey, data: Uint8Array): WarGame {
  const d = Buffer.from(data);
  if (d.length < 297 || GAME_DISC.some((b, i) => d[i] !== b)) throw new Error("not a Stars War game");
  const ref = pk(d, 172);
  const isToken = d[250] === 1;
  return {
    id, key,
    creator: pk(d, 16), dev: pk(d, 48),
    roundSecs: Number(d.readBigInt64LE(80)), antiSnipeSecs: Number(d.readBigInt64LE(88)), antiSnipeExtendSecs: Number(d.readBigInt64LE(96)),
    minBid: d.readBigUInt64LE(104),
    pct: { winner: d.readUInt16LE(112), dev: d.readUInt16LE(114), creator: d.readUInt16LE(116), referrer: d.readUInt16LE(118) },
    pot: isToken ? d.readBigUInt64LE(128) : d.readBigUInt64LE(120),
    totalBids: d.readUInt32LE(136),
    lastBidder: pk(d, 140), lastReferrer: ref.equals(PublicKey.default) ? null : ref,
    lastBid: d.readBigUInt64LE(204), lastTeam: d[212],
    deadline: Number(d.readBigInt64LE(213)), over: d[221] === 1, claimedAt: Number(d.readBigInt64LE(222)),
    totalKeys: d.readUInt32LE(230), divPerKeyX18: u128(d, 234),
    isToken, mint: isToken ? pk(d, 251) : null, decimals: d[283],
    teamBids: [d.readUInt32LE(288), d.readUInt32LE(284), d.readUInt32LE(292)],
  };
}

export async function nextGameId(conn: Connection): Promise<number> {
  const a = await conn.getAccountInfo(factoryPda());
  if (!a || FACTORY_DISC.some((b, i) => a.data[i] !== b)) throw new Error("Stars War factory not found");
  return Number(Buffer.from(a.data).readBigUInt64LE(72));
}

export async function loadGame(conn: Connection, id: number): Promise<WarGame | null> {
  const key = gamePda(id);
  const a = await conn.getAccountInfo(key);
  return a ? decodeGame(id, key, a.data) : null;
}

/** The phase a viewer sees. */
export type Phase = "open" | "live" | "ending" | "expired" | "settled";
export function phase(g: WarGame, now = Math.floor(Date.now() / 1000)): Phase {
  if (g.over) return "settled";
  if (g.deadline === 0) return "open"; // waiting for a challenger: the clock starts on the second bid
  if (now >= g.deadline) return "expired";
  return g.deadline - now <= Math.max(g.antiSnipeSecs, 60) ? "ending" : "live";
}
/** Smallest bid the program accepts now: above the last bid and at least the game's minimum. */
export const minNextBid = (g: WarGame) => (g.lastBid + 1n > g.minBid ? g.lastBid + 1n : g.minBid);
export function dividendOwed(g: WarGame, keys: number, lastX18: bigint) {
  return g.divPerKeyX18 > lastX18 ? (BigInt(keys) * (g.divPerKeyX18 - lastX18)) / 10n ** 18n : 0n;
}
export async function loadPlayer(conn: Connection, g: WarGame, wallet: PublicKey) {
  const a = await conn.getAccountInfo(playerPda(g.key, wallet));
  if (!a) return { keys: 0, owed: 0n };
  const d = Buffer.from(a.data);
  const keys = d.readUInt32LE(8);
  return { keys, owed: dividendOwed(g, keys, u128(d, 12)) };
}

// ---------------------------------------------------------------- instructions
const meta = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({ pubkey, isWritable, isSigner });
const ix = (name: keyof typeof DISC, keys: ReturnType<typeof meta>[], args: Buffer = Buffer.alloc(0)) =>
  new TransactionInstruction({ programId: WAR_PROGRAM, keys, data: Buffer.concat([Buffer.from(DISC[name]), args]) });
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const i64 = (v: number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return b;
};
const u16 = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const optKey = (k: PublicKey | null) => (k ? Buffer.concat([Buffer.from([1]), k.toBuffer()]) : Buffer.from([0]));

// a mint's token program and decimals never change: read each once per instance
const mintInfo = new Map<string, Promise<{ program: PublicKey; decimals: number }>>();
function mintOf(conn: Connection, mint: PublicKey) {
  const k = mint.toBase58();
  let p = mintInfo.get(k);
  if (!p) {
    p = conn.getAccountInfo(mint).then((a) => {
      if (!a) throw new Error("mint not found");
      return { program: a.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID, decimals: a.data[44] };
    });
    p.catch(() => mintInfo.delete(k));
    mintInfo.set(k, p);
  }
  return p;
}
/** A mint created in the same transaction can't be read yet: tell the cache what it will be. */
export function knownMint(mint: PublicKey, program: PublicKey, decimals: number) {
  mintInfo.set(mint.toBase58(), Promise.resolve({ program, decimals }));
}
export async function tokenProgramOf(conn: Connection, mint: PublicKey) {
  return (await mintOf(conn, mint)).program;
}
async function mintDecimals(conn: Connection, mint: PublicKey) {
  return (await mintOf(conn, mint)).decimals;
}

export type CreateParams = {
  roundSecs: number; // 60 .. 86400
  antiSnipeSecs: number;
  antiSnipeExtendSecs: number;
  minBid: bigint; // raw units
  pct?: { winner: number; dev: number; creator: number; referrer: number }; // bps, sum 10000, winner >= 5000
  mint?: PublicKey | null; // null/undefined = a SOL game
};
export async function createGameIxs(conn: Connection, creator: PublicKey, p: CreateParams, reservedId?: number) {
  // A batch reserves consecutive factory IDs once, then creates them in transaction order.
  const id = reservedId ?? await nextGameId(conn);
  const game = gamePda(id);
  const pct = p.pct ?? { winner: 7000, dev: 500, creator: 1500, referrer: 1000 };
  const decimals = p.mint ? await mintDecimals(conn, p.mint) : 9;
  const args = Buffer.concat([
    i64(p.roundSecs), i64(p.antiSnipeSecs), i64(p.antiSnipeExtendSecs), u64(p.minBid),
    u16(pct.winner), u16(pct.dev), u16(pct.creator), u16(pct.referrer),
    Buffer.from([p.mint ? 1 : 0]), optKey(p.mint ?? null), Buffer.from([decimals]),
  ]);
  return { id, game, ixs: [ix("create_game", [meta(factoryPda(), true), meta(game, true), meta(creator, true, true), meta(SystemProgram.programId, false)], args)] };
}

export async function bidIxs(conn: Connection, g: WarGame, bidder: PublicKey, amount: bigint, team: Team, referrer: PublicKey | null) {
  const ref = referrer && !referrer.equals(bidder) ? referrer : null;
  const args = Buffer.concat([u64(amount), Buffer.from([team]), optKey(ref)]);
  const player = playerPda(g.key, bidder);
  if (!g.isToken) return [ix("bid_sol", [meta(g.key, true), meta(player, true), meta(bidder, true, true), meta(SystemProgram.programId, false)], args)];
  const mint = g.mint!;
  const tp = await tokenProgramOf(conn, mint);
  const bidderAta = getAssociatedTokenAddressSync(mint, bidder, false, tp);
  const vault = getAssociatedTokenAddressSync(mint, g.key, true, tp);
  return [
    createAssociatedTokenAccountIdempotentInstruction(bidder, vault, g.key, mint, tp, ASSOCIATED_TOKEN_PROGRAM_ID),
    ix("bid_token", [meta(g.key, true), meta(player, true), meta(bidder, true, true), meta(bidderAta, true), meta(vault, true), meta(mint, false), meta(tp, false), meta(SystemProgram.programId, false)], args),
  ];
}

/** Settle an expired round: mark it claimable, then route the pot. Anyone can send it; the caller only pays fees (and, for
 *  token games, any recipient token accounts that don't exist yet). */
export async function settleIxs(conn: Connection, g: WarGame, caller: PublicKey) {
  const out = [ix("claim", [meta(g.key, true), meta(caller, false, true)])];
  const referrer = g.lastReferrer ?? g.dev;
  if (!g.isToken) {
    out.push(ix("distribute_sol_pot", [meta(g.key, true), meta(g.lastBidder, true), meta(g.dev, true), meta(g.creator, true), meta(referrer, true), meta(caller, false, true)]));
    return out;
  }
  const mint = g.mint!;
  const tp = await tokenProgramOf(conn, mint);
  const ata = (o: PublicKey) => getAssociatedTokenAddressSync(mint, o, true, tp);
  const owners = [g.lastBidder, g.dev, g.creator, referrer];
  const seen = new Set<string>();
  const create = owners.filter((o) => !seen.has(o.toBase58()) && seen.add(o.toBase58())).map((o) => createAssociatedTokenAccountIdempotentInstruction(caller, ata(o), o, mint, tp, ASSOCIATED_TOKEN_PROGRAM_ID));
  return [
    ...create,
    out[0],
    ix("distribute_token_pot", [meta(g.key, true), meta(ata(g.key), true), meta(ata(g.lastBidder), true), meta(ata(g.dev), true), meta(ata(g.creator), true), meta(ata(referrer), true), meta(mint, false), meta(tp, false), meta(caller, false, true)]),
  ];
}

export async function claimDividendIxs(conn: Connection, g: WarGame, claimer: PublicKey) {
  const player = playerPda(g.key, claimer);
  if (!g.isToken) return [ix("claim_dividend_sol", [meta(g.key, true), meta(player, true), meta(claimer, true, true)])];
  const mint = g.mint!;
  const tp = await tokenProgramOf(conn, mint);
  const mine = getAssociatedTokenAddressSync(mint, claimer, false, tp);
  return [
    createAssociatedTokenAccountIdempotentInstruction(claimer, mine, claimer, mint, tp, ASSOCIATED_TOKEN_PROGRAM_ID),
    ix("claim_dividend_token", [meta(g.key, true), meta(player, true), meta(claimer, true, true), meta(getAssociatedTokenAddressSync(mint, g.key, true, tp), true), meta(mine, true), meta(mint, false), meta(tp, false)]),
  ];
}

// ---------------------------------------------------------------- the social layer: scenario + share links
/** What a share link is about. The card and the crawler meta are picked from it; `v` changes whenever the game's state does,
 *  so X never shows a stale card for a new post. */
export type Scenario = "live" | "lead" | "open" | "won" | "divs";
export const stateTag = (g: WarGame) => `${g.totalBids}-${g.deadline}-${g.over ? 1 : 0}`;
export function warShareUrl(origin: string, g: WarGame, sc: Scenario, by: PublicKey | null) {
  const u = new URL(`/w/${g.id}`, origin);
  u.searchParams.set("sc", sc);
  if (by) u.searchParams.set("ref", by.toBase58());
  u.searchParams.set("v", stateTag(g));
  return u.toString();
}

/** "Start the next war": settle `prev` if its clock ran out, open a new game with the same rules, and place its opening bid,
 *  all in one transaction. Whoever sends it is the new game's creator (its creator cut), so rounds chain without a bot. */
export async function nextWarIxs(conn: Connection, prev: WarGame, caller: PublicKey, team: Team, referrer: PublicKey | null, now = Math.floor(Date.now() / 1000)) {
  const out: TransactionInstruction[] = [];
  if (!prev.over && prev.deadline > 0 && now >= prev.deadline) out.push(...(await settleIxs(conn, prev, caller)));
  const created = await createGameIxs(conn, caller, {
    roundSecs: prev.roundSecs, antiSnipeSecs: prev.antiSnipeSecs, antiSnipeExtendSecs: prev.antiSnipeExtendSecs, minBid: prev.minBid,
    pct: { ...prev.pct, dev: prev.pct.dev }, mint: prev.mint,
  });
  out.push(...created.ixs);
  const fresh = { ...prev, id: created.id, key: created.game, over: false, deadline: 0, totalBids: 0, lastBid: 0n, pot: 0n, lastReferrer: null } as WarGame;
  out.push(...(await bidIxs(conn, fresh, caller, prev.minBid, team, referrer)));
  return { id: created.id, game: created.game, ixs: out };
}

/** Teams are cosmetic, so nobody picks one: a wallet always lands on the same team, from its address. */
export const autoTeam = (wallet: PublicKey | string): Team => {
  const b = typeof wallet === "string" ? new PublicKey(wallet).toBytes() : wallet.toBytes();
  return (b.reduce((a, x) => a + x, 0) % 3) as Team;
};

/** A tap on this link inside X opens Phantom itself, straight onto `url` in its browser (a universal link, so no website hop). */
export const phantomLink = (url: string, site = "https://lastbidwins.fun") => `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(site)}`;

/** Where a player lands on X after a move: `app` opens the X app itself (its own scheme; an x.com link only loads X's
 *  website when it's opened from inside a wallet's browser), `web` is the intent page as the fallback. */
export function xCompose(text: string, url: string, thread: string | null, quote = false) {
  const body = quote && thread ? `${text}\n${url}\nhttps://x.com/lastbidwins/status/${thread}` : `${text}\n${url}`;
  const app = `twitter://post?message=${encodeURIComponent(body)}${thread && !quote ? `&in_reply_to_status_id=${thread}` : ""}`;
  const w = new URL("https://x.com/intent/post");
  if (quote && thread) w.searchParams.set("text", body);
  else {
    w.searchParams.set("text", text);
    w.searchParams.set("url", url);
    if (thread) w.searchParams.set("in_reply_to", thread);
  }
  return { app, web: w.toString() };
}

/** Measured on chain (one simulated bid per team): the share of a bid that goes into the pot; the rest goes to the keys
 *  that existed before it. Bull 90/10, Snek 95/5, Bear 85/15. A war's first bid has no keys to pay, so it lands whole. */
export const POT_SHARE_BPS: Record<number, bigint> = { 0: 9_000n, 1: 9_500n, 2: 8_500n };
export const potShare = (team: number) => POT_SHARE_BPS[team] ?? 9_000n;
/** If `bid` (raw) turns out to be the last bid: what it wins (winner's cut of the pot after it lands) and the multiple. */
export function payoff(g: Pick<WarGame, "pot" | "pct">, bid: bigint, team = 0) {
  const win = ((g.pot + (bid * potShare(team)) / 10_000n) * BigInt(g.pct.winner)) / 10_000n;
  return { win, multiple: bid > 0n ? Number(win) / Number(bid) : 0 };
}
