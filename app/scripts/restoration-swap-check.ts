// Local safety checks, plus an optional read-only quote from the live router. Never builds or submits a transaction.
import assert from "node:assert/strict";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import handler from "../api/swap.js";
import { COMPOSER_PROGRAM_ID, LIQUIDITY_ROUTER_URL } from "../src/config.js";

const response = () => ({
  statusCode: 200, body: null as any,
  setHeader() { return this; },
  status(code: number) { this.statusCode = code; return this; },
  json(body: unknown) { this.body = body; return this; },
});
const query = {
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: "10000000", slippageBps: "50",
};
const oldQuote = { composed: true, composerProgramId: "2qiAsxua4dx5SPRD1CDXeNAKDKRepDQ1rags3vAoZ5fN", outAmount: "1", routePlan: [] };
const originalFetch = globalThis.fetch;
try {
  let fetchCount = 0;
  globalThis.fetch = async (input) => {
    fetchCount++;
    assert(String(input).startsWith(`${LIQUIDITY_ROUTER_URL}/api/quote/solana?`));
    return Response.json(oldQuote);
  };
  const get = response();
  await handler({ method: "GET", query } as unknown as VercelRequest, get as unknown as VercelResponse);
  assert.equal(get.statusCode, 503, "closed Composer quotes cannot be advertised under the replacement ID");
  assert.match(get.body.error, /previous Composer/);
  const post = response();
  await handler({ method: "POST", body: { userPublicKey: query.inputMint, quoteResponse: oldQuote } } as VercelRequest, post as unknown as VercelResponse);
  assert.equal(post.statusCode, 409, "stale quotes are refused before building a transaction");
  assert.equal(fetchCount, 1, "rejected POST must not reach the router");
} finally {
  globalThis.fetch = originalFetch;
}
console.log("Swap restoration checks passed: working service hostname, mismatched quote refusal, and stale build refusal.");
if (process.argv.includes("--live")) {
  const get = response();
  await handler({ method: "GET", query } as unknown as VercelRequest, get as unknown as VercelResponse);
  assert([200, 503].includes(get.statusCode), JSON.stringify(get.body));
  if (get.statusCode === 200) {
    assert.equal(get.body.program, COMPOSER_PROGRAM_ID.toBase58());
    assert.equal(get.body.quote.composerProgramId, COMPOSER_PROGRAM_ID.toBase58());
  } else assert.match(get.body.error, /previous Composer/);
  console.log(JSON.stringify({ at: new Date().toISOString(), router: LIQUIDITY_ROUTER_URL, status: get.statusCode, body: get.body }, null, 2));
}
