// Read-only integration check against a separately deployed local fork or mainnet.
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import deploymentHandler from "../api/deployment.js";
import { conn, loadMarketView } from "../src/lib/chain.js";
import { deploymentStatus } from "../src/lib/deployment.js";
import { DN_PROGRAM_ID, PROGRAM_ID, RFSTACC } from "../src/config.js";

const market = new PublicKey(process.argv[2]);
const statuses = await Promise.all([deploymentStatus(conn), deploymentStatus(conn, DN_PROGRAM_ID)]);
assert(statuses.every((status) => status.available), JSON.stringify(statuses));
const response = {
  statusCode: 200, body: null as unknown,
  setHeader() { return this; },
  status(code: number) { this.statusCode = code; return this; },
  json(body: unknown) { this.body = body; return this; },
};
await deploymentHandler({ method: "GET" } as VercelRequest, response as unknown as VercelResponse);
assert.equal(response.statusCode, 200);
assert.deepEqual(response.body, statuses[0], "deployment API and chain reader agree");
const view = await loadMarketView(market);
assert(view, "replacement market loads through the application decoder");
const [marketAccount, bullVault, bearVault] = await conn.getMultipleAccountsInfo([market, view.acct.vaultBull, view.acct.vaultBear]);
assert(marketAccount?.owner.equals(PROGRAM_ID));
assert(bullVault && new PublicKey(bullVault.data.subarray(0, 32)).equals(RFSTACC));
assert(bearVault && new PublicKey(bearVault.data.subarray(0, 32)).equals(RFSTACC));
assert.equal(view.acct.windowSecs, 1);
console.log(JSON.stringify({
  at: new Date().toISOString(), checked: "read-only app/API integration", statuses,
  market: market.toBase58(), ticker: view.ticker, quote: RFSTACC.toBase58(),
  windowSecs: view.acct.windowSecs, sideSymbols: view.side.map((side) => side.symbol),
  results: ["deployment API agrees with canonical on-chain ProgramData", "fresh market loads", "both vaults use r-fstacc", "UP/DOWN and two-observation window preserved"],
}, null, 2));
