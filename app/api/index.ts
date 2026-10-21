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
    { name: "history", description: "Time series and event history: $NGU's SOL rate, trades, realized wins, vault stories" },
    { name: "arena", description: "Agents: markets, vaults, books, the leaderboard, and unsigned transactions to trade with" },
    { name: "read", description: "Public reads the site itself uses" },
    { name: "tokens", description: "Token lookups, search, what's running, images and metadata" },
    { name: "builders", description: "Quotes and unsigned transactions: swaps, 100x legs, vault zaps, coin launches. The caller signs; the server signs nothing of yours" },
    { name: "games", description: "Stars War / Last Bid Wins" },
    { name: "tools", description: "Utilities" },
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
    "/api/ngu-history": { get: { tags: ["history"], summary: "SOL per $NGU over time (one point after every transaction that moved it, launch to now) and its APR / APY over trailing windows", description: "Rebuilt from chain and anchored to live state: the stake pool's SOL backing and the NGU mint's supply now, walked back through every buy, sell, epoch update and crank. The last point is the current rate. Feeds the TradingView chart on /ngu.", responses: { 200: { description: "{ points: [[unix_seconds, sol_per_ngu], ...] oldest first, yield: { '1h' | '24h' | '7d' | '30d' | 'since_launch': { from, secs, rate_from, rate_to, growth_pct, apr_pct, apy_pct } | null } }. yield is the rate's growth over each trailing window ending at the last point, annualized two ways: apr_pct simple (growth × year / window), apy_pct compounded ((1 + growth)^(year / window) − 1; null if it overflows). A window older than the launch is null. It's the rate alone: a holder also pays the 6.9% buy fee and the sell fee. Short windows annualize noise; none of it is a forecast.", content: { "application/json": { example: { points: [[1792255964, 1], [1792256288, 1.035509], [1792258819, 1.086923]], yield: { "1h": { from: 1792255219, secs: 3600, rate_from: 1.0412, rate_to: 1.086923, growth_pct: 4.39, apr_pct: 38475.5, apy_pct: null }, "24h": null, "7d": null, "30d": null, since_launch: { from: 1792255964, secs: 2855, rate_from: 1, rate_to: 1.086923, growth_pct: 8.69, apr_pct: 96060.1, apy_pct: null } } } } } }, 502: { description: "{ error } — upstream RPC unavailable; retry" } } } },
    "/api/search": { get: { tags: ["tokens"], summary: "Solana tokens matching a name or symbol, biggest 24h volume first, each classified meme | major | stonk | stable | other", parameters: [q("q", "name or symbol", true), q("cat", "meme | major | stonk")], responses: { 200: { description: "{ tokens: [...] }" } } } },
    "/api/runners": { get: { tags: ["tokens"], summary: "What's running on Solana now, each coin tagged with what you can do here: an existing board (market) or a listable pool", parameters: [q("cat", "meme | major | stonk")], responses: { 200: { description: "{ runners: [{ mint, symbol, category, market?, listable?, ... }] }" } } } },
    "/api/pumps": { get: { tags: ["tokens"], summary: "A market's companion pump.fun coins ($TICKERUP / $TICKERDN, quoted in $100XBRO): price, market cap, curve progress", parameters: [q("market", "market address", true)], responses: { 200: { description: "JSON" } } } },
    "/api/poolvol": { get: { tags: ["tokens"], summary: "24h volume and liquidity for up to 20 pools (Birdeye)", parameters: [q("ids", "comma-separated pool addresses, max 20", true)], responses: { 200: { description: "{ [pool]: { vol24, liq } }" } } } },
    "/api/asset": { get: { tags: ["tokens"], summary: "A token's DAS asset record", parameters: [q("mint", "token mint", true)], responses: { 200: { description: "JSON" }, 404: { description: "{ error }" } } } },
    "/api/meta": { get: { tags: ["tokens"], summary: "Token metadata JSON for an UP/DOWN token, derived from its underlying", parameters: [q("mint", "underlying mint", true), q("s", "side: UP or DOWN")], responses: { 200: { description: "Metaplex-style metadata JSON" } } } },
    "/api/img": { get: { tags: ["tokens"], summary: "UP/DOWN token image: the underlying's image tinted green or red with a 100x badge", parameters: [q("mint", "underlying mint", true), q("s", "side: UP or DOWN")], responses: { 200: { description: "image/png" } } } },
    "/api/icon": { get: { tags: ["tokens"], summary: "Any token's icon as a 128px PNG (DAS image, cached a month)", parameters: [q("mint", "token mint", true)], responses: { 200: { description: "image/png" } } } },
    "/api/swap": {
      get: { tags: ["builders"], summary: "Swap quote from the live router (swap.100x.broker); 1 bp per hop to us, plus 10 bp per hop placed as 100x legs", parameters: [q("inputMint", "input mint", true), q("outputMint", "output mint", true), q("amount", "input amount, raw units", true), q("slippageBps", "slippage in bps"), q("badBeat", "1 flips the legs")], responses: { 200: { description: "quoteResponse JSON" } } },
      post: { tags: ["builders"], summary: "Build the swap transaction for a quote", requestBody: { required: true, content: { "application/json": { example: { userPublicKey: "<wallet>", quoteResponse: {} } } } }, responses: { 200: { description: "{ swapTransaction: base64 }" }, 400: { description: "{ error }" } } },
    },
    "/api/legs": { post: { tags: ["builders"], summary: "A swap's 100x legs: per hop, 10 bp of its SOL value as a 100x long on what it bought and a 100x short on what it sold (badBeat flips), plus listings for coins without a market", requestBody: { required: true, content: { "application/json": { example: { wallet: "<wallet>", hops: [{ inputMint: "So11111111111111111111111111111111111111112", outputMint: "<mint>", inAmount: "100000000", outAmount: "123456", label: "Orca" }], badBeat: false, build: false } } } }, responses: { 200: { description: "priced legs; unsigned transactions when build=true with a wallet" } } } },
    "/api/dnzap": { post: { tags: ["builders"], summary: "One-click vault zaps: kind=in parks SOL in a delta-neutral vault, kind=out unparks", requestBody: { required: true, content: { "application/json": { example: { kind: "in", vault: "<vault>", user: "<wallet>", lamports: 100000000 } } } }, responses: { 200: { description: "in: { steps: [{ label, ixs, signers }], note? } · out: { ixs, minOut }" } } } },
    "/api/launch": {
      get: { tags: ["builders"], summary: "Launch form data: the $100XBRO quote, or the Orca launcher's slot menu with orca=1", parameters: [q("orca", "1 for the Orca launcher's slots and quotes")], responses: { 200: { description: "{ quote: { symbol, usd }, alt } or { slots, quotes, alt }" } } },
      post: { tags: ["builders"], summary: "Self-serve pump.fun launch quoted in $100XBRO: op=zap (SOL -> $100XBRO), op=meta (upload image + metadata), op=build (unsigned launch transactions)", requestBody: { required: true, content: { "application/json": { example: { op: "build", wallet: "<wallet>", mint: "<mint>", uri: "<metadata uri>", name: "Coin", symbol: "COIN", buy: 0, war: false } } } }, responses: { 200: { description: "zap: { tx } · meta: { uri, image, website } · build: { txs, mintTx, summary }" } } },
    },
    "/api/war": {
      get: { tags: ["games"], summary: "Stars War games: one game (state, phase, next minimum bid in token units and USD), or recent games with list=1", parameters: [q("g", "game id or featured"), q("list", "1 for recent games, live first"), q("wallet", "a wallet's games and keys"), q("mint", "games on one token")], responses: { 200: { description: "JSON" } } },
      post: { tags: ["games"], summary: "Unsigned game transactions: bid | multibid | fork | settle | next | claim", requestBody: { required: true, content: { "application/json": { example: { op: "bid", g: 1, wallet: "<wallet>", amount: "1000000" } } } }, responses: { 200: { description: "{ txs: base64[], summary }" } } },
    },
    "/api/vanity": { get: { tags: ["tools"], summary: "The 1oox vanity mint-key grinder: usage, or its live stockpile with stock=1 (counts only, never keys; handing keys out is the site's own rate-limited POST)", parameters: [{ name: "stock", in: "query", required: false, description: "1 for the stockpile counts", schema: { type: "string", example: "1" } }], responses: { 200: { description: "without stock: { prefix, usage } · with stock=1: { prefix, stock: { available, used, rate_per_hour, attempts_per_sec, found_since_boot, uptime_secs, keys: {...} } }", content: { "application/json": { example: { prefix: "1oox", stock: { available: 1167, used: 2, rate_per_hour: 9.1, attempts_per_sec: 10873087, found_since_boot: 163, uptime_secs: 56573 } } } } } } } },
    "/api/leaders": { get: { tags: ["read"], summary: "Top wallets (by value), one market's holders, or the most active wallets", parameters: [q("m", "market address: top UP and DOWN holders"), q("active", "hours (1–168): most active wallets by volume, closed positions included")], responses: { 200: { description: "JSON" } } } },
    "/api/feed": { get: { tags: ["history"], summary: "Latest trades: all markets, one market, or one wallet", parameters: [q("m", "market address"), q("w", "wallet address"), q("n", "with w: moves per token account, up to 200 (default 40)")], responses: { 200: { description: "{ events: [...] }" } } } },
    "/api/markets": { get: { tags: ["read"], summary: "Every market's live state in one call (the board's snapshot)", responses: { 200: { description: "{ at, markets: [...] }" } } } },
    "/api/winners": { get: { tags: ["history"], summary: "The winner feed: every realized win, all time — UP/DOWN exits and vault unparks that paid more than they cost", responses: { 200: { description: "{ at, rate, count, wallets, total_sol, exits, unparks, wins: [{ sig, ts, wallet, kind, market, vault?, ticker, side?, cost_sol, out_sol, gain_sol, ret, hold_s, per_hour_sol }] }" } } } },
    "/api/dnfeed": { get: { tags: ["history"], summary: "One vault's story: born, parked, unparked, keeper rebalances", parameters: [q("v", "vault address", true)], responses: { 200: { description: "JSON" } } } },
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
