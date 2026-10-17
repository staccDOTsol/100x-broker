import assert from "node:assert/strict";
import test from "node:test";
import { getThread, getThreadPreview, setThread } from "./warthread.js";

const record = { tweetId: "1234", at: 1, by: "lastbidwins" };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

test("optional thread metadata is cached, coalesced and bounded independently of authoritative announcement reads", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = "test-only";
  try {
    await t.test("coalesces a cold lookup and serves a successful preview from memory", async () => {
      let calls = 0;
      let release!: (r: Response) => void;
      globalThis.fetch = async () => {
        calls++;
        return calls === 1 ? new Promise<Response>((resolve) => { release = resolve; }) : json(record);
      };
      const first = getThreadPreview(9_000_001);
      const second = getThreadPreview(9_000_001);
      assert.equal(first, second);
      release(json({ blobs: [{ pathname: "war/thread/9000001.json", url: "https://example.test/thread", uploadedAt: "2026-01-01" }] }));
      assert.deepEqual(await first, record);
      assert.deepEqual(await getThreadPreview(9_000_001), record);
      assert.equal(calls, 2);
    });
    await t.test("a missing thread is briefly cached", async () => {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return json({ blobs: [] }); };
      assert.equal(await getThreadPreview(9_000_002), null);
      assert.equal(await getThreadPreview(9_000_002), null);
      assert.equal(calls, 1);
    });
    await t.test("a stalled Blob read is aborted after the short preview budget", async () => {
      let aborted = false;
      globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
      });
      const start = Date.now();
      assert.equal(await getThreadPreview(9_000_003), null);
      assert.equal(aborted, true);
      assert.ok(Date.now() - start < 1_000);
    });
    await t.test("publishing a thread warms its preview without another Blob read", async () => {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return json({}); };
      await setThread(9_000_004, record);
      assert.deepEqual(await getThreadPreview(9_000_004), record);
      assert.equal(calls, 2);
    });
    await t.test("announcement lookup stays fresh even after a cached miss", async () => {
      globalThis.fetch = async () => json({ blobs: [] });
      assert.equal(await getThreadPreview(9_000_005), null);
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return calls === 1 ? json({ blobs: [{ pathname: "war/thread/9000005.json", url: "https://example.test/thread", uploadedAt: "2026-01-01" }] }) : json(record);
      };
      assert.deepEqual(await getThread(9_000_005), record);
      assert.equal(calls, 2);
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = originalToken;
  }
});
