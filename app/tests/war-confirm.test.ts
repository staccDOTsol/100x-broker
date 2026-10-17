import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type SendOptions } from "@solana/web3.js";
import bs58 from "bs58";
import { createWarConfirmationSocketPool, sendWarRawWithDependencies, WarConfirmationUncertain } from "../src/lib/war-confirm.ts";

const signer = Keypair.generate();
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: PublicKey.default, lamports: 1 })] }).compileToV0Message());
tx.sign([signer]);
const raw = tx.serialize();
const signature = bs58.encode(tx.signatures[0]);
class Failed extends Error { constructor(readonly sig: string, readonly detail: unknown) { super("executed with error"); } }
class Socket extends EventTarget {
  readyState = 0;
  messages: { method: string; id: number; params: unknown[] }[] = [];
  closed = 0;
  send(data: string) { this.messages.push(JSON.parse(data)); }
  close() { this.closed++; this.readyState = 3; }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) })); }
  ack() { this.message({ jsonrpc: "2.0", id: 1, result: 77 }); }
  notify(value: unknown) { this.message({ jsonrpc: "2.0", method: "signatureNotification", params: { subscription: 77, result: { context: { slot: 55 }, value } } }); }
}
const pause = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));
const base = {
  sendRawTransaction: async () => signature,
  getSignatureStatuses: async () => ({ value: [null] }),
  makeFailure: (sig: string, error: unknown) => new Failed(sig, error),
  endpoints: ["wss://example.test"], timeoutMs: 100, subscriptionGraceMs: 10, pollMs: 2,
};

test("subscribes at processed before one broadcast and waits for execution, ignoring HTTP and receipt acknowledgements", async () => {
  const socket = new Socket();
  let sends = 0, options: SendOptions | undefined, resolved = false;
  const sent = sendWarRawWithDependencies(raw, {
    ...base, createSocket: () => socket,
    sendRawTransaction: async (bytes, opts) => {
      assert.deepEqual(bytes, raw);
      assert.equal(socket.messages[0].method, "signatureSubscribe");
      sends++; options = opts;
      return signature;
    },
  }).then((sig) => { resolved = true; return sig; });
  socket.open();
  assert.equal(sends, 0);
  assert.equal((socket.messages[0].params[1] as { commitment: string }).commitment, "processed");
  assert.equal(socket.messages[0].params[0], signature);
  socket.ack();
  assert.equal(sends, 1);
  socket.notify("receivedSignature");
  await pause(4);
  assert.equal(resolved, false);
  socket.notify({ err: null });
  assert.equal(await sent, signature);
  assert.deepEqual(options, { skipPreflight: true, maxRetries: 3, preflightCommitment: "processed" });
  assert.equal(socket.closed, 1);
  assert.equal(socket.messages.at(-1)?.method, "signatureUnsubscribe");
  await pause(3);
  assert.equal(sends, 1);
});

test("an accepted RPC send and status without execution commitment time out as uncertain with the original signature", async () => {
  let sends = 0;
  const socket = new Socket();
  const sent = sendWarRawWithDependencies(raw, {
    ...base, timeoutMs: 20, createSocket: () => socket,
    sendRawTransaction: async () => { sends++; return signature; },
    getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: undefined }] }),
  });
  socket.open(); socket.ack();
  await assert.rejects(sent, (error) => {
    assert.ok(error instanceof WarConfirmationUncertain);
    assert.equal(error.sig, signature);
    return true;
  });
  assert.equal(sends, 1);
  assert.equal(socket.closed, 1);
});

test("HTTP status at processed completes when WebSockets are unavailable", async () => {
  let sends = 0, reads = 0;
  const result = await sendWarRawWithDependencies(raw, {
    ...base, createSocket: () => { throw new Error("not available"); },
    sendRawTransaction: async () => { sends++; return signature; },
    getSignatureStatuses: async (sigs) => { assert.deepEqual(sigs, [signature]); reads++; return { value: [{ err: null, confirmationStatus: "processed" }] }; },
  });
  assert.equal(result, signature);
  assert.equal(sends, 1);
  assert.equal(reads, 1);
});

test("a processed WebSocket runtime error rejects with the on-chain failure and cleans up", async () => {
  const socket = new Socket();
  const detail = { InstructionError: [2, { Custom: 7 }] };
  const sent = sendWarRawWithDependencies(raw, { ...base, createSocket: () => socket });
  socket.open(); socket.ack(); socket.notify({ err: detail });
  await assert.rejects(sent, (error) => {
    assert.ok(error instanceof Failed);
    assert.equal(error.sig, signature);
    assert.deepEqual(error.detail, detail);
    return true;
  });
  assert.equal(socket.closed, 1);
});

test("HTTP runtime errors reject instead of advancing to the next transaction", async () => {
  const detail = { InstructionError: [0, "InsufficientFunds"] };
  await assert.rejects(sendWarRawWithDependencies(raw, {
    ...base, endpoints: [], getSignatureStatuses: async () => ({ value: [{ err: detail }] }),
  }), (error) => {
    assert.ok(error instanceof Failed);
    assert.deepEqual(error.detail, detail);
    return true;
  });
});

