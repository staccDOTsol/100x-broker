import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { createWarLiveStore } from "../src/hooks/war-live.ts";
import { decodeGame, gamePda } from "../src/lib/war.ts";
import { toWarView, type WarClientView } from "../src/lib/war-view.ts";
import type { WarAccountUpdate, WarStreamStatus } from "../src/lib/war-stream.ts";

const now = 1_800_000_000;
const tokenMint = new PublicKey("So11111111111111111111111111111111111111112");
function account(id: number, bids = 2, token = false): WarAccountUpdate {
  const b = Buffer.alloc(297);
  b.set([27, 90, 166, 125, 74, 100, 121, 18]); b.writeBigUInt64LE(BigInt(id), 8);
  b.writeBigInt64LE(600n, 80); b.writeBigInt64LE(120n, 88); b.writeBigInt64LE(30n, 96);
  b.writeBigUInt64LE(10n, 104); b.writeUInt16LE(7000, 112); b.writeUInt16LE(500, 114); b.writeUInt16LE(1500, 116); b.writeUInt16LE(1000, 118);
  b.writeBigUInt64LE(BigInt(bids * 10), token ? 128 : 120); b.writeUInt32LE(bids, 136);
  b.writeBigUInt64LE(BigInt(9 + bids), 204); b[212] = 1; b.writeBigInt64LE(BigInt(now + 600), 213);
  b.writeUInt32LE(bids, 230); b[250] = token ? 1 : 0; b[283] = token ? 6 : 9;
  b.writeUInt32LE(bids, 284);
  if (token) b.set(tokenMint.toBytes(), 251);
  return { pubkey: gamePda(id).toBase58(), slot: 100 + bids, data: b.toString("base64") };
}
function view(id: number, bids = 2, token = false): WarClientView {
  const update = account(id, bids, token);
  return toWarView(decodeGame(id, gamePda(id), Buffer.from(update.data, "base64")), {
    mint: token ? tokenMint.toBase58() : null, symbol: token ? "TOKEN" : "SOL", decimals: token ? 6 : 9, usd: token ? 2 : 100, image: null,
  }, now);
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const requests: ReturnType<typeof deferred<WarClientView[]>>[] = [];
  let callbacks!: { onAccount: (account: WarAccountUpdate) => void; onStatus: (status: WarStreamStatus) => void };
  let sockets = 0, closed = 0, timer: (() => void) | undefined;
  const store = createWarLiveStore({
    fetchGames: () => { const r = deferred<WarClientView[]>(); requests.push(r); return r.promise; },
    subscribeAccounts: (c) => { callbacks = c; sockets++; return () => { closed++; }; },
    setReconcileTimer: (callback, delay) => { assert.equal(delay, 30_000); timer = callback; return 1; },
    clearReconcileTimer: () => { timer = undefined; }, now: () => now,
  });
  return { store, requests, receive: (a: WarAccountUpdate) => callbacks.onAccount(a), status: (s: WarStreamStatus) => callbacks.onStatus(s),
    get sockets() { return sockets; }, get closed() { return closed; }, reconcile: () => timer!(), get hasTimer() { return !!timer; } };
}

test("initial HTTP snapshot cannot overwrite an account update that arrives while it loads", async () => {
  const f = fixture(), leave = f.store.subscribe(() => {});
  f.receive(account(7, 5));
  assert.equal(f.store.getSnapshot().data?.games[0].bids, 5);
  assert.equal(f.store.getSnapshot().ready, false, "one streamed account is not a complete quote snapshot");
  f.requests[0].resolve([view(7, 2)]); await flush();
  assert.equal(f.store.getSnapshot().ready, true);
  const current = f.store.getSnapshot().data!.games[0];
  assert.equal(current.bids, 5);
  assert.equal(current.lastBid.raw, "14");
  assert.equal(current.minNext.raw, "15");
  assert.equal(current.asset.usd, 100);
  assert.equal(current.pot.raw, "50");
  assert.ok(Math.abs(current.pot.usd! - 0.000005) < 1e-15);
  leave();
});

