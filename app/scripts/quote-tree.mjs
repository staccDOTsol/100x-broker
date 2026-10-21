// Every pump.fun coin quoted in a given mint, and every coin quoted in those, down the create_v2 depth chain: each one's
// rate in its own quote, and that rate chained up through each quote's rate to SOL and USD ("rates of rates").
//
//   RPC=<helius url> node scripts/quote-tree.mjs [quoteMint] [--json]
//
// Found through the quote's own token accounts: each curve quoted in it (quote_mint at offset 83, depth at 141) and each
// PumpSwap pool quoted in it (quote_mint at offset 75) holds one. A curve's rate is virtual quote / virtual token reserves; a pool's is (quote vault +
// pool virtual_quote_reserves) / base vault, the same reading pump's create_v2 uses.
import { Connection, PublicKey } from "@solana/web3.js";

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const WSOL = "So11111111111111111111111111111111111111112";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const QUOTE = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump";
const JSON_OUT = process.argv.includes("--json");
const MAX_DEPTH = 6;
if (!process.env.RPC) throw new Error("set RPC to a Helius mainnet URL (getProgramAccountsV2 is Helius-only)");
const conn = new Connection(process.env.RPC, "confirmed");

async function rpc(method, params) {
  for (let i = 0; ; i++) {
    const r = await fetch(process.env.RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json().catch(() => null);
    if (j?.result !== undefined) return j.result;
    if (i >= 5) throw new Error(`${method}: ${JSON.stringify(j?.error ?? r.status)}`);
    await new Promise((s) => setTimeout(s, 700 * (i + 1)));
  }
}
/** getProgramAccountsV2 with a memcmp, every page. */
async function scan(program, offset, mint, length) {
  const out = [];
  let paginationKey;
  do {
    const res = await rpc("getProgramAccountsV2", [program, { encoding: "base64", commitment: "confirmed", limit: 1000, paginationKey, dataSlice: { offset: 0, length }, filters: [{ memcmp: { offset, bytes: mint } }] }]);
    for (const a of res.accounts ?? []) out.push({ pubkey: a.pubkey, data: Buffer.from(a.account.data[0], "base64") });
    paginationKey = res.paginationKey ?? undefined;
  } while (paginationKey);
  return out;
}
const u64 = (d, o) => d.readBigUInt64LE(o);
const i128 = (d, o) => d.readBigUInt64LE(o) + (d.readBigInt64LE(o + 8) << 64n);
const pk = (d, o) => new PublicKey(d.subarray(o, o + 32)).toBase58();

const decimalsCache = new Map([[WSOL, 9]]);
async function decimals(mints) {
  const need = mints.filter((m) => !decimalsCache.has(m));
  for (let i = 0; i < need.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(need.slice(i, i + 100).map((m) => new PublicKey(m)));
    infos.forEach((a, j) => decimalsCache.set(need[i + j], a ? a.data[44] : 6));
  }
}

/** A curve doesn't store its own mint: it's the one token account the curve PDA holds that isn't the quote. */
async function curveMint(curve, quote) {
  for (const programId of [T22, SPL]) {
    const r = await conn.getParsedTokenAccountsByOwner(new PublicKey(curve), { programId: new PublicKey(programId) });
    const hit = r.value.map((x) => x.account.data.parsed.info.mint).find((m) => m !== quote);
    if (hit) return hit;
  }
  return null;
}

async function pool(baseMint, quoteMint) {
  const pools = (await scan(AMM, 43, baseMint, 261)).filter((p) => pk(p.data, 75) === quoteMint);
  if (!pools.length) return null;
  let best = null;
  for (const p of pools) {
    const [b, q] = await Promise.all([pk(p.data, 139), pk(p.data, 171)].map((v) => conn.getTokenAccountBalance(new PublicKey(v)).then((x) => BigInt(x.value.amount)).catch(() => 0n)));
    const vq = p.data.length >= 261 ? i128(p.data, 245) : 0n;
    if (!best || q > best.q) best = { pool: p.pubkey, b, q, vq };
  }
  return best;
}

/** Children of `quote`. Every curve quoted in it keeps a quote token account owned by the curve, and every PumpSwap
 *  pool a quote vault owned by the pool, so: list the quote's token accounts (DAS, indexed by mint) and keep the ones
 *  whose owner is a pump curve or a pool quoted in it. Much faster than scanning pump's millions of accounts. */
async function children(quote) {
  const owners = new Set();
  for (let page = 1; ; page++) {
    const r = await rpc("getTokenAccounts", { mint: quote, limit: 1000, page });
    for (const t of r.token_accounts ?? []) owners.add(t.owner);
    if ((r.token_accounts ?? []).length < 1000) break;
  }
  const list = [...owners];
  const kids = [];
  for (let i = 0; i < list.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(list.slice(i, i + 100).map((o) => new PublicKey(o)));
    for (const [j, a] of infos.entries()) {
      if (!a) continue;
      const owner = a.owner.toBase58(), d = a.data, addr = list[i + j];
      if (owner === PUMP && d.length >= 166 && pk(d, 83) === quote) {
        kids.push({ curve: addr, mint: null, vToken: u64(d, 8), vQuote: u64(d, 16), realToken: u64(d, 24), complete: d[48] === 1, depth: d[141], initVQuote: u64(d, 142) });
      } else if (owner === AMM && d.length >= 107 && pk(d, 75) === quote) {
        kids.push({ curve: null, mint: pk(d, 43), migratedOnly: true });
      }
    }
  }
  for (let i = 0; i < kids.length; i += 8) {
    await Promise.all(kids.slice(i, i + 8).map(async (k) => { if (!k.mint) k.mint = await curveMint(k.curve, quote); }));
  }
  // a graduated coin shows up twice (its finished curve and its pool): keep one, the pool prices it
  const seen = new Map();
  for (const k of kids.filter((k) => k.mint)) if (!seen.has(k.mint) || k.migratedOnly) seen.set(k.mint, { ...seen.get(k.mint), ...k });
  return [...seen.values()];
}

/** Rate of `mint` in `quote` (UI units): curve while it trades, PumpSwap pool once complete. */
async function rate(node, quote) {
  await decimals([node.mint, quote]);
  const scale = 10 ** (decimalsCache.get(node.mint) - decimalsCache.get(quote));
  if (node.curve && !node.complete && node.vToken > 0n) return { rate: (Number(node.vQuote) / Number(node.vToken)) * scale, venue: "curve", progress: 1 - Number(node.realToken) / 793_100_000e6 };
  const p = await pool(node.mint, quote);
  if (!p || p.b === 0n) return { rate: null, venue: node.complete ? "graduating" : "none" };
  return { rate: (Number(p.q + p.vq) / Number(p.b)) * scale, venue: "pumpswap", pool: p.pool, quoteDepth: Number(p.q) / 10 ** decimalsCache.get(quote) };
}

/** The root quote's own rate in SOL: its curve while it trades, else its PumpSwap pool. */
async function rootRate(mint) {
  const curve = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], new PublicKey(PUMP))[0];
  const a = await conn.getAccountInfo(curve);
  if (a && a.data.length >= 49) {
    const d = a.data, q = a.data.length >= 115 ? pk(d, 83) : WSOL;
    if (q !== WSOL && q !== "11111111111111111111111111111111") return { rate: null, venue: `quoted in ${q}, not SOL` };
    return rate({ mint, curve: curve.toBase58(), vToken: u64(d, 8), vQuote: u64(d, 16), realToken: u64(d, 24), complete: d[48] === 1 }, WSOL);
  }
  return rate({ mint, curve: null, complete: true }, WSOL);
}