test("a transport send error still accepts later on-chain execution evidence without rebroadcasting", async () => {
  const socket = new Socket();
  let sends = 0;
  const sent = sendWarRawWithDependencies(raw, {
    ...base, createSocket: () => socket,
    sendRawTransaction: async () => { sends++; throw new Error("connection reset after write"); },
  });
  socket.open(); socket.ack();
  await pause();
  socket.notify({ err: null });
  assert.equal(await sent, signature);
  assert.equal(sends, 1);
});

test("unsigned bytes cannot create a subscription or broadcast", async () => {
  const unsigned = VersionedTransaction.deserialize(raw);
  unsigned.signatures[0] = new Uint8Array(64);
  let sockets = 0, sends = 0;
  await assert.rejects(sendWarRawWithDependencies(unsigned.serialize(), {
    ...base, createSocket: () => { sockets++; return new Socket(); },
    sendRawTransaction: async () => { sends++; return signature; },
  }), /signature is required/);
  assert.equal(sockets, 0);
  assert.equal(sends, 0);
});

test("a socket that never opens falls back to one HTTP broadcast after the connection grace", async () => {
  const socket = new Socket();
  let sends = 0;
  const sent = sendWarRawWithDependencies(raw, {
    ...base, createSocket: () => socket, subscriptionGraceMs: 2,
    sendRawTransaction: async () => { sends++; return signature; },
    getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
  });
  assert.equal(sends, 0);
  assert.equal(await sent, signature);
  assert.equal(sends, 1);
  assert.equal(socket.closed, 1);
});

test("the default broadcasts without waiting for a cold socket handshake", async () => {
  const socket = new Socket();
  let sends = 0;
  const sent = sendWarRawWithDependencies(raw, {
    ...base, subscriptionGraceMs: undefined, createSocket: () => socket,
    sendRawTransaction: async () => { sends++; return signature; },
  });
  await pause(3);
  assert.equal(sends, 1);
  assert.equal(socket.readyState, 0);
  socket.open(); socket.ack(); socket.notify({ err: null });
  assert.equal(await sent, signature);
  assert.equal(sends, 1);
});

test("ordered sends reuse a warm signature socket and ignore the previous subscription's late proof", async () => {
  const socket = new Socket();
  let connections = 0, sends = 0;
  const pool = createWarConfirmationSocketPool(() => { connections++; return socket; }, 20);
  const deps = {
    ...base, createSocket: (url: string) => pool.acquire(url),
    sendRawTransaction: async () => { sends++; return signature; },
  };
  try {
    const first = sendWarRawWithDependencies(raw, deps);
    socket.open(); socket.ack(); socket.notify({ err: null });
    await first;
    assert.equal(socket.closed, 0);
    const secondTx = VersionedTransaction.deserialize(raw);
    secondTx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    secondTx.sign([signer]);
    const secondSignature = bs58.encode(secondTx.signatures[0]);
    let completed = false;
    const second = sendWarRawWithDependencies(secondTx.serialize(), {
      ...deps, sendRawTransaction: async () => { sends++; return secondSignature; },
    }).then((sig) => { completed = true; return sig; });
    const request = socket.messages.filter((message) => message.method === "signatureSubscribe").at(-1)!;
    assert.equal(request.params[0], secondSignature);
    socket.message({ jsonrpc: "2.0", id: request.id, result: 88 });
    assert.equal(sends, 2);
    socket.notify({ err: null }); // Old subscription 77 must not acknowledge this send.
    await pause(3);
    assert.equal(completed, false);
    socket.message({ jsonrpc: "2.0", method: "signatureNotification", params: { subscription: 88, result: { context: { slot: 56 }, value: "receivedSignature" } } });
    await pause(3);
    assert.equal(completed, false);
    socket.message({ jsonrpc: "2.0", method: "signatureNotification", params: { subscription: 88, result: { context: { slot: 56 }, value: { err: null } } } });
    assert.equal(await second, secondSignature);
    assert.equal(connections, 1);
    assert.equal(sends, 2);
    assert.equal(socket.closed, 0);
    await pause(30);
    assert.equal(socket.closed, 1);
  } finally { pool.close(); }
});

test("a subscription acknowledged after its sender finished is unsubscribed on the warm socket", async () => {
  const socket = new Socket();
  const pool = createWarConfirmationSocketPool(() => socket, 20);
  try {
    const sent = sendWarRawWithDependencies(raw, {
      ...base, createSocket: (url) => pool.acquire(url), subscriptionGraceMs: 0,
      getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "processed" }] }),
    });
    socket.open();
    const request = socket.messages[0];
    assert.equal(await sent, signature);
    socket.message({ jsonrpc: "2.0", id: request.id, result: 99 });
    assert.deepEqual(socket.messages.at(-1)?.params, [99]);
    assert.equal(socket.messages.at(-1)?.method, "signatureUnsubscribe");
    assert.equal(socket.closed, 0);
  } finally { pool.close(); }
});
