// Swap quote for swap.100x.broker. The route comes from the live router.
// Our take is 1 bp per hop. Another 10 bp per hop is split in half and
// put on at 100×: long the hop's output, short the hop's input. badBeat flips those two.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { allViews } from "./_lib/views.js";
import { COMPOSER_PROGRAM_ID, LIQUIDITY_ROUTER_URL } from "../src/config.js";

const ROUTER = (process.env.LIQUIDITY_ROUTER_URL ?? LIQUIDITY_ROUTER_URL).replace(/\/$/, "");
const PROGRAM = COMPOSER_PROGRAM_ID.toBase58();
const PROTOCOL_BPS = 1n;
const POSITION_BPS = 10n;
const BPS = 10_000n;

const b58 = (s: unknown) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const raw = (s: unknown) => typeof s === "string" && /^(0|[1-9][0-9]{0,38})$/.test(s);

function cut(amount: string, bps: bigint) {
  return ((BigInt(amount) * bps) / BPS).toString();
}

type HopIn = {
  swapInfo?: {
    label?: string;
    inputMint?: string;
    outputMint?: string;
    inAmount?: string;
    outAmount?: string;
    feeAmount?: string;
    feeMint?: string;
  };
  percent?: number;
};

function legs(hops: HopIn[], badBeat: boolean) {
  return hops.map((h) => {
    const info = h.swapInfo ?? {};
    const out = raw(info.outAmount) ? info.outAmount! : "0";
    const position = cut(out, POSITION_BPS);
    const half = (BigInt(position) / 2n).toString();
    const rest = (BigInt(position) - BigInt(half)).toString();
    const sold = info.inputMint ?? "";
    const bought = info.outputMint ?? "";
    return {
      label: info.label ?? "hop",
      inputMint: sold,
      outputMint: bought,
      inAmount: info.inAmount ?? "0",
      outAmount: out,
      venueFee: info.feeAmount ?? "0",
      venueFeeMint: info.feeMint ?? "",
      percent: h.percent ?? 100,
      protocol: cut(out, PROTOCOL_BPS),
      position,
      long: { mint: badBeat ? sold : bought, side: "UP", amount: half },
      short: { mint: badBeat ? bought : sold, side: "DOWN", amount: rest },
    };
  });
}

async function marketsFor(mints: string[]) {
  const views = await allViews().catch(() => []);
  const by = new Map<string, { market: string; ticker: string }>();
  for (const v of views) {
    if (!by.has(v.underlyingMint)) by.set(v.underlyingMint, { market: v.acct.key.toBase58(), ticker: v.ticker });
  }
  return mints.map((mint) => {
    const hit = by.get(mint);
    return hit
      ? { mint, market: hit.market, ticker: hit.ticker, url: `https://100x.broker/m/${hit.market}` }
      : { mint, market: null, ticker: null, url: null };
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method === "GET") {
      const inputMint = String(req.query.inputMint ?? "");
      const outputMint = String(req.query.outputMint ?? "");
      const amount = String(req.query.amount ?? "");
      const slippage = String(req.query.slippageBps ?? "50");
      const badBeat = req.query.badBeat === "1";
      if (!b58(inputMint) || !b58(outputMint) || inputMint === outputMint) return res.status(400).json({ error: "two different token mints" });
      if (!raw(amount) || amount === "0") return res.status(400).json({ error: "amount must be a positive integer in base units" });
      if (!/^\d{1,4}$/.test(slippage) || Number(slippage) > 1000) return res.status(400).json({ error: "slippage must be 0–1000 bps" });
      const q = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: String(Number(slippage)), swapMode: "ExactIn" });
      const upstream = await fetch(`${ROUTER}/api/quote/solana?${q}`, { signal: AbortSignal.timeout(20_000) });
      const quote = await upstream.json().catch(() => null);
      if (!upstream.ok || !quote || !Array.isArray(quote.routePlan)) {
        return res.status(upstream.status || 502).json({ error: quote?.error ?? "no route" });
      }
      if (quote.composed === true && quote.composerProgramId !== PROGRAM) {
        return res.status(503).json({ error: "The swap router is still using a previous Composer deployment. Swaps are temporarily unavailable." });
      }
      const hops = legs(quote.routePlan as HopIn[], badBeat);
      const mints = [...new Set(hops.flatMap((h) => [h.inputMint, h.outputMint]).filter(b58))];
      const markets = await marketsFor(mints);
      res.setHeader("cache-control", "no-store");
      return res.json({
        program: PROGRAM,
        protocolBps: Number(PROTOCOL_BPS),
        positionBps: Number(POSITION_BPS),
        badBeat,
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        otherAmountThreshold: quote.otherAmountThreshold,
        slippageBps: quote.slippageBps,
        hops,
        markets,
        quote,
      });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "GET or POST" });
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
    if (!b58(body.userPublicKey) || !body.quoteResponse) return res.status(400).json({ error: "userPublicKey and quoteResponse" });
    if (body.quoteResponse.composed === true && body.quoteResponse.composerProgramId !== PROGRAM) {
      return res.status(409).json({ error: "This quote uses a previous Composer deployment. Refresh the quote before swapping." });
    }
    const upstream = await fetch(`${ROUTER}/api/swap/solana`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userPublicKey: body.userPublicKey, wrapAndUnwrapSol: true, quoteResponse: body.quoteResponse }),
      signal: AbortSignal.timeout(30_000),
    });
    const built = await upstream.json().catch(() => null);
    if (!upstream.ok || !built?.swapTransaction) return res.status(upstream.status || 502).json({ error: built?.error ?? "router did not return a transaction" });
    res.setHeader("cache-control", "no-store");
    return res.json({
      swapTransaction: built.swapTransaction,
      lastValidBlockHeight: built.lastValidBlockHeight,
      composed: built.composed === true,
      hops: built.hops ?? null,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "swap failed" });
  }
}