test("a newly streamed game absent from discovery is retained and gets quote metadata from its peers", async () => {
  const f = fixture(), leave = f.store.subscribe(() => {});
  f.receive(account(10, 3, true));
  let created = f.store.getSnapshot().data!.games[0];
  assert.equal(created.asset.symbol, tokenMint.toBase58().slice(0, 4));
  assert.equal(created.asset.decimals, 6);
  assert.equal(created.pot.usd, null);
  f.requests[0].resolve([view(9, 2, true)]); await flush();
  assert.equal(f.store.getSnapshot().data!.games.length, 2);
  created = f.store.getSnapshot().data!.games.find((g) => g.id === 10)!;
  assert.equal(created.asset.symbol, "TOKEN");
  assert.equal(created.pot.raw, "30");
  assert.equal(created.pot.units, 0.00003);
  assert.equal(created.pot.usd, 0.00006);
  leave();
});

test("one socket serves multiple consumers and detail enrichment cannot roll streamed state back", async () => {
  const f = fixture(), leaveOne = f.store.subscribe(() => {}), leaveTwo = f.store.subscribe(() => {});
  assert.equal(f.sockets, 1); assert.equal(f.requests.length, 1);
  f.requests[0].resolve([view(7)]); await flush();
  f.receive(account(7, 6));
  f.store.upsert({ ...view(7, 3), thread: "thread-id", featured: 7 });
  const current = f.store.getSnapshot().data!.games[0];
  assert.equal(current.bids, 6); assert.equal(current.thread, "thread-id"); assert.equal(current.featured, 7);
  leaveOne(); assert.equal(f.closed, 0); assert.equal(f.hasTimer, true);
  leaveTwo(); assert.equal(f.closed, 1); assert.equal(f.hasTimer, false);
});

test("old slots, invalid account discriminators and mismatched game PDAs are ignored", () => {
  const f = fixture(), leave = f.store.subscribe(() => {});
  f.receive(account(7, 5));
  f.receive(account(7, 2));
  f.receive({ ...account(7, 2), slot: 106 });
  f.receive({ ...account(7, 9), pubkey: gamePda(8).toBase58() });
  const bad = account(7, 9), bytes = Buffer.from(bad.data, "base64"); bytes[0] = 0;
  f.receive({ ...bad, data: bytes.toString("base64") });
  assert.equal(f.store.getSnapshot().data!.games.length, 1);
  assert.equal(f.store.getSnapshot().data!.games[0].bids, 5);
  leave();
});

test("failed or empty reconciliation keeps visible games and reconnect refreshes once", async () => {
  const f = fixture(), leave = f.store.subscribe(() => {});
  f.status("live");
  f.requests[0].resolve([view(7)]); await flush();
  assert.equal(f.requests.length, 1);
  f.reconcile(); f.requests[1].reject(new Error("RPC unavailable")); await flush();
  assert.equal(f.store.getSnapshot().error, "RPC unavailable");
  assert.equal(f.store.getSnapshot().data!.games.length, 1);
  f.status("reconnecting"); f.status("live");
  assert.equal(f.requests.length, 3);
  f.requests[2].resolve([]); await flush();
  assert.equal(f.store.getSnapshot().data!.games.length, 1);
  assert.equal(f.store.getSnapshot().error, null);
  leave();
});

test("late requests from an unmounted generation never replace the next visit", async () => {
  const f = fixture();
  f.store.subscribe(() => {})();
  const leave = f.store.subscribe(() => {});
  f.requests[0].resolve([view(7, 9)]); await flush();
  assert.equal(f.store.getSnapshot().data, undefined);
  f.requests[1].resolve([view(7, 3)]); await flush();
  assert.equal(f.store.getSnapshot().data!.games[0].bids, 3);
  leave();
});
