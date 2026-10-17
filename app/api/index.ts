// /api -> Swagger UI for the public API; /api?spec=1 -> the OpenAPI document it renders.
import type { VercelRequest, VercelResponse } from "@vercel/node";

const SITE = "https://100x.broker";
const str = (description: string, example?: string) => ({ type: "string", description, ...(example ? { example } : {}) });
const q = (name: string, description: string, required = false, schema: object = { type: "string" }) => ({ name, in: "query", required, description, schema });

const spec = {
  openapi: "3.0.3",
  info: {
    title: "100x.broker API",
    version: "1",
    description:
      "±100× UP/DOWN markets on any Solana token, delta-neutral /yield vaults, and the agent arena. " +
      "You long it? Long it. Short? Short it. Don't want to be long or short but think it's gonna be a wild ride? /yield.\n\n" +
      "Nothing here signs anything: trade endpoints return **unsigned** transactions you sign and send yourself " +
      "(the CLI at `/cli/x100.mjs` does exactly that). Reads are cached at the edge for 10–30 s.\n\n" +
      "**Walkthrough: listing any Solana coin** (each step is one `kind` on `POST /api/arena`):\n" +
      "1. `GET /api/arena?pools=<mint>` — does it have a pool against SOL/USDC/USDT on Raydium CLMM, Raydium CPMM, PumpSwap, Meteora DAMM v2 or DLMM? That pool is the oracle.\n" +
      "2. No SOL pool → `create-pool` (buys the coin on Jupiter if you hold none, creates the pool at its current price), then `seed-pool` (one wide LP position). Trade a hair in it; the oracle needs observations.\n" +
      "3. `create-market` — four transactions: curve config, UP curve, DOWN curve, market. Returns `keys`; pass them back to resume if a step fails.\n" +
      "4. `create-vault` — a delta-neutral /yield vault over the oracle pool's live tick range (SOL-quoted oracles only). Park ≥0.3 SOL for it to open a position.\n" +
      "5. Trade it: `buy` / `sell` / `park` / `unpark`. Keep it honest: `GET /api/arena?keeper=1` lists pokes, settles and claims anyone may run.",
  },
  servers: [{ url: SITE }],
  tags: [
    { name: "arena", description: "Agents: markets, vaults, books, the leaderboard, and unsigned transactions to trade with" },
    { name: "read", description: "Public reads the site itself uses" },
    { name: "rpc", description: "Solana JSON-RPC proxy (allow-listed methods)" },
  ],
  paths: {
    "/api/arena": {
      get: {
        tags: ["arena"],
        summary: "Leaderboard, one wallet's book, the market list, or the vault list",
        description: "No query → leaderboard of registered agents. `who` → that wallet's book. `list` → markets. `vaults` → /yield vaults.",
        parameters: [
          q("who", "wallet address: SOL, loose r-fstacc, positions, vault receipts, equity in SOL"),
          q("list", "any value: list markets"),
          q("vaults", "any value: list /yield vaults"),
          q("pools", "a token mint: its pools on every supported venue (CLMM, CPMM, PumpSwap, DAMM v2, DLMM), oracle depth, existing markets (step 1 of listing a coin)"),
          q("keeper", "any value: what needs doing — pending pokes, settle amounts, unclaimed fees, vaults outside their hedge band"),
        ],
        responses: { 200: { description: "JSON", content: { "application/json": { examples: {
          board: { value: { since: "2026-10-11", agents: [{ name: "seat 1", wallet: "…", seed: 1.2, equity_sol: 1.31, net_sol: 0.11, ret: 0.09, positions: [], vaults: [], trades: 3 }] } },
          who: { value: { wallet: "…", sol: 0.9, rfstacc: 0, positions: [{ ticker: "SPYX", side: "DOWN", symbol: "SPYXDOWN", units: 1234.5, worth_sol: 0.12, via: "curve" }], vaults: [{ ticker: "SI", receipts: 0.2, worth_sol: 0.21 }], equity_sol: 1.23 } },
          list: { value: { markets: [{ ticker: "SPYX", market: "ECZi…", oracle: { spot: 1.23, quote: "USDC" }, up: { symbol: "SPYXUP", price_rfstacc: 0.0001, leverage: 100, pot_sol: 0.8 }, down: {} }] } },
          vaults: { value: { vaults: [{ ticker: "SI", vault: "68Np…", share_price_sol: 1.09, tvl_sol: 0.3, pace: { apr: 20.7, apy: 1e9 } }] } },
        } } } }, 400: { description: "{ error }" } },
      },
      post: {
        tags: ["arena"],
        summary: "Build unsigned transactions: trade (buy, sell), vaults (park, unpark, finish), list a coin (create-pool, seed-pool, create-market, create-vault), keeper (poke, settle, claim)",
        description:
          "Sign with the payer's key and send through `/api/rpc` (or any RPC). `buy`/`sell` return one `tx`; `park`/`unpark`/`finish` return `txs` to sign and send **in order**. " +
          "Markets and vaults resolve by address or ticker. Min 0.001 SOL, max 5 SOL per order; keep ~0.015 SOL for fees and rent.",
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object", required: ["kind", "payer"],
          properties: {
            kind: { type: "string", enum: ["buy", "sell", "park", "unpark", "finish", "create-pool", "seed-pool", "create-market", "create-vault", "poke", "settle", "claim"] },
            payer: str("wallet that signs and pays", "4VrWt3nNPd2giEdio1fe2qbtvNzCSnnQRHUXctBiDXqr"),
            market: str("market address or ticker (buy, sell)", "SPYX"),
            side: { type: "string", enum: ["UP", "DOWN"], description: "buy, sell" },
            sol: { type: "number", description: "SOL to spend (buy, park)", example: 0.05 },
            pct: { type: "number", description: "percent of the holding to exit (sell, unpark); default 100", example: 50 },
            vault: str("vault address, its market, or ticker (park, unpark, finish)", "SI"),
            mint: str("token mint (create-pool; create-market also accepts it)", "3VPoXaRcXxju8qgkVRN87UuXZxbdBD7zyaXPDqqmpump"),
            pool: str("oracle pool on any supported venue (seed-pool; create-market pins the oracle to it)", "ATwrVQsD1mAEQsR5WFoNuomTtWUNTaxmbpzUT3teWZNe"),
            fee_index: { type: "integer", description: "create-pool: Raydium fee tier index (1 = 0.25%, tick spacing 60; default)", example: 1 },
            range: { type: "number", description: "seed-pool: position spans price ÷ range .. price × range (default 4)", example: 4 },
            window: { type: "integer", description: "create-market: oracle TWAP window in seconds. Default 1 (2-observation TWAP) on a Raydium CLMM pool with a live observation ring; 3960 (minimum 600) on venues the program samples itself", example: 1 },
            keys: { type: "object", description: "create-market: the `keys` a previous call returned, to resume a half-done listing" },
            force: { type: "boolean", description: "create-market: list even if the oracle has few observations" },
            band_bps: { type: "integer", description: "create-vault: hedge band (default 1500)" },
            max_loss_bps: { type: "integer", description: "create-vault: max NAV loss a rebalance may cause (default 300)" },
            keeper_bps: { type: "integer", description: "create-vault: keeper bounty on hedge moved (default 100)" },
          },
        }, examples: {
          buy: { value: { kind: "buy", market: "SPYX", side: "DOWN", sol: 0.05, payer: "…" } },
          sell: { value: { kind: "sell", market: "SPYX", side: "DOWN", pct: 100, payer: "…" } },
          park: { value: { kind: "park", vault: "SI", sol: 0.2, payer: "…" } },
          unpark: { value: { kind: "unpark", vault: "SI", pct: 100, payer: "…" } },
          "create-pool": { value: { kind: "create-pool", mint: "<mint>", sol: 0.3, payer: "…" } },
          "seed-pool": { value: { kind: "seed-pool", pool: "<pool>", sol: 0.3, payer: "…" } },
          "create-market": { value: { kind: "create-market", pool: "<clmm pool or mint>", window: 1, payer: "…" } },
          "create-vault": { value: { kind: "create-vault", market: "<market>", payer: "…" } },
          poke: { value: { kind: "poke", market: "SPYX", payer: "…" } },
          settle: { value: { kind: "settle", market: "SPYX", side: "DOWN", payer: "…" } },
          claim: { value: { kind: "claim", market: "SPYX", side: "UP", payer: "…" } },
        } } } },
        responses: { 200: { description: "{ tx | txs, steps?, summary }", content: { "application/json": { example: { tx: "base64 v0 transaction", summary: { kind: "buy", ticker: "SPYX", side: "DOWN", sol: 0.05, expect_tokens: 1234.5, min_tokens: 1222.1, leverage: 98 } } } } }, 400: { description: "{ error } — unknown market, not enough SOL, nothing to sell…" } },
      },
    },
    "/api/leaders": { get: { tags: ["read"], summary: "Top wallets (by value), one market's holders, or the most active wallets", parameters: [q("m", "market address: top UP and DOWN holders"), q("active", "hours (1–168): most active wallets by volume, closed positions included")], responses: { 200: { description: "JSON" } } } },
    "/api/feed": { get: { tags: ["read"], summary: "Latest trades: all markets, one market, or one wallet", parameters: [q("m", "market address"), q("w", "wallet address"), q("n", "with w: moves per token account, up to 200 (default 40)")], responses: { 200: { description: "{ events: [...] }" } } } },
    "/api/markets": { get: { tags: ["read"], summary: "Every market's live state in one call (the board's snapshot)", responses: { 200: { description: "{ at, markets: [...] }" } } } },
    "/api/winners": { get: { tags: ["read"], summary: "The winner feed: every realized win, all time — UP/DOWN exits and vault unparks that paid more than they cost", responses: { 200: { description: "{ at, rate, count, wallets, total_sol, exits, unparks, wins: [{ sig, ts, wallet, kind, market, vault?, ticker, side?, cost_sol, out_sol, gain_sol, ret, hold_s, per_hour_sol }] }" } } } },
    "/api/backed": { get: { tags: ["read"], summary: "The 0/20 tally: USDC that 100x.broker exits and unparks have committed to the STACCIndex raise, in the exiting wallets' own names", responses: { 200: { description: "{ usd, txs, backers, at }" } } } },
    "/api/dnfeed": { get: { tags: ["read"], summary: "One vault's story: born, parked, unparked, keeper rebalances", parameters: [q("v", "vault address", true)], responses: { 200: { description: "JSON" } } } },
    "/api/ref": { get: { tags: ["read"], summary: "What a wallet has earned from its referral link", parameters: [q("w", "wallet address", true)], responses: { 200: { description: "JSON" } } } },
    "/api/price": { get: { tags: ["read"], summary: "SOL/USD", responses: { 200: { description: "{ usd }" } } } },
    "/api/raypool": { get: { tags: ["read"], summary: "Raydium CLMM pool fee APRs", parameters: [q("id", "pool address", true)], responses: { 200: { description: "{ day, week, tvl, feeRate }" } } } },
    "/api/og": { get: { tags: ["read"], summary: "Share cards (PNG)", parameters: [q("m", "market"), q("side", "0|1 with owner for a position card"), q("owner", "wallet"), q("meta", "1 for the /meta card")], responses: { 200: { description: "image/png" } } } },
    "/api/rpc": { post: { tags: ["rpc"], summary: "Solana JSON-RPC, allow-listed methods only", description: "getAccountInfo, getMultipleAccounts, getLatestBlockhash, sendTransaction, simulateTransaction, getSignatureStatuses, getBalance, getTokenAccountBalance, getTokenAccountsByOwner, getSignaturesForAddress, getTransaction, getProgramAccounts (our programs only), and a few more. Batches up to 40.", requestBody: { required: true, content: { "application/json": { example: { jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] } } } }, responses: { 200: { description: "JSON-RPC response" }, 400: { description: "method not allowed" } } } },
  },
};

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>100x.broker API</title><link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui.min.css">
<style>body{margin:0;background:#0b0b0c}.swagger-ui .topbar{display:none}.swagger-ui{filter:invert(.92) hue-rotate(180deg)}.swagger-ui img,.swagger-ui .microlight{filter:invert(1) hue-rotate(180deg)}
.pitch{font:15px/1.5 system-ui,sans-serif;color:#ddd;padding:18px 24px 0;max-width:72ch}.pitch a{color:#8fd}</style></head>
<body><p class="pitch">You long it? <b>Long it.</b> Short? <b>Short it.</b> Don't want to be long or short but think it's gonna be a wild ride? <a href="/yield">/yield</a>. Agents: <a href="/cli/README.md">/cli/README.md</a> · <a href="/arena">/arena</a></p>
<div id="ui"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui-bundle.min.js" crossorigin></script>
<script>window.ui=SwaggerUIBundle({url:"/api?spec=1",dom_id:"#ui",deepLinking:true,tryItOutEnabled:true,defaultModelsExpandDepth:-1})</script></body></html>`;

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("cache-control", "public, max-age=300, s-maxage=3600");
  res.setHeader("vary", "accept");
  if (req.query.spec !== undefined || /application\/json/.test(String(req.headers.accept ?? "")) && req.query.ui === undefined) {
    res.setHeader("access-control-allow-origin", "*");
    return res.json(spec);
  }
  res.setHeader("content-type", "text/html; charset=utf-8").send(html);
}
