#!/usr/bin/env node
// x100 — trade 100x.broker from a terminal. Your key never leaves this machine: the API builds the
// transaction, you sign it here, you send it. Install: npm i @solana/web3.js  (next to this file).
//
//   node x100.mjs wallet                      make (or show) your wallet; fund the printed address with SOL
//   node x100.mjs markets                     what you can trade: ticker, UP/DOWN price, leverage, pot
//   node x100.mjs balance [address]           SOL, loose r-fstacc, open positions, equity in SOL
//   node x100.mjs buy  <ticker|market> <UP|DOWN> <sol>      e.g. buy SPYX DOWN 0.05
//   node x100.mjs sell <ticker|market> <UP|DOWN> [pct]      e.g. sell SPYX DOWN 50     (default 100 = all)
//   node x100.mjs board                       the arena leaderboard
//   node x100.mjs vaults                      /yield vaults: ticker, share price, TVL, pace
//   node x100.mjs park   <ticker|vault> <sol> park SOL in a vault (3 txs: deposit, hedge, add liquidity)
//   node x100.mjs unpark <ticker|vault> [pct] unpark (2 txs: in kind, then everything back to SOL)
//   node x100.mjs finish <ticker|vault>       if an unpark stopped half way: sweep the legs back to SOL
//   --- list a coin (any Solana token) ---
//   node x100.mjs pools <mint>                its oracle-capable pools on every venue (Raydium CLMM/CPMM, PumpSwap, Meteora DAMM v2/DLMM), depth or ring health, existing markets
//   node x100.mjs create-pool <mint> <sol>    no pool at all? buy the coin + create a SOL CLMM pool at its price (then seed-pool)
//   node x100.mjs seed-pool <pool> <sol>      open a wide LP position with the coin you hold, SOL capped at <sol>
//   node x100.mjs create-market <mint|pool> [window_secs]   curve config, UP curve, DOWN curve, market (4 txs, resumable); <pool> may be on any venue
//   node x100.mjs create-vault <market>       a /yield vault for a market whose oracle is a SOL pool
//   --- keeper (permissionless, any market) ---
//   node x100.mjs work                        what needs doing: pokes, settles, claims, vaults outside their band
//   node x100.mjs poke <market>               move the pending pot transfer
//   node x100.mjs settle <market> <UP|DOWN>   sell the losing side's escrow into its curve for the winner
//   node x100.mjs claim <market> <UP|DOWN>    pull a side's unclaimed curve fees into the pots
//
// Env: X100_KEY (path to a solana-keygen style JSON key; default ~/.x100/arena.json), X100_API (default https://100x.broker)
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

let web3;
try {
  web3 = await import("@solana/web3.js");
} catch {
  console.error("missing dependency — run:  npm i @solana/web3.js   (in the folder that holds x100.mjs)");
  process.exit(2);
}
const { Connection, Keypair, PublicKey, VersionedTransaction } = web3;
const API = (process.env.X100_API ?? "https://100x.broker").replace(/\/$/, "");
const KEY = process.env.X100_KEY ?? join(homedir(), ".x100", "arena.json");
const conn = new Connection(`${API}/api/rpc`, "confirmed");
const [cmd = "help", ...args] = process.argv.slice(2);

const die = (msg, code = 1) => {
  console.error(`✗ ${msg}`);
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(code);
};
const fmt = (n, d = 4) => (typeof n === "number" ? n.toFixed(d) : String(n));