async function main() {
  const [solUsd, root] = await Promise.all([
    fetch(`https://lite-api.jup.ag/price/v3?ids=${WSOL}`).then((r) => r.json()).then((j) => j[WSOL]?.usdPrice ?? null).catch(() => null),
    rootRate(QUOTE),
  ]);
  const rows = [];
  async function walk(quote, quoteInRoot, quoteInSol, depth, path) {
    if (depth > MAX_DEPTH) return;
    for (const kid of await children(quote)) {
      const r = await rate(kid, quote);
      const inRoot = r.rate != null && quoteInRoot != null ? r.rate * quoteInRoot : null;
      const inSol = r.rate != null && quoteInSol != null ? r.rate * quoteInSol : null;
      rows.push({ depth, path: [...path, kid.mint], mint: kid.mint, quote, venue: r.venue, rate_in_quote: r.rate, rate_in_root: inRoot, rate_in_sol: inSol, rate_in_usd: inSol != null && solUsd ? inSol * solUsd : null, mcap_sol: inSol != null ? inSol * 1e9 : null, curve_progress: r.progress ?? null, curve_depth: kid.depth ?? null, curve: kid.curve, pool: r.pool ?? null });
      await walk(kid.mint, inRoot, inSol, depth + 1, [...path, kid.mint]);
    }
  }
  await walk(QUOTE, 1, root.rate, 1, []);
  // symbols, best effort
  const meta = await rpc("getAssetBatch", { ids: [QUOTE, ...rows.map((r) => r.mint)] }).catch(() => []);
  const sym = new Map((meta ?? []).filter(Boolean).map((a) => [a.id, a.content?.metadata?.symbol ?? ""]));
  for (const r of rows) r.symbol = sym.get(r.mint) ?? "";
  const out = { quote: QUOTE, quote_symbol: sym.get(QUOTE) ?? "", quote_in_sol: root.rate, sol_usd: solUsd, coins: rows.sort((a, b) => a.depth - b.depth || (b.mcap_sol ?? 0) - (a.mcap_sol ?? 0)) };
  if (JSON_OUT) return console.log(JSON.stringify(out, null, 2));
  const f = (x, d = 4) => (x == null ? "—" : Math.abs(x) >= 1 ? x.toLocaleString("en-US", { maximumFractionDigits: d }) : x.toPrecision(d));
  console.log(`quote ${out.quote_symbol || ""} ${QUOTE}: ${f(root.rate)} SOL (${root.venue})${solUsd ? ` · $${f(root.rate * solUsd)}` : ""} · ${rows.length} coins under it`);
  for (const r of out.coins) {
    console.log(`${"  ".repeat(r.depth - 1)}d${r.depth} ${(r.symbol || "?").padEnd(10)} ${r.mint}  ${r.venue.padEnd(8)} ${f(r.rate_in_quote)} in its quote · ${f(r.rate_in_root)} ${out.quote_symbol || "root"} · ${f(r.rate_in_sol)} SOL · $${f(r.rate_in_usd)} · mcap ${f(r.mcap_sol, 2)} SOL${r.curve_progress != null ? ` · curve ${(r.curve_progress * 100).toFixed(1)}%` : ""}`);
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
