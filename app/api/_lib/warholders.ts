// Keyholders of one war, rebuilt from its own transactions: who bid what, in order. Every bid mints one key and puts 90% in
// the pot and 10% across the keys that existed before it (measured on chain), so replaying the bids gives each holder's exact
// dividends to date, whatever they've claimed. Cached per game; each call only fetches signatures it hasn't seen.
import { PublicKey, type Connection } from "@solana/web3.js";
import { WAR_PROGRAM, potShare, type WarGame } from "../../src/lib/war.js";

const BID_SOL = Buffer.from([111, 148, 12, 118, 216, 85, 109, 76]);
const BID_TOKEN = Buffer.from([112, 27, 251, 177, 231, 26, 102, 195]);
type Bid = { sig: string; slot: number; bidder: string; amount: bigint; team: number };
// what the settle transaction actually paid each owner (token or lamport deltas), once a war is paid out
type Payout = Map<string, bigint>;
const cache = new Map<string, { bids: Bid[]; seen: Set<string>; payout?: Payout }>();

async function bidsOf(conn: Connection, game: PublicKey): Promise<{ bids: Bid[]; payout?: Payout }> {
  const k = game.toBase58();
  const c = cache.get(k) ?? { bids: [] as Bid[], seen: new Set<string>(), payout: undefined as Payout | undefined };
  // newest first: page back until a signature we already have
  const fresh: { signature: string; slot: number }[] = [];
  let before: string | undefined;
  for (let page = 0; page < 10; page++) {
    const sigs = await conn.getSignaturesForAddress(game, { before, limit: 1000 });
    const ok = sigs.filter((s) => !s.err);
    const stop = ok.findIndex((s) => c.seen.has(s.signature));
    fresh.push(...(stop >= 0 ? ok.slice(0, stop) : ok));
    if (stop >= 0 || sigs.length < 1000) break;
    before = sigs[sigs.length - 1].signature;
  }
  for (let i = 0; i < fresh.length; i += 50) {
    const chunk = fresh.slice(i, i + 50);
    // version 1: war #1086 opened in a transaction v1 (and any later launch may); reading only v0 fails the whole batch
    const txs = await conn.getTransactions(chunk.map((s) => s.signature), { maxSupportedTransactionVersion: 1 as 0, commitment: "confirmed" }); // web3.js 1.99 types still stop at 0
    txs.forEach((tx, j) => {
      c.seen.add(chunk[j].signature);
      if (!tx || tx.meta?.err) return;
      const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
      // the payout: who received what when the pot was distributed
      if ((tx.meta?.logMessages ?? []).some((l) => /Instruction: Distribute(Token|Sol)Pot/.test(l))) {
        const p: Payout = new Map();
        const pre = new Map((tx.meta?.preTokenBalances ?? []).map((b) => [`${b.accountIndex}`, BigInt(b.uiTokenAmount.amount)]));
        for (const b of tx.meta?.postTokenBalances ?? []) {
          const d = BigInt(b.uiTokenAmount.amount) - (pre.get(`${b.accountIndex}`) ?? 0n);
          if (d > 0n && b.owner) p.set(b.owner, (p.get(b.owner) ?? 0n) + d);
        }
        if (!p.size) tx.meta!.postBalances.forEach((post, i) => {
          const d = BigInt(post) - BigInt(tx.meta!.preBalances[i]);
          const who = keys.get(i)?.toBase58();
          if (d > 0n && who && who !== k) p.set(who, d);
        });
        c.payout = p;
      }
      for (const ix of tx.transaction.message.compiledInstructions) {
        if (!keys.get(ix.programIdIndex)?.equals(WAR_PROGRAM)) continue;
        const d = Buffer.from(ix.data);
        if (d.length < 16 || !(d.subarray(0, 8).equals(BID_SOL) || d.subarray(0, 8).equals(BID_TOKEN))) continue;
        if (!keys.get(ix.accountKeyIndexes[0])?.equals(game)) continue;
        c.bids.push({ sig: chunk[j].signature, slot: tx.slot, bidder: keys.get(ix.accountKeyIndexes[2])!.toBase58(), amount: d.readBigUInt64LE(8), team: d[16] ?? 0 });
      }
    });
  }
  // bids must rise, so within a slot the smaller one came first
  c.bids.sort((a, b) => (a.slot !== b.slot ? a.slot - b.slot : a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
  cache.set(k, c);
  return { bids: c.bids, payout: c.payout };
}

export type Holder = { wallet: string; keys: number; risked: bigint; earned: bigint; leader: boolean };
/** Every keyholder with what they put in and what their keys have earned so far. */
export async function holdersOf(conn: Connection, g: WarGame): Promise<{ holders: Holder[]; bids: number; finalPot: bigint; lastBid: bigint; payout?: Payout }> {
  const { bids, payout } = await bidsOf(conn, g.key);
  const SCALE = 10n ** 18n;
  let acc = 0n; // dividends per key, scaled
  let keys = 0n;
  const h = new Map<string, { keys: bigint; risked: bigint; earned: bigint; snap: bigint }>();
  for (const b of bids) {
    // this bid's keys share (by its team: Bull 10%, Snek 5%, Bear 15%) goes to the keys before it; the first bid lands whole
    if (keys > 0n) acc += (((b.amount * (10_000n - potShare(b.team))) / 10_000n) * SCALE) / keys;
    const p = h.get(b.bidder) ?? { keys: 0n, risked: 0n, earned: 0n, snap: acc };
    p.earned += (p.keys * (acc - p.snap)) / SCALE;
    p.snap = acc;
    p.keys += 1n;
    p.risked += b.amount;
    h.set(b.bidder, p);
    keys += 1n;
  }
  const leader = g.totalBids ? g.lastBidder.toBase58() : null;
  const holders = [...h.entries()].map(([wallet, p]) => ({
    wallet, keys: Number(p.keys), risked: p.risked, earned: p.earned + (p.keys * (acc - p.snap)) / SCALE, leader: wallet === leader,
  }));
  // the pot rebuilt from the bids (the first bid lands whole, every later one 90%): still right after a payout zeroes it
  const finalPot = bids.reduce((a, b, i) => a + (i === 0 ? b.amount : (b.amount * potShare(b.team)) / 10_000n), 0n);
  return { holders, bids: bids.length, finalPot, lastBid: bids.length ? bids[bids.length - 1].amount : 0n, payout };
}