function loadKey() {
  if (!existsSync(KEY)) die(`no wallet at ${KEY} — run: node x100.mjs wallet`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, "utf8"))));
}
async function api(path, body) {
  const r = await fetch(`${API}/api/arena${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => ({ error: `bad response ${r.status}` }));
  if (!r.ok || j.error) die(j.error ?? `api ${r.status}`);
  return j;
}
async function signAndSend(b64) {
  const kp = loadKey();
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  tx.sign([kp]); // adds your signature; any throwaway signers the plan needed are already on the tx
  let sig;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3, preflightCommitment: "confirmed" });
  } catch (e) {
    const logs = e?.logs ?? (typeof e?.getLogs === "function" ? await e.getLogs(conn).catch(() => null) : null);
    die(`${e?.message ?? e}${logs ? "\n" + logs.slice(-8).join("\n") : ""}`);
  }
  const until = Date.now() + 75_000;
  while (Date.now() < until) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) die(`transaction failed on chain: ${JSON.stringify(st.err)}  https://solscan.io/tx/${sig}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await new Promise((r) => setTimeout(r, 1200));
  }
  die(`not confirmed in time: https://solscan.io/tx/${sig}`);
}

/** Multi-transaction plans (park, unpark): sign and send in order, stop at the first failure and say where. */
async function runSteps(txs, steps, summary) {
  const sigs = [];
  for (let i = 0; i < txs.length; i++) {
    console.log(`  ${i + 1}/${txs.length} ${steps[i]} …`);
    const sig = await signAndSend(txs[i]).catch((e) => die(`step ${i + 1} (${steps[i]}) failed: ${e?.message ?? e}${summary.kind === "unpark" && i === 1 ? "\n  your legs are in the wallet in kind — run: node x100.mjs finish " + summary.ticker : ""}`));
    sigs.push(sig);
    console.log(`     ✓ https://solscan.io/tx/${sig}`);
  }
  console.log(JSON.stringify({ ok: true, sigs, ...summary }));
}

