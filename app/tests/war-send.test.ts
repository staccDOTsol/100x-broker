import assert from "node:assert/strict";
import test from "node:test";
import type { VersionedTransaction } from "@solana/web3.js";
import { signAndSendWarTransactions, WarSendError, type WarSendProgress } from "../src/lib/war-send.ts";

const tx = (id: number): VersionedTransaction => ({ serialize: () => Uint8Array.of(id) } as unknown as VersionedTransaction);
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("one signAll prompt covers the batch and each send waits for the previous confirmation", async () => {
  const first = deferred(), second = deferred();
  const started = [deferred(), deferred()];
  const calls: string[] = [];
  const progress: WarSendProgress[] = [];
  const transactions = [tx(1), tx(2)];
  const sending = signAndSendWarTransactions(transactions, {
    signAllTransactions: async (all) => { calls.push("signAll"); assert.deepEqual(all, transactions); return all; },
    signTransaction: async (one) => { calls.push("signOne"); return one; },
  }, async (raw) => {
    const index = raw[0] - 1;
    calls.push(`send${index + 1}`);
    started[index].resolve();
    await (index === 0 ? first : second).promise;
  }, (p) => progress.push(p));

  await started[0].promise;
  assert.deepEqual(calls, ["signAll", "send1"]);
  assert.deepEqual(progress.at(-1), { confirmed: 0, total: 2, submitted: true });
  first.resolve();
  await started[1].promise;
  assert.deepEqual(calls, ["signAll", "send1", "send2"]);
  assert.deepEqual(progress.at(-1), { confirmed: 1, total: 2, submitted: true });
  second.resolve();
  await sending;
  assert.deepEqual(progress.at(-1), { confirmed: 2, total: 2, submitted: true });
});

test("a failed send stops the batch and records prior confirmations plus the uncertain attempt", async () => {
  const failure = new Error("confirmation timed out");
  const calls: number[] = [];
  await assert.rejects(signAndSendWarTransactions([tx(1), tx(2), tx(3)], {
    signAllTransactions: async (all) => all,
  }, async (raw) => {
    calls.push(raw[0]);
    if (raw[0] === 2) throw failure;
  }), (error) => {
    assert.ok(error instanceof WarSendError);
    assert.equal(error.confirmed, 1);
    assert.equal(error.total, 3);
    assert.equal(error.submitted, true);
    assert.equal(error.cause, failure);
    return true;
  });
  assert.deepEqual(calls, [1, 2]);
});

test("missing batch capability rejects before a signing prompt or send", async () => {
  let prompts = 0, sends = 0;
  await assert.rejects(signAndSendWarTransactions([tx(1), tx(2)], {
    signTransaction: async (one) => { prompts++; return one; },
  }, async () => { sends++; }), (error) => {
    assert.ok(error instanceof WarSendError);
    assert.match(error.message, /signing all transactions/);
    assert.equal(error.confirmed, 0);
    assert.equal(error.total, 2);
    assert.equal(error.submitted, false);
    return true;
  });
  assert.equal(prompts, 0);
  assert.equal(sends, 0);
});

test("a partial wallet signature response sends nothing", async () => {
  let prompts = 0, sends = 0;
  await assert.rejects(signAndSendWarTransactions([tx(1), tx(2)], {
    signAllTransactions: async (all) => { prompts++; return all.slice(0, 1); },
  }, async () => { sends++; }), (error) => {
    assert.ok(error instanceof WarSendError);
    assert.match(error.message, /didn't sign every/);
    assert.equal(error.confirmed, 0);
    assert.equal(error.total, 2);
    assert.equal(error.submitted, false);
    return true;
  });
  assert.equal(prompts, 1);
  assert.equal(sends, 0);
});

test("a single transaction can use signTransaction when batch signing is unavailable", async () => {
  const calls: string[] = [];
  await signAndSendWarTransactions([tx(7)], {
    signTransaction: async (one) => { calls.push("signOne"); return one; },
  }, async (raw) => { calls.push(`send${raw[0]}`); });
  assert.deepEqual(calls, ["signOne", "send7"]);
});

test("a first-send timeout is marked submitted even with zero confirmations", async () => {
  await assert.rejects(signAndSendWarTransactions([tx(1)], {
    signAllTransactions: async (all) => all,
  }, async () => { throw new Error("timeout"); }), (error) => {
    assert.ok(error instanceof WarSendError);
    assert.equal(error.confirmed, 0);
    assert.equal(error.total, 1);
    assert.equal(error.submitted, true);
    return true;
  });
});
