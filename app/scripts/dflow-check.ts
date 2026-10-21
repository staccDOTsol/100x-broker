// Unit validation plus opt-in, unsigned mainnet simulations against DFlow's documented TEST endpoint.
// Run: node --import tsx scripts/dflow-check.ts [--live]
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { assertDflowPair, createDflowService, DFLOW_ORDER_URL, DFLOW_SOL_MINT, DflowError, parseDflowRequest, validateDflowOrder } from "../api/_lib/dflow.js";

const owner = Keypair.generate();
const side = "55hGpaRpnePn4sFc78rx9uDYScVuUQH1mzrYiTJnpoHs";
const params = { inputMint: DFLOW_SOL_MINT, outputMint: side, amount: "1000000", slippageBps: 100, userPublicKey: owner.publicKey.toBase58() };
const request = parseDflowRequest(params, true);
const makeWire = (payer = owner.publicKey, extraSigner?: PublicKey) => new VersionedTransaction(new TransactionMessage({
  payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: extraSigner ?? payer, toPubkey: new PublicKey(side), lamports: 1 })],
}).compileToV0Message());
const wire = makeWire();
const raw = {
  inputMint: params.inputMint, outputMint: params.outputMint, inAmount: params.amount, outAmount: "1000", minOutAmount: "990", otherAmountThreshold: "990",
  slippageBps: 100, priceImpactPct: "0", platformFee: null, contextSlot: 1, executionMode: "sync", transactionVersion: "v0", lastValidBlockHeight: 2,
  prioritizationFeeLamports: 10, transaction: Buffer.from(wire.serialize()).toString("base64"),
  routePlan: [{ venue: "Dynamic Bonding Curve", marketKey: side, inputMint: params.inputMint, outputMint: side, inAmount: params.amount, outAmount: "1000", inputMintDecimals: 9, outputMintDecimals: 6 }],
};
let checks = 0;
const rejected = (fn: () => unknown, code = "DFLOW_INVALID_RESPONSE") => { assert.throws(fn, (e: unknown) => e instanceof DflowError && e.code === code); checks++; };
assert.equal(validateDflowOrder(raw, request).transaction, raw.transaction); checks++;
for (const amount of ["0", "-1", "1.5", "1e6", "01", "18446744073709551616", 1000, ["1"]]) rejected(() => parseDflowRequest({ ...params, amount }, true), "INVALID_AMOUNT");
for (const slippageBps of [0, 1001, -1, "auto", "1.2", [100]]) rejected(() => parseDflowRequest({ ...params, slippageBps }, true), "INVALID_SLIPPAGE");
rejected(() => parseDflowRequest({ ...params, userPublicKey: "invalid" }, true), "INVALID_WALLET");
rejected(() => assertDflowPair(request, new Set()), "UNSUPPORTED_PAIR");
rejected(() => assertDflowPair({ ...request, inputMint: side, outputMint: owner.publicKey.toBase58() }, new Set([side])), "UNSUPPORTED_PAIR");
assertDflowPair(request, new Set([side])); checks++;
for (const change of [
  { inputMint: side }, { outputMint: DFLOW_SOL_MINT }, { inAmount: "1000001" }, { outAmount: "0" }, { slippageBps: 101 },
  { otherAmountThreshold: "989" }, { minOutAmount: "989", otherAmountThreshold: "989" }, { minOutAmount: "1001", otherAmountThreshold: "1001" },
  { platformFee: { feeBps: 1, amount: "1" } }, { executionMode: "async" }, { transactionVersion: "v1" }, { transaction: "bad" },
  { routePlan: [] }, { contextSlot: -1 }, { lastValidBlockHeight: 0 },
  { transaction: Buffer.from(makeWire(Keypair.generate().publicKey).serialize()).toString("base64") },
  { transaction: Buffer.from(makeWire(owner.publicKey, Keypair.generate().publicKey).serialize()).toString("base64") },
]) rejected(() => validateDflowOrder({ ...raw, ...change }, request));
wire.sign([owner]);
rejected(() => validateDflowOrder({ ...raw, transaction: Buffer.from(wire.serialize()).toString("base64") }, request));