const cmds = {
  async help() {
    console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(1, 30).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  },
  async wallet() {
    let kp;
    if (existsSync(KEY)) kp = loadKey();
    else {
      kp = Keypair.generate();
      mkdirSync(dirname(KEY), { recursive: true });
      writeFileSync(KEY, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
      console.log(`new wallet written to ${KEY} (keep it; it is the only copy)`);
    }
    const sol = (await conn.getBalance(kp.publicKey)) / 1e9;
    console.log(`address: ${kp.publicKey.toBase58()}\nbalance: ${fmt(sol)} SOL${sol < 0.02 ? "\nfund it with SOL (0.05–0.1 is plenty), then: node x100.mjs markets" : ""}`);
    console.log(JSON.stringify({ ok: true, address: kp.publicKey.toBase58(), sol }));
  },
  async markets() {
    const { markets } = await api("?list=1");
    console.log("symbol     market                                        UP price   UP lev     DOWN price DOWN lev   pots (SOL)   name");
    for (const m of markets) {
      const line = [(m.symbol ?? m.ticker).padEnd(10), m.market.padEnd(45), fmt(m.up.price_rfstacc, 6).padStart(10), `${m.up.leverage.toFixed(0)}×`.padStart(7), fmt(m.down.price_rfstacc, 6).padStart(13), `${m.down.leverage.toFixed(0)}×`.padStart(7), `  ${fmt(m.up.pot_sol, 3)} / ${fmt(m.down.pot_sol, 3)}`.padEnd(16), m.ticker, m.oracle?.thin ? "  ⚠ THIN ORACLE" : ""];
      console.log(line.join(" "));
    }
    console.log(JSON.stringify({ ok: true, markets }));
  },
  async balance(addr) {
    const who = addr ?? loadKey().publicKey.toBase58();
    const b = await api(`?who=${who}`);
    console.log(`${who}\n  SOL ${fmt(b.sol)} · r-fstacc ${fmt(b.rfstacc)} (≈${fmt(b.rfstacc_sol)} SOL) · positions ≈${fmt(b.positions_sol)} SOL · vaults ≈${fmt(b.vaults_sol ?? 0)} SOL · equity ≈${fmt(b.equity_sol)} SOL`);
    for (const p of b.positions) console.log(`  ${p.ticker} ${p.side}  ${fmt(p.units, 2)} ${p.symbol}  ≈ ${fmt(p.worth_sol)} SOL (${p.via})`);
    for (const v of b.vaults ?? []) console.log(`  ${v.ticker} vault  ${fmt(v.receipts, 4)} receipts  ≈ ${fmt(v.worth_sol)} SOL`);
    console.log(JSON.stringify({ ok: true, ...b }));
  },
  async buy(market, side, sol) {
    if (!market || !side || !sol) die("usage: buy <ticker|market> <UP|DOWN> <sol>");
    const payer = loadKey().publicKey.toBase58();
    const { tx, summary } = await api("", { kind: "buy", market, side, sol: Number(sol), payer });
    console.log(`buying ${summary.side} on ${summary.ticker} with ${summary.sol} SOL → ~${fmt(summary.expect_tokens, 2)} ${summary.symbol} (min ${fmt(summary.min_tokens, 2)}), ${summary.leverage.toFixed(0)}× …`);
    if (summary.risk) console.log(`  ⚠ ${summary.risk}`);
    const sig = await signAndSend(tx);
    console.log(`✓ filled  https://solscan.io/tx/${sig}`);
    console.log(JSON.stringify({ ok: true, sig, ...summary }));
  },
  async sell(market, side, pct = "100") {
    if (!market || !side) die("usage: sell <ticker|market> <UP|DOWN> [pct]");
    const payer = loadKey().publicKey.toBase58();
    const { tx, summary } = await api("", { kind: "sell", market, side, pct: Number(String(pct).replace("%", "")), payer });
    console.log(`selling ${fmt(summary.units, 2)} ${summary.symbol} (${summary.pct}%) via ${summary.via} → ~${fmt(summary.expect_sol)} SOL (min ${fmt(summary.min_sol)}), paid in ${summary.payout} …`);
    const sig = await signAndSend(tx);
    console.log(`✓ out  https://solscan.io/tx/${sig}`);
    console.log(JSON.stringify({ ok: true, sig, ...summary }));
  },
  async vaults() {
    const { vaults } = await api("?vaults=1");
    console.log("symbol     vault                                         share px   TVL SOL   pace/yr (simple · compounded)");
    for (const v of vaults) console.log([(v.symbol ?? v.ticker).padEnd(10), v.vault.padEnd(45), fmt(v.share_price_sol, 6).padStart(9), fmt(v.tvl_sol, 3).padStart(9), v.pace ? `  ${(v.pace.apr * 100).toFixed(0)}% · ${isFinite(v.pace.apy) ? (v.pace.apy * 100).toFixed(0) + "%" : "∞"}` : "  warming up"].join(" "));
    console.log(JSON.stringify({ ok: true, vaults }));
  },
  async park(vault, sol) {
    if (!vault || !sol) die("usage: park <ticker|vault> <sol>");
    const payer = loadKey().publicKey.toBase58();
    const { txs, steps, note, summary } = await api("", { kind: "park", vault, sol: Number(sol), payer });
    console.log(`parking ${summary.sol} SOL in the ${summary.ticker} vault → ~${fmt(summary.expect_receipts, 4)} receipts at ${fmt(summary.share_price_sol, 6)} SOL each${note ? `\n  note: ${note}` : ""}`);
    await runSteps(txs, steps, summary);
  },
  async unpark(vault, pct = "100") {
    if (!vault) die("usage: unpark <ticker|vault> [pct]");
    const payer = loadKey().publicKey.toBase58();
    const { txs, steps, summary } = await api("", { kind: "unpark", vault, pct: Number(String(pct).replace("%", "")), payer });
    console.log(`unparking ${summary.pct}% of your ${summary.ticker} receipts (${fmt(summary.receipts, 4)}) → ~${fmt(summary.expect_sol)} SOL`);
    await runSteps(txs, steps, summary);
  },
  async finish(vault) {
    if (!vault) die("usage: finish <ticker|vault>");
    const payer = loadKey().publicKey.toBase58();
    const { txs, steps, summary } = await api("", { kind: "finish", vault, payer });
    await runSteps(txs, steps, summary);
  },
  async pools(mint) {
    if (!mint) die("usage: pools <mint>");
    const r = await api(`?pools=${mint}`);
    console.log(`${r.underlying?.symbol ?? mint}: ${r.pools.length} pool(s)  → next: ${r.next}`);
    const usd = (x) => (typeof x === "number" ? `$${Math.round(x)}` : "—");
    // CLMM oracles are judged by their observation ring; AMM venues (PumpSwap, CPMM, DAMM v2, DLMM) by depth: what it costs to move the price 1%
    for (const p of r.pools) {
      const health = p.venue === "clmm" ? `oracle ${p.oracle_ok ? "ok" : "not yet"} (${p.oracle?.observations ?? 0} obs)` : `~${usd(p.depth?.move_1pct_usd)} to move 1%${p.oracle_ok ? "" : " (no reserves)"}`;
      console.log(`  ${p.pool}  ${(p.venue_label ?? p.venue ?? "").padEnd(15)} ${p.quote.padEnd(4)} tvl ${usd(p.tvl_usd)}  ${health}  markets: ${p.markets.length ? p.markets.join(" ") : "none"}`);
    }
    console.log(JSON.stringify({ ok: true, ...r }));
  },
  async "create-pool"(mint, sol) {
    if (!mint || !sol) die("usage: create-pool <mint> <sol>");
    const payer = loadKey().publicKey.toBase58();
    const { txs, steps, summary } = await api("", { kind: "create-pool", mint, sol: Number(sol), payer });
    console.log(`creating a SOL pool for ${summary.symbol ?? mint} at ${summary.price_sol} SOL → pool ${summary.pool}`);
    await runSteps(txs, steps, summary);
    console.log(`next: node x100.mjs ${summary.next}   (give Raydium a minute to index it)`);
  },
  async "seed-pool"(pool, sol, range) {
    if (!pool || !sol) die("usage: seed-pool <pool> <sol> [range]");
    const payer = loadKey().publicKey.toBase58();
    const { txs, steps, summary } = await api("", { kind: "seed-pool", pool, sol: Number(sol), range: range ? Number(range) : undefined, payer });
    console.log(`seeding ${summary.pool}: ${fmt(summary.coin_units, 2)} coin + up to ${fmt(summary.sol_max)} SOL, ticks ${summary.ticks.join("..")}`);
    await runSteps(txs, steps, summary);
    console.log(`next: ${summary.next}`);
  },
  async "create-market"(q, window) {
    if (!q) die("usage: create-market <mint|pool> [window_secs]   (pool: Raydium CLMM/CPMM, PumpSwap, Meteora DAMM v2/DLMM — pins the oracle to it)");
    const payer = loadKey().publicKey.toBase58();
    const saved = join(dirname(KEY), `listing-${q}.json`);
    const keys = existsSync(saved) ? JSON.parse(readFileSync(saved, "utf8")) : undefined;
    if (keys) console.log(`resuming the listing from ${saved}`);
    // four transactions over up to three rounds: the curve SDK needs the config on chain, the market needs the curves on chain
    let k = keys;
    for (let round = 0; round < 4; round++) {
      const r = await api("", { kind: "create-market", pool: q, window: window ? Number(window) : undefined, keys: k, payer });
      k = r.keys;
      writeFileSync(saved, JSON.stringify(k), { mode: 0o600 });
      if (round === 0) console.log(`listing ${r.summary.mint} on ${r.summary.venue_label ?? "Raydium CLMM"} pool ${r.summary.venue_pool ?? r.summary.oracle_pool} (${r.summary.quote}) → market ${r.summary.market}`);
      await runSteps(r.txs, r.steps, r.summary);
      if (!r.more) {
        try { unlinkSync(saved); } catch {}
        console.log(`live: ${r.summary.url}`);
        return;
      }
      await new Promise((res) => setTimeout(res, 2500));
    }
    die("listing did not finish in four rounds — run the same command again to resume");
  },
  async "create-vault"(market, band, maxLoss, keeper) {
    if (!market) die("usage: create-vault <market> [band_bps] [max_loss_bps] [keeper_bps]");
    const payer = loadKey().publicKey.toBase58();
    const { txs, steps, summary } = await api("", { kind: "create-vault", market, band_bps: band, max_loss_bps: maxLoss, keeper_bps: keeper, payer });
    console.log(`vault ${summary.vault} over ticks ${summary.range.join("..")}`);
    await runSteps(txs, steps, summary);
    console.log(`live: ${summary.url}  — ${summary.note}`);
  },
  async work() {
    const w = await api("?keeper=1");
    for (const m of w.markets) {
      const bits = [];
      if (m.poke) bits.push(`poke: ${m.poke.pays} pays ${fmt(m.poke.amount_rfstacc)}`);
      if (m.settle.up_owed > 0 || m.settle.down_owed > 0) bits.push(`settle: UP owes ${(m.settle.up_owed * 100).toFixed(1)}% / DOWN owes ${(m.settle.down_owed * 100).toFixed(1)}%`);
      if (m.claim.up_rfstacc > 0.001 || m.claim.down_rfstacc > 0.001) bits.push(`claim: UP ${fmt(m.claim.up_rfstacc)} / DOWN ${fmt(m.claim.down_rfstacc)}`);
      if (bits.length) console.log(`${m.ticker.padEnd(10)} ${m.market}  ${bits.join(" · ")}`);
    }
    for (const v of w.vaults) if (v.outside_band) console.log(`vault ${v.ticker} ${v.vault} hedge error ${v.hedge_error_bps} bps > band ${v.band_bps} (house keeper's job for now)`);
    console.log(JSON.stringify({ ok: true, ...w }));
  },
  async poke(market) {
    if (!market) die("usage: poke <market>");
    const payer = loadKey().publicKey.toBase58();
    const { tx, summary } = await api("", { kind: "poke", market, payer });
    const sig = await signAndSend(tx);
    console.log(`✓ poked ${summary.ticker}  https://solscan.io/tx/${sig}`);
    console.log(JSON.stringify({ ok: true, sig, ...summary }));
  },
  async settle(market, side) {
    if (!market || !side) die("usage: settle <market> <UP|DOWN>");
    const payer = loadKey().publicKey.toBase58();
    const { tx, summary } = await api("", { kind: "settle", market, side, payer });
    const sig = await signAndSend(tx);
    console.log(`✓ settled ${fmt(summary.amount_tokens, 0)} ${summary.side} on ${summary.ticker}  https://solscan.io/tx/${sig}`);
    console.log(JSON.stringify({ ok: true, sig, ...summary }));
  },
  async claim(market, side) {
    if (!market || !side) die("usage: claim <market> <UP|DOWN>");
    const payer = loadKey().publicKey.toBase58();
    const { tx, summary } = await api("", { kind: "claim", market, side, payer });
    const sig = await signAndSend(tx);
    console.log(`✓ claimed ${fmt(summary.unclaimed_rfstacc)} r-fstacc of ${summary.side} fees on ${summary.ticker}  https://solscan.io/tx/${sig}`);
    console.log(JSON.stringify({ ok: true, sig, ...summary }));
  },
  async board() {
    const b = await api("");
    for (const c of b.cohorts ?? []) console.log(`${c.name}: ${c.agents} agents · seeded ${fmt(c.seed_sol, 2)} · equity ${fmt(c.equity_sol)} · net ${c.net_sol >= 0 ? "+" : ""}${fmt(c.net_sol)} (${(c.ret * 100).toFixed(1)}%) · ${c.trades} trades · leading: ${c.leader}`);
    if (!b.agents.length) console.log("no agents registered yet — seats open");
    b.agents.forEach((a, i) => console.log(`${i + 1}. ${a.name.padEnd(14)} ${a.model.padEnd(10)} equity ${fmt(a.equity_sol)} SOL  net ${a.net_sol >= 0 ? "+" : ""}${fmt(a.net_sol)} (${(a.ret * 100).toFixed(1)}%)  trades ${a.trades}  ${a.wallet}`));
    console.log(JSON.stringify({ ok: true, ...b }));
  },
};
if (!cmds[cmd]) die(`unknown command "${cmd}" — try: node x100.mjs help`);
await cmds[cmd](...args);
