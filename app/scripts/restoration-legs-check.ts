import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { conn, type MarketView } from "../src/lib/chain.js";
import { META, resolveMetaPick } from "../src/meta.js";
import { planLegs, WSOL } from "../api/_lib/legs.js";
import { forget, memo } from "../api/_lib/memo.js";

const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const view = (mint: string, symbol: string, quote = "SOL") => ({
  acct: { key: PublicKey.unique() },
  keys: { bullMint: PublicKey.unique(), bearMint: PublicKey.unique() },
  underlyingMint: mint, ticker: symbol, oracle: { quote },
  side: [{ vault: 0n, symbol: `${symbol}UP` }, { vault: 0n, symbol: `${symbol}DN` }],
}) as unknown as MarketView;
const pump = view(PUMP, "PUMP"), stable = view(USDC, "USDC");
const nativeSol = view(WSOL, "SOL", "USDC"), wrongQuote = view(USDC, "USDC", "USDT");
const originalFetch = globalThis.fetch;
const originalRead = conn.getMultipleAccountsInfo;
globalThis.fetch = (async (url: string | URL | Request) => {
  assert(String(url).startsWith("https://lite-api.jup.ag/price/v3?"), "test must not make network calls");
  return new Response(JSON.stringify({ [WSOL]: { usdPrice: 100 }, [USDC]: { usdPrice: 1 } }));
}) as typeof fetch;
Object.assign(conn, { getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => {
  const data = Buffer.alloc(82); data[44] = 6;
  return { data };
}) });
const seed = async (views: MarketView[]) => {
  forget("views:all");
  await memo("views:all", 5_000, 30_000, async () => views);
};
const args = {
  wallet: null, build: false, badBeat: false,
  hops: [{ inputMint: WSOL, outputMint: PUMP, inAmount: "10000000", outAmount: "100000000" }],
};
try {
  await seed([pump, nativeSol]);
  const missing = await planLegs(args);
  assert.equal(missing.hops[0].short.via, "none");
  assert.equal(missing.unplaceable.length, 1, "a missing SOL half must be reported to the swap UI");
  assert.equal(missing.unplaceable[0].mint, WSOL);
  assert.match(missing.unplaceable[0].reason, /hop 1 short: no stable\/SOL market/);
  const flippedMissing = await planLegs({ ...args, badBeat: true });
  assert.match(flippedMissing.unplaceable[0].reason, /hop 1 long:/);

  await seed([pump, nativeSol, stable]);
  const restored = await planLegs(args);
  assert.deepEqual(restored.unplaceable, []);
  assert.equal(restored.hops[0].long.market, pump.acct.key.toBase58());
  assert.equal(restored.hops[0].short.market, stable.acct.key.toBase58());
  assert.equal(restored.hops[0].short.side, 0, "short SOL buys stable UP");
  assert.equal(restored.hops[0].short.via, "sol-inverse");
  assert.equal(restored.hops[0].long.lamports, "5000");
  assert.equal(restored.hops[0].short.lamports, "5000");
  const flipped = await planLegs({ ...args, badBeat: true });
  assert.equal(flipped.hops[0].long.market, stable.acct.key.toBase58());
  assert.equal(flipped.hops[0].long.side, 1, "long SOL buys stable DOWN");
  assert.equal(flipped.hops[0].short.side, 1, "bad beat shorts the purchased coin");

  const solPick = META.find((pick) => pick.ticker === "SOL")!;
  assert.equal(solPick.side, "VAULT");
  assert.equal(resolveMetaPick(solPick, [nativeSol, wrongQuote]), null, "yield must retain USDC/SOL direction");
  assert.equal(resolveMetaPick(solPick, [nativeSol, wrongQuote, stable]), stable, "SOL yield resolves its replacement sibling by actual mint and quote");
  console.log("Swap legs and SOL yield checks passed: missing halves reported, original inverse sides retained, and replacement stable/SOL pick resolved.");
} finally {
  globalThis.fetch = originalFetch;
  conn.getMultipleAccountsInfo = originalRead;
  forget("views:all");
}
