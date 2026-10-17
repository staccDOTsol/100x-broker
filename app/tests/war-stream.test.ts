import assert from "node:assert/strict";
import test from "node:test";
import { subscribeWarAccounts, WAR_WS_ENDPOINTS, type WarAccountUpdate, type WarStreamSocket, type WarStreamStatus } from "../src/lib/war-stream.ts";

const PROGRAM = "Hbu4EByGc17GxHYyiazxDMvtL6VvKxV4aRsZW95uzfu7";
class Socket extends EventTarget {
  readyState = 0;
  sent: { id: number; method: string; params: unknown[] }[] = [];
  closed = 0;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed++; this.readyState = 3; }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: typeof data === "string" ? data : JSON.stringify(data) })); }
  ack(subscription = 7) { this.message({ jsonrpc: "2.0", id: this.sent[0].id, result: subscription }); }
  update(slot: number, data = "AQID", pubkey = "game-account", subscription = 7) {
    this.message({ jsonrpc: "2.0", method: "programNotification", params: { subscription,
      result: { context: { slot }, value: { pubkey, account: { owner: PROGRAM, data: [data, "base64"] } } },
    } });
  }
}

function fixture() {
  let nextTimer = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const sockets: Socket[] = [];
  const urls: string[] = [];
  const accounts: WarAccountUpdate[] = [];
  const statuses: WarStreamStatus[] = [];
  const unsubscribe = subscribeWarAccounts({ program: PROGRAM, onAccount: (a) => accounts.push(a), onStatus: (s) => statuses.push(s) }, {
    createSocket: (url) => { urls.push(url); const socket = new Socket(); sockets.push(socket); return socket as unknown as WarStreamSocket; },
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimer: (id) => { timers.delete(id as number); }, random: () => 0.5,
  });
  function runTimer(delay: number) {
    const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `expected a ${delay}ms timer`);
    timers.delete(entry[0]);
    entry[1].callback();
  }
  return { sockets, urls, accounts, statuses, timers, unsubscribe, runTimer };
}

test("subscribes to real Solana game notifications and becomes live only after the ACK", () => {
  const f = fixture(), socket = f.sockets[0];
  assert.deepEqual(f.statuses, ["connecting"]);
  assert.equal(f.urls[0], WAR_WS_ENDPOINTS[0]);
  socket.open();
  assert.deepEqual(socket.sent[0], { jsonrpc: "2.0", id: 1, method: "programSubscribe", params: [PROGRAM, {
    encoding: "base64", commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: "5aNQXizG8jB" } }],
  }] });
  socket.update(10);
  assert.equal(f.accounts.length, 0);
  socket.ack();
  assert.deepEqual(f.statuses, ["connecting", "live"]);
  socket.update(10);
  assert.deepEqual(f.accounts, [{ pubkey: "game-account", slot: 10, data: "AQID" }]);
  f.unsubscribe();
});

test("deduplicates per account and drops older slots while preserving distinct changes in the same slot", () => {
  const f = fixture(), socket = f.sockets[0];
  socket.open(); socket.ack();
  socket.update(10); socket.update(10); socket.update(9, "BAUG");
  socket.update(10, "BAUG"); socket.update(10); socket.update(9, "BwgJ", "other-account"); socket.update(11);
  assert.deepEqual(f.accounts.map(({ pubkey, slot, data }) => [pubkey, slot, data]), [
    ["game-account", 10, "AQID"], ["game-account", 10, "BAUG"], ["other-account", 9, "BwgJ"], ["game-account", 11, "AQID"],
  ]);
  f.unsubscribe();
});

test("JSON-RPC subscription errors fail over to the next WebSocket endpoint", () => {
  const f = fixture(), socket = f.sockets[0];
  socket.open();
  socket.message({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "programSubscribe disabled" } });
  assert.equal(socket.closed, 1);
  assert.equal(f.statuses.at(-1), "reconnecting");
  f.runTimer(500);
  assert.equal(f.urls[1], WAR_WS_ENDPOINTS[1]);
  f.sockets[1].open(); f.sockets[1].ack();
  assert.equal(f.statuses.at(-1), "live");
  f.unsubscribe();
});

