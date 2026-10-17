import assert from "node:assert/strict";
import test from "node:test";
import { packWarGroups, warBidAmounts, warBidCount, warPlayAmounts } from "./warbatch.js";

test("batch amounts preserve atomic-unit precision and reject invalid counts/amounts", () => {
  assert.deepEqual(warBidAmounts(9_007_199_254_740_993n, 3), [9_007_199_254_740_993n, 9_007_199_254_740_994n, 9_007_199_254_740_995n]);
  assert.equal(warBidCount(undefined), 1);
  for (const count of [0, 21, 1.5, NaN]) assert.throws(() => warBidCount(count));
  assert.throws(() => warBidAmounts(0n, 1));
  assert.throws(() => warBidAmounts((1n << 64n) - 1n, 2));
});

test("fork plays reserve both paid bids and advance later plays after the pair", () => {
  assert.deepEqual(warPlayAmounts(100n, ["bid", "fork", "bid", "fork"]), {
    moveAmounts: [100n, 101n, 103n, 104n], count: 6, plays: 4, lastAmount: 105n, total: 615n,
  });
  const allForks = warPlayAmounts(1n, Array(20).fill("fork"));
  assert.equal(allForks.count, 40);
  assert.equal(allForks.total, 820n);
  assert.equal(allForks.lastAmount, 40n);
  assert.deepEqual(warPlayAmounts(100n, ["start", "next", "bid"]).moveAmounts, [100n, 101n, 102n]);
});

test("the second fork bid participates in integer overflow validation", () => {
  const max = (1n << 64n) - 1n;
  assert.throws(() => warPlayAmounts(max, ["fork"]), /range/);
  assert.throws(() => warPlayAmounts(max - 2n, ["fork", "fork"]), /range/);
  assert.deepEqual(warPlayAmounts(max - 1n, ["fork"]).moveAmounts, [max - 1n]);
  assert.equal(warPlayAmounts(max - 1n, ["fork"]).lastAmount, max);
});

test("creation and both paid fork bids remain in one transaction group", async () => {
  const groups = [["previous"], ["create", "opening1", "opening2"], ["next"]];
  const txs = await packWarGroups(groups, async (items) => {
    if (items.length > 3) throw new Error("transaction too large");
    return JSON.stringify(items);
  });
  assert.deepEqual(txs.map((tx) => JSON.parse(tx)), [["previous"], ["create", "opening1", "opening2"], ["next"]]);
});

test("packing keeps swaps, openings and bids ordered and simulates only the first transaction", async () => {
  const simulated: string[][] = [];
  const groups = [["swap"], ["create", "opening"], ["bid2"], ["create2", "opening2"], ["bid3"]];
  const txs = await packWarGroups(groups, async (items, check) => {
    if (items.length > 3) throw new RangeError("encoding overruns Uint8Array");
    if (check) simulated.push([...items]);
    return JSON.stringify(items);
  });
  assert.deepEqual(txs.map((tx) => JSON.parse(tx)), [["swap", "create", "opening"], ["bid2", "create2", "opening2"], ["bid3"]]);
  assert.deepEqual(simulated, [["swap", "create", "opening"]]);
  assert.deepEqual(txs.flatMap((tx) => JSON.parse(tx)), groups.flat());
});

test("packing rejects an indivisible oversized operation and preserves simulation errors", async () => {
  await assert.rejects(packWarGroups([[1, 2]], async () => { throw new Error("transaction too large"); }), /too large/);
  await assert.rejects(packWarGroups([[1]], async (_items, check) => {
    if (check) throw new Error("insufficient funds");
    return "tx";
  }), /insufficient funds/);
});

test("twenty SOL bids use two transactions while preserving order and first-chunk simulation", async () => {
  const groups = Array.from({ length: 20 }, (_, i) => [`bid${i}`]);
  const simulated: string[][] = [];
  const txs = await packWarGroups(groups, async (items, check) => {
    if (check) simulated.push([...items]);
    return JSON.stringify(items);
  }, 20, 18);
  const chunks = txs.map((tx) => JSON.parse(tx));
  assert.deepEqual(chunks.map((items) => items.length), [18, 2]);
  assert.deepEqual(chunks.flat(), groups.flat());
  assert.deepEqual(simulated, [groups.slice(0, 18).flat()]);
});

test("compute headroom never splits a fork's creation and two opening bids", async () => {
  const groups = [...Array.from({ length: 17 }, (_, i) => [`bid${i}`]), ["create", "opening1", "opening2"], ["lastBid"]];
  const txs = await packWarGroups(groups, async (items) => JSON.stringify(items), 20, 18);
  assert.deepEqual(txs.map((tx) => JSON.parse(tx)), [groups.slice(0, 17).flat(), ["create", "opening1", "opening2", "lastBid"]]);
  await assert.rejects(packWarGroups([["create", "opening1", "opening2"]], async () => "tx", 20, 2), /atomic instruction group/);
});

test("token and swap batches retain their conservative three-group limit", async () => {
  const groups = [["swap"], ["create", "opening1", "opening2"], ["bid3"], ["bid4"], ["bid5"], ["bid6"]];
  const txs = await packWarGroups(groups, async (items) => JSON.stringify(items), 3);
  assert.deepEqual(txs.map((tx) => JSON.parse(tx)), [groups.slice(0, 3).flat(), groups.slice(3).flat()]);
});
