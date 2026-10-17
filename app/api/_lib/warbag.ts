// A wallet's keys across every Stars War game: how many, and what each game owes it in dividends. Player records carry no
// wallet field, so they can't be filtered on chain; instead every game is read (cached a minute) and the wallet's player PDA
// derived for each, both in getMultipleAccounts batches of 100.
import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeGame, dividendOwed, gamePda, nextGameId, playerPda, type WarGame } from "../../src/lib/war.js";

let gamesCache: { at: number; next: number; games: WarGame[] } | null = null;
let gamesLoading: Promise<WarGame[]> | null = null;
export async function allGames(conn: Connection): Promise<WarGame[]> {
  if (gamesLoading) return gamesLoading;
  const load = async () => {
    const next = await nextGameId(conn);
    const cached = gamesCache && Date.now() - gamesCache.at < 60_000 && gamesCache.next <= next ? gamesCache : null;
    if (cached?.next === next) return cached.games;
    // A cached index must still discover newly created games immediately after a fork.
    const start = cached?.next ?? 0;
    const ids = Array.from({ length: next - start }, (_, i) => start + i);
    const games: WarGame[] = [...(cached?.games ?? [])];
    const batches = [];
    for (let i = 0; i < ids.length; i += 100) batches.push(ids.slice(i, i + 100));
    const infos = await Promise.all(batches.map((b) => conn.getMultipleAccountsInfo(b.map((id) => gamePda(id)))));
    batches.forEach((b, bi) => b.forEach((id, j) => {
      const a = infos[bi][j];
      if (a) {
        try {
          games.push(decodeGame(id, gamePda(id), a.data));
        } catch {
          /* not a game record */
        }
      }
    }));
    gamesCache = { at: cached?.at ?? Date.now(), next, games };
    return games;
  };
  gamesLoading = load();
  try {
    return await gamesLoading;
  } finally {
    gamesLoading = null;
  }
}

export type BagRow = { game: WarGame; keys: number; owed: bigint };
/** Every game where `wallet` holds keys, with what each owes it right now. */
export async function bagOf(conn: Connection, wallet: PublicKey, mint?: string | null): Promise<BagRow[]> {
  const games = (await allGames(conn)).filter((g) => mint === undefined || (g.mint?.toBase58() ?? null) === mint);
  const rows: BagRow[] = [];
  const batches: WarGame[][] = [];
  for (let i = 0; i < games.length; i += 100) batches.push(games.slice(i, i + 100));
  const infos = await Promise.all(batches.map((b) => conn.getMultipleAccountsInfo(b.map((g) => playerPda(g.key, wallet)))));
  batches.forEach((b, bi) => b.forEach((g, j) => {
    const a = infos[bi][j];
    if (!a) return;
    const d = Buffer.from(a.data);
    const keys = d.readUInt32LE(8);
    const last = d.readBigUInt64LE(12) + (d.readBigUInt64LE(20) << 64n);
    if (keys > 0) rows.push({ game: g, keys, owed: dividendOwed(g, keys, last), last } as BagRow & { last: bigint });
  }));
  // the game list is a minute old; re-read just these games so what's owed is exact
  const freshBatches = [];
  for (let i = 0; i < rows.length; i += 100) freshBatches.push(rows.slice(i, i + 100));
  const fresh = (await Promise.all(freshBatches.map((batch) => conn.getMultipleAccountsInfo(batch.map((r) => r.game.key))))).flat();
  return rows.map((r, i) => {
    const a = fresh[i];
    if (!a) return r;
    const g = decodeGame(r.game.id, r.game.key, a.data);
    return { game: g, keys: r.keys, owed: dividendOwed(g, r.keys, (r as BagRow & { last: bigint }).last) };
  });
}