test("socket errors and close events share one retry and back off after trying both endpoints", () => {
  const f = fixture();
  f.sockets[0].dispatchEvent(new Event("error"));
  f.sockets[0].dispatchEvent(new Event("close"));
  assert.equal(f.timers.size, 1);
  f.runTimer(500);
  f.sockets[1].dispatchEvent(new Event("close"));
  assert.equal(f.statuses.at(-1), "offline");
  f.runTimer(500);
  assert.equal(f.urls[2], WAR_WS_ENDPOINTS[0]);
  f.sockets[2].dispatchEvent(new Event("close"));
  f.runTimer(1_000);
  assert.equal(f.sockets.length, 4);
  f.unsubscribe();
});

test("an unacknowledged subscription times out instead of waiting forever", () => {
  const f = fixture();
  f.sockets[0].open();
  f.runTimer(12_000);
  assert.equal(f.sockets[0].closed, 1);
  f.runTimer(500);
  assert.equal(f.sockets.length, 2);
  f.unsubscribe();
});

test("reconnecting keeps account watermarks and ignores late events from the old socket", () => {
  const f = fixture(), first = f.sockets[0];
  first.open(); first.ack(); first.update(20);
  first.dispatchEvent(new Event("close"));
  first.update(99);
  f.runTimer(500);
  const second = f.sockets[1]; second.open(); second.ack();
  second.update(19); second.update(20); second.update(21);
  assert.deepEqual(f.accounts.map((a) => a.slot), [20, 21]);
  f.unsubscribe();
});

test("unsubscribe releases the subscription and every timer and cannot reconnect", () => {
  const f = fixture(), socket = f.sockets[0];
  socket.open(); socket.ack(0);
  f.unsubscribe(); f.unsubscribe();
  assert.deepEqual(socket.sent[1], { jsonrpc: "2.0", id: 2, method: "programUnsubscribe", params: [0] });
  assert.equal(socket.closed, 1);
  assert.equal(f.timers.size, 0);
  socket.update(30, "AQID", "game-account", 0); socket.dispatchEvent(new Event("error"));
  assert.equal(f.accounts.length, 0);
  assert.equal(f.timers.size, 0);
});

test("unsubscribe during connection or a scheduled retry closes and cancels immediately", () => {
  const connecting = fixture(); connecting.unsubscribe();
  assert.equal(connecting.sockets[0].closed, 1);
  assert.equal(connecting.timers.size, 0);
  const retrying = fixture(); retrying.sockets[0].dispatchEvent(new Event("error")); retrying.unsubscribe();
  assert.equal(retrying.timers.size, 0);
});

test("malformed JSON, unrelated subscriptions, wrong owners and invalid slots never reach the game store", () => {
  const f = fixture(), socket = f.sockets[0];
  socket.open(); socket.ack();
  socket.message("not JSON"); socket.message("null"); socket.message("[]");
  socket.update(10, "AQID", "game-account", 8); socket.update(-1); socket.update(1.5); socket.update(10, "");
  socket.message({ method: "programNotification", params: { subscription: 7,
    result: { context: { slot: 10 }, value: { pubkey: "other", account: { owner: "other-program", data: ["AQID", "base64"] } } },
  } });
  assert.equal(f.accounts.length, 0);
  assert.equal(f.statuses.at(-1), "live");
  f.unsubscribe();
});

test("invalid ACKs fail over and a stable connection resets the reconnect delay", () => {
  const f = fixture();
  f.sockets[0].open(); f.sockets[0].message({ id: 1, result: false }); f.runTimer(500);
  f.sockets[1].dispatchEvent(new Event("error")); f.runTimer(500);
  const socket = f.sockets[2]; socket.open(); socket.ack();
  f.runTimer(30_000);
  socket.dispatchEvent(new Event("close"));
  f.runTimer(500);
  assert.equal(f.sockets.length, 4);
  f.unsubscribe();
});

test("constructor failures report offline and retry through the supplied endpoints", () => {
  const statuses: WarStreamStatus[] = [], urls: string[] = [];
  let retry: (() => void) | undefined;
  const unsubscribe = subscribeWarAccounts({ program: PROGRAM, endpoints: ["wss://unavailable.example"], onAccount() {}, onStatus: (s) => statuses.push(s) }, {
    createSocket: (url) => { urls.push(url); throw new Error("unavailable"); },
    setTimer: (callback) => { retry = callback; return 1; }, clearTimer: () => { retry = undefined; }, random: () => 0.5,
  });
  assert.deepEqual(statuses, ["connecting", "offline"]);
  retry!();
  assert.equal(urls.length, 2);
  unsubscribe();
  assert.equal(retry, undefined);
});