let called = false;
const disabled = createDflowService({ apiKey: () => undefined, activeSideMints: async () => { called = true; return new Set([side]); }, fetch: async () => { called = true; return new Response(); } });
assert.equal(disabled.configured(), false);
await assert.rejects(disabled.order(params, true), (e: unknown) => e instanceof DflowError && e.code === "DFLOW_NOT_CONFIGURED");
assert.equal(called, false); checks++;
const service = createDflowService({ apiKey: () => "test-key-never-log", activeSideMints: async () => new Set([side]), fetch: async (url, init) => {
  const u = new URL(String(url));
  assert.equal(u.origin + u.pathname, DFLOW_ORDER_URL);
  assert.equal(u.searchParams.get("allowAsyncExec"), "false");
  assert.equal(u.searchParams.get("transactionVersion"), "v0");
  assert.equal(u.searchParams.has("platformFeeBps"), false);
  assert.equal((init?.headers as Record<string, string>)["x-api-key"], "test-key-never-log");
  return Response.json(raw);
} });
await service.order(params, true); checks++;
for (const [status, code] of [[403, "DFLOW_ACCESS_UNAVAILABLE"], [429, "DFLOW_RATE_LIMITED"], [500, "DFLOW_NO_ROUTE"]] as const) {
  const broken = createDflowService({ apiKey: () => "hidden", activeSideMints: async () => new Set([side]), fetch: async () => new Response("sensitive upstream details", { status }) });
  await assert.rejects(broken.order(params, true), (e: unknown) => e instanceof DflowError && e.code === code && !e.message.includes("sensitive")); checks++;
}
console.log(JSON.stringify({ validationChecks: checks, passed: true }));

if (process.argv.includes("--live")) {
  const views = (await (await fetch("https://100x.broker/api/markets")).json()).markets;
  const mints = new Set<string>(views.flatMap((v: any) => [v.acct.bullMint.$p, v.acct.bearMint.$p]));
  const live = createDflowService({
    apiKey: () => "test-transport-only",
    activeSideMints: async () => mints,
    fetch: async (url, init) => {
      const u = new URL(String(url));
      assert.equal(u.origin + u.pathname, DFLOW_ORDER_URL);
      u.hostname = "dev-quote-api.dflow.net";
      return fetch(u, { ...init, headers: { accept: "application/json" } });
    },
  });
  const payer = "331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth";
  const hook = "37N7DexkZCdWDSLjqWrv6eSsDBKQNkg1P8ogHqKoV7XP";
  const rows: unknown[] = [];
  for (const v of views) for (const [label, key] of [["UP", "bullMint"], ["DOWN", "bearMint"]]) {
    const mint = v.acct[key].$p;
    const directions = v.acct.key.$p === "62xXL74phR5tyfyu4xW5XZUckBzDXFpWeP3nVmYk8bt1" ? ["buy", "sell"] : ["buy"];
    for (const direction of directions) {
      const buy = direction === "buy";
      const quoteParams = { inputMint: buy ? DFLOW_SOL_MINT : mint, outputMint: buy ? mint : DFLOW_SOL_MINT, amount: buy ? "1000000" : "1000000000", slippageBps: 100, userPublicKey: payer };
      const quote = await live.order(quoteParams, false);
      const built = await live.order(quoteParams, true);
      const rpc = await (await fetch("https://100x.broker/api/rpc", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "simulateTransaction", params: [built.transaction, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }] }),
      })).json();
      const value = rpc.result?.value;
      assert.ok(value, "simulation must return a result");
      const hookInvoked = value.logs?.some((line: string) => line.includes(`Program ${hook} invoke`));
      const hookSuccess = value.logs?.some((line: string) => line === `Program ${hook} success`);
      const row = { market: v.acct.key.$p, symbol: v.side[label === "UP" ? 0 : 1]?.symbol, side: label, direction, ...quoteParams, quoteOut: quote.outAmount, transactionOut: built.outAmount, minOut: built.minOutAmount, route: built.routePlan, transaction: built.transaction, contextSlot: rpc.result.context.slot, error: value.err, hookInvoked, hookSuccess, unitsConsumed: value.unitsConsumed, signed: false, submitted: false };
      rows.push(row);
      console.log(JSON.stringify({ market: v.acct.key.$p, side: label, direction, error: value.err, hookInvoked, hookSuccess }));
      assert.equal(value.err, null);
      assert.equal(hookInvoked, true);
      assert.equal(hookSuccess, true);
    }
  }
  const dir = "/Users/stacc/tmp/100x-rebirth-2026-10-20";
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/dflow-simulation-evidence.json`, JSON.stringify({ at: new Date().toISOString(), endpoint: "https://dev-quote-api.dflow.net", network: "mainnet-beta", note: "Unsigned read-only simulations. No trades submitted.", rows }, null, 2) + "\n");
  console.log(JSON.stringify({ liveSimulations: rows.length, passed: true, evidence: `${dir}/dflow-simulation-evidence.json` }));
}
