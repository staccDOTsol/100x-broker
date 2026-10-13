#!/usr/bin/env node
// nash — a Nash player on 100x.broker, written for volume. Your key never leaves this machine: the API builds every
// transaction (same as the site's ticket), this script signs and sends it. Install next to x100.mjs: npm i @solana/web3.js
//
//   node nash.mjs                      one pass, dry run: prints what it would do and why
//   node nash.mjs --live               one pass, for real
//   node nash.mjs --live --loop 180    every 3 minutes until you stop it
//
// The seats, in order of structural edge (and what this script does in each):
//   empty side   pots pay 100 × (their pot / your pot) on the move. Take the smaller pot when the ratio is wide, the oracle is
//                deep, and the other pot is worth winning; size so you do not close the gap yourself. Exit when the side fills,
//                on profit, on a stop, when the other pot drains, or after --hold-min minutes (volume: exit, re-read, re-enter
//                wherever the empty side is now). Never joins the crowded side.
//   park         /yield vaults only when the realized pace clears the 8% round trip over --horizon days (times --hurdle-mult).
//   keeper       pokes pending pot transfers, settles owed curves, claims fees — permissionless, a few lamports each, and it is
//                what makes a winning side get paid.
//   creator      --create: list what the ecosystem is trading right now (Birdeye trending by volume) when it has a deep SOL CLMM
//                pool and no market yet, then open a vault and seed both sides a hair.
//   crowded side nothing. That seat funds the rest.
//
// Flags (SOL unless said):  --bank 1.0 (max at risk across seats)  --clip 0.02 (per entry)  --max-pos 0.08 (per market side)
//   --ratio 2 (min big/small pot to enter)  --target 1.5 (keep ratio at least this after entry)  --min-opp 0.001 (other pot)
//   --edge 0.05 (min EV per SOL)  --hold-min 25 (minutes before a churn exit)  --hold-max 720  --take 0.5  --stop 0.6
//   --park 0.2  --horizon 30 (days)  --hurdle-mult 1.5  --keeper-max 8 (keeper txs per pass)  --no-keeper
//   --create  --create-budget 0.3 (per day)  --seed 0.01 (each side after a listing)  --adopt (manage positions opened elsewhere)
//   --max-owed 0.1  never enter (and exit) a side whose curve is more than this fraction owed to the other pot: "owed" means the
//                next settle drains what buyers paid in, so a fresh buy there is a donation, not a position.
//   --no-volume  by default the script is written for volume: it takes the empty side at full clip even when that fills it, and
//                churns after --hold-min so the next entry lands wherever the empty side is then. --no-volume keeps the strict
//                Nash sizing (never close the gap past --target) and the --edge EV floor.
// Env: NASH_KEY (default ~/.x100/arena.json) · NASH_API (https://100x.broker) · NASH_RPC (default <api>/api/rpc) · BIRDEYE_KEY or ~/birdeye.key
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

let web3;
try {
  web3 = await import("@solana/web3.js");
} catch {
  console.error("missing dependency — run:  npm i @solana/web3.js   (in the folder that holds nash.mjs)");
  process.exit(2);
}
const { Connection, Keypair, VersionedTransaction } = web3;

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : isNaN(Number(v)) ? v : Number(v);
};
const LIVE = argv.includes("--live");
const LOOP = flag("loop", 0);
const P = {
  bank: flag("bank", 1.0), clip: flag("clip", 0.02), maxPos: flag("max-pos", 0.08),
  ratio: flag("ratio", 2), target: flag("target", 1.5), minOpp: flag("min-opp", 0.001), edge: flag("edge", 0.05),
  holdMin: flag("hold-min", 25), holdMax: flag("hold-max", 720), take: flag("take", 0.5), stop: flag("stop", 0.6),
  park: flag("park", 0.2), horizon: flag("horizon", 30), hurdleMult: flag("hurdle-mult", 1.5),
  keeper: !argv.includes("--no-keeper"), keeperMax: flag("keeper-max", 8),
  create: argv.includes("--create"), createBudget: flag("create-budget", 0.3), seed: flag("seed", 0.01), adopt: argv.includes("--adopt"),
  volume: !argv.includes("--no-volume"),
  maxOwed: flag("max-owed", 0.1),
};
const DUST = 0.0005; // a bag worth less than this is not worth a transaction and does not block the other side
const API = (process.env.NASH_API ?? "https://100x.broker").replace(/\/$/, "");
const KEY = process.env.NASH_KEY ?? join(homedir(), ".x100", "arena.json");
const RPC = process.env.NASH_RPC ?? `${API}/api/rpc`;
const STATE = join(dirname(KEY), "nash-state.json");
const LOG = join(dirname(KEY), "nash.log");
const RESERVE = 0.03; // SOL kept for fees and rent
const FEE_RT = 0.08; // 4% in + 4% out
const LEV = 100;
const conn = new Connection(RPC, "confirmed");

// ---------- plumbing ----------
const fmt = (n, d = 4) => (typeof n === "number" && isFinite(n) ? n.toFixed(d) : String(n));
const now = () => Math.floor(Date.now() / 1000);
const say = (s) => {
  console.log(s);
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`);
  } catch {}
};
function loadKey() {
  if (!existsSync(KEY)) throw new Error(`no wallet at ${KEY} (NASH_KEY)`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, "utf8"))));
}
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { entries: {}, parks: {}, created: [], keeper: {} };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 1));
async function api(path, body) {
  const r = await fetch(`${API}/api/arena${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => ({ error: `bad response ${r.status}` }));
  if (!r.ok || j.error) throw new Error(j.error ?? `api ${r.status}`);
  return j;
}
async function signAndSend(b64, kp) {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  tx.sign([kp]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3, preflightCommitment: "confirmed" });
  const until = Date.now() + 75_000;
  while (Date.now() < until) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`failed on chain ${JSON.stringify(st.err)} https://solscan.io/tx/${sig}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error(`not confirmed in time https://solscan.io/tx/${sig}`);
}
/** Execute a build result (tx or txs) if live; always logs. Returns the signatures. */
async function act(label, build, kp) {
  if (!LIVE) {
    say(`  · would ${label}`);
    return [];
  }
  const r = await build();
  const txs = r.txs ?? [r.tx];
  const sigs = [];
  for (let i = 0; i < txs.length; i++) {
    const sig = await signAndSend(txs[i], kp);
    sigs.push(sig);
    say(`  ✓ ${label}${txs.length > 1 ? ` (${i + 1}/${txs.length} ${r.steps?.[i] ?? ""})` : ""}  https://solscan.io/tx/${sig}`);
  }
  return sigs;
}

// ---------- the math ----------
/** Fraction the losing pot pays on a TWAP move of `d` (fraction): 1 − (1+d)^−100. 1% → 63%, 5% → 99%. */
const payFrac = (d) => 1 - Math.pow(1 + Math.abs(d), -LEV);
/** Our view from the oracle: spot vs TWAP. The TWAP has to travel toward spot, so spot above TWAP favours UP. */
function view(m) {
  const d = m.oracle.twap > 0 ? m.oracle.spot / m.oracle.twap - 1 : 0;
  const strength = Math.min(1, Math.abs(d) / 0.01); // a 1% gap is a full-strength signal
  return { d, favours: d > 0 ? 0 : d < 0 ? 1 : -1, strength, pWin: 0.5 + 0.15 * strength };
}
/** EV per SOL of taking `side` with `s` SOL given pots `mine` (our side) and `theirs`. */
function ev(s, mine, theirs, pWin, d) {
  const sIn = s * 0.96;
  const f = payFrac(Math.max(Math.abs(d), 0.002)); // at least a 0.2% move happens between reads
  const share = sIn / (mine + sIn);
  const win = f * theirs * share;
  const lose = f * sIn;
  return (pWin * win - (1 - pWin) * lose - FEE_RT * s) / s;
}

// ---------- one pass ----------
async function pass() {
  const kp = loadKey();
  const me = kp.publicKey.toBase58();
  const [list, book, vaultsR, work] = await Promise.all([api("?list=1"), api(`?who=${me}`), api("?vaults=1"), P.keeper ? api("?keeper=1") : null]);
  const markets = list.markets;
  const held = new Map(book.positions.filter((p) => p.worth_sol >= DUST).map((p) => [`${p.market}:${p.side === "DOWN" ? 1 : 0}`, p]));
  const parked = new Map((book.vaults ?? []).map((v) => [v.vault, v]));
  const mine = (p) => P.adopt || !!state.entries[`${p.market}:${p.side === "DOWN" ? 1 : 0}`];
  const atRisk = book.positions.filter(mine).reduce((a, p) => a + p.worth_sol, 0) + (book.vaults ?? []).filter((v) => P.adopt || !!state.parks[v.vault]).reduce((a, v) => a + v.worth_sol, 0);
  let free = Math.max(0, Math.min(book.sol - RESERVE, P.bank - atRisk));
  say(`— ${new Date().toISOString().slice(0, 16)}Z ${me.slice(0, 4)}…${me.slice(-4)} sol ${fmt(book.sol, 3)} · positions ${fmt(book.positions_sol, 3)} · vaults ${fmt(book.vaults_sol ?? 0, 3)} · free for seats ${fmt(free, 3)}${LIVE ? "" : " · DRY RUN"}`);
  const out = { me, sol: book.sol, actions: [] };
  const did = (a) => out.actions.push(a);

  // ---- exits first (frees bank, and churn is the volume) ----
  for (const p of book.positions) {
    const m = markets.find((x) => x.market === p.market);
    if (!m) continue;
    const side = p.side === "DOWN" ? 1 : 0;
    const key = `${p.market}:${side}`;
    const e = state.entries[key];
    if (!e && !P.adopt) continue; // not ours; leave it alone unless --adopt
    const mine = side ? m.down.pot_sol : m.up.pot_sol;
    const theirs = side ? m.up.pot_sol : m.down.pot_sol;
    const age = e ? (now() - e.ts) / 60 : Infinity;
    const basis = e?.sol ?? p.worth_sol;
    const owedMine = side ? m.down.owed ?? m.owed?.down ?? 0 : m.up.owed ?? m.owed?.up ?? 0;
    const why =
      p.worth_sol < DUST ? null // dust: not worth a tx
      : owedMine > P.maxOwed ? `our curve is ${fmt(owedMine * 100, 0)}% owed to the other pot; out before the settle`
      : mine >= theirs / P.target ? "side filled, multiple compressed"
      : theirs < P.minOpp ? "other pot drained, nothing left to win"
      : p.worth_sol >= basis * (1 + P.take) ? `take profit +${fmt((p.worth_sol / basis - 1) * 100, 0)}%`
      : p.worth_sol <= basis * (1 - P.stop) ? `stop −${fmt((1 - p.worth_sol / basis) * 100, 0)}%`
      : age >= P.holdMax ? "max hold"
      : age >= P.holdMin ? "churn: hold time up, re-enter where the empty side is now"
      : null;
    if (!why) continue;
    say(`exit ${m.symbol} ${p.side} ≈${fmt(p.worth_sol)} SOL (${p.via}) — ${why}`);
    try {
      const sigs = await act(`sell ${m.symbol} ${p.side}`, () => api("", { kind: "sell", market: p.market, side: p.side, pct: 100, payer: me }), kp);
      if (LIVE) {
        delete state.entries[key];
        held.delete(key);
        free += p.worth_sol * 0.96;
        did({ kind: "sell", market: m.symbol, side: p.side, sol: p.worth_sol, why, sigs });
      }
    } catch (err) {
      say(`  ✗ ${err.message}`);
    }
  }

  // ---- empty side ----
  const cands = [];
  const skipped = [];
  for (const m of markets) {
    if (m.oracle.thin || !(m.oracle.pool_tvl_usd >= (list.thin_oracle_usd ?? 25_000))) continue; // unknown depth counts as thin
    // a side's money = its pot (settled) + its curve reserve (paid in, not yet settled); both move on the next tick
    const up = m.up.pot_sol + (m.up.curve_rfstacc ?? 0), dn = m.down.pot_sol + (m.down.curve_rfstacc ?? 0);
    if (up + dn === 0) continue;
    const side = up <= dn ? 0 : 1;
    const mine = side ? dn : up, theirs = side ? up : dn;
    if (theirs < P.minOpp) continue;
    const owedMine = side ? m.down.owed ?? m.owed?.down ?? 0 : m.up.owed ?? m.owed?.up ?? 0;
    if (owedMine > P.maxOwed) {
      skipped.push(`${m.symbol} ${side ? "DOWN" : "UP"}: curve ${fmt(owedMine * 100, 0)}% owed, a buy there settles straight into the other pot`);
      continue;
    }
    if (held.has(`${m.market}:${side}`)) continue; // already on it; churn handles re-entry
    if (held.has(`${m.market}:${1 - side}`)) continue; // never both sides
    const ratio = mine > 0 ? theirs / mine : Infinity;
    if (ratio < P.ratio) continue;
    const v = view(m);
    const pWin = v.favours === side ? v.pWin : v.favours === -1 ? 0.5 : 1 - v.pWin;
    const room = Math.max(0, theirs / P.target - mine) / 0.96; // what keeps us the empty side
    const s = P.volume ? Math.min(P.clip, P.maxPos, free) : Math.min(P.clip, P.maxPos, room, free);
    if (s < 0.001) continue;
    const e = ev(s, mine, theirs, pWin, v.d);
    cands.push({ m, side, mine, theirs, ratio, s, e, pWin, d: v.d, fills: s > room });
  }
  cands.sort((a, b) => b.e - a.e);
  for (const c of cands) {
    const sideName = c.side ? "DOWN" : "UP";
    const line = `${c.m.symbol} ${sideName}: pots ${fmt(c.mine, 4)} vs ${fmt(c.theirs, 4)} (${isFinite(c.ratio) ? fmt(c.ratio, 1) + "×" : "empty"}), spot/twap ${fmt(c.d * 100, 2)}%, p ${fmt(c.pWin, 2)}, EV ${fmt(c.e * 100, 1)}%/SOL, size ${fmt(c.s, 3)}${c.fills ? " (fills the side)" : ""}`;
    if (!P.volume && c.e < P.edge) {
      say(`skip ${line} — below edge`);
      continue;
    }
    if (c.s > free) break;
    say(`enter ${line}`);
    try {
      const sigs = await act(`buy ${c.m.symbol} ${sideName} ${fmt(c.s, 3)}`, () => api("", { kind: "buy", market: c.m.market, side: sideName, sol: Number(c.s.toFixed(4)), payer: me }), kp);
      if (LIVE) {
        state.entries[`${c.m.market}:${c.side}`] = { ts: now(), sol: c.s, ticker: c.m.symbol, side: sideName };
        free -= c.s;
        did({ kind: "buy", market: c.m.symbol, side: sideName, sol: c.s, ev: c.e, sigs });
      }
    } catch (err) {
      say(`  ✗ ${err.message}`);
    }
  }
  for (const sk of skipped) say(`skip ${sk}`);
  if (!cands.length) say(`empty side: no deep-oracle market with a ≥${P.ratio}× gap, ≥${P.minOpp} SOL to win, an un-owed curve, that we are not already on`);

  // ---- park ----
  const hurdle = (FEE_RT * P.hurdleMult) / (P.horizon / 365); // simple APR that clears the round trip over the horizon
  for (const v of vaultsR.vaults) {
    const w = work?.vaults?.find((x) => x.vault === v.vault);
    const have = parked.get(v.vault);
    const ours = state.parks[v.vault];
    const apr = v.pace?.apr ?? null;
    if (have && (ours || P.adopt)) {
      const basis = ours?.sol ?? have.worth_sol;
      const why =
        have.worth_sol < 0.002 ? null
        : have.worth_sol <= basis * (1 - 0.05) ? `receipt down ${fmt((1 - have.worth_sol / basis) * 100, 1)}%`
        : apr !== null && apr < hurdle / 2 ? `pace ${fmt(apr * 100, 0)}% fell under half the hurdle (${fmt((hurdle / 2) * 100, 0)}%)`
        : w?.outside_band && ours && now() - (ours.ts ?? 0) > 3600 && (state.keeper[`band:${v.vault}`] ?? 0) >= 2 ? `hedge ${w.hedge_error_bps}bps outside band for ${state.keeper[`band:${v.vault}`]} passes`
        : null;
      state.keeper[`band:${v.vault}`] = w?.outside_band ? (state.keeper[`band:${v.vault}`] ?? 0) + 1 : 0;
      if (why) {
        say(`unpark ${v.symbol} ≈${fmt(have.worth_sol)} SOL — ${why}`);
        try {
          const sigs = await act(`unpark ${v.symbol}`, () => api("", { kind: "unpark", vault: v.vault, pct: 100, payer: me }), kp);
          if (LIVE) {
            delete state.parks[v.vault];
            free += have.worth_sol * 0.96;
            did({ kind: "unpark", vault: v.symbol, sol: have.worth_sol, why, sigs });
          }
        } catch (err) {
          say(`  ✗ ${err.message}`);
        }
      }
      continue;
    }
    if (have) continue; // someone else's park (no --adopt)
    const reasons = [];
    if (apr === null) reasons.push("pace still warming");
    else if (apr < hurdle) reasons.push(`pace ${fmt(apr * 100, 0)}% < hurdle ${fmt(hurdle * 100, 0)}% (8% × ${P.hurdleMult} over ${P.horizon}d)`);
    if (w && w.outside_band) reasons.push(`hedge ${w.hedge_error_bps}bps outside band ${w.band_bps}`);
    if (v.tvl_sol < 0.3) reasons.push(`tvl ${fmt(v.tvl_sol, 2)} SOL cannot hold a position`);
    const s = Math.min(P.park, free, v.tvl_sol); // never more than the vault already holds: we would be the vault
    if (s < 0.01) reasons.push("no free bank");
    if (reasons.length) {
      say(`no park ${v.symbol}: ${reasons.join("; ")}`);
      continue;
    }
    say(`park ${v.symbol} ${fmt(s, 3)} SOL — pace ${fmt(apr * 100, 0)}% clears ${fmt(hurdle * 100, 0)}%`);
    try {
      const sigs = await act(`park ${v.symbol} ${fmt(s, 3)}`, () => api("", { kind: "park", vault: v.vault, sol: Number(s.toFixed(4)), payer: me }), kp);
      if (LIVE) {
        state.parks[v.vault] = { ts: now(), sol: s };
        free -= s;
        did({ kind: "park", vault: v.symbol, sol: s, sigs });
      }
    } catch (err) {
      say(`  ✗ ${err.message}`);
    }
  }

  // ---- keeper ----
  if (work) {
    const jobs = [];
    for (const m of work.markets) {
      const pri = held.has(`${m.market}:0`) || held.has(`${m.market}:1`) ? 0 : 1;
      if (m.poke && m.poke.amount_rfstacc >= 0.0001) jobs.push({ pri, label: `poke ${m.ticker} (${m.poke.pays} pays ${fmt(m.poke.amount_rfstacc)})`, body: { kind: "poke", market: m.market } });
      const row = markets.find((x) => x.market === m.market);
      for (const [sd, owed, side] of [["UP", m.settle.up_owed, row?.up], ["DOWN", m.settle.down_owed, row?.down]]) {
        if (owed <= 0.001) continue;
        if (side && (side.at_floor || (side.curve_rfstacc ?? 1) < 0.0001)) continue; // owed but the curve is empty: nothing a settle could sell
        jobs.push({ pri: pri + 0.5, label: `settle ${m.ticker} ${sd} (${fmt(owed * 100, 1)}% owed)`, body: { kind: "settle", market: m.market, side: sd } });
      }
      for (const [sd, un] of [["UP", m.claim.up_rfstacc], ["DOWN", m.claim.down_rfstacc]]) if (un > 0.001) jobs.push({ pri: pri + 0.7, label: `claim ${m.ticker} ${sd} (${fmt(un)} r-fstacc)`, body: { kind: "claim", market: m.market, side: sd } });
    }
    jobs.sort((a, b) => a.pri - b.pri);
    let n = 0;
    for (const j of jobs) {
      if (n >= P.keeperMax) break;
      say(`keeper: ${j.label}`);
      try {
        const sigs = await act(j.label, () => api("", { ...j.body, payer: me }), kp);
        n++;
        if (LIVE) did({ kind: j.body.kind, label: j.label, sigs });
      } catch (err) {
        say(`  ✗ ${err.message}`);
      }
    }
    if (!jobs.length) say("keeper: nothing pending");
  }

  // ---- creator ----
  if (P.create) await createSeat(kp, me, markets, free, did);

  save();
  say(`= ${out.actions.length} action(s)${LIVE ? "" : " (dry run)"}`);
  console.log(JSON.stringify({ ok: true, live: LIVE, ...out }));
}

async function createSeat(kp, me, markets, free, did) {
  const spent = state.created.filter((c) => now() - c.ts < 86_400).reduce((a, c) => a + (c.sol ?? 0.25), 0);
  if (spent + 0.25 > P.createBudget) return say(`creator: ${fmt(spent, 2)} of ${P.createBudget} SOL listing budget used today`);
  if (free < 0.45) return say("creator: a listing needs ~0.25 SOL rent plus seeds; not enough free bank");
  let key = process.env.BIRDEYE_KEY;
  if (!key) {
    const f = join(homedir(), "birdeye.key");
    if (existsSync(f)) key = readFileSync(f, "utf8").trim();
  }
  if (!key) return say("creator: no BIRDEYE_KEY (or ~/birdeye.key); cannot read what is trending");
  const r = await fetch("https://public-api.birdeye.so/defi/token_trending?sort_by=volume24hUSD&sort_type=desc&offset=0&limit=20", { headers: { "X-API-KEY": key, "x-chain": "solana" } });
  const j = await r.json().catch(() => null);
  if (!j?.success) return say(`creator: birdeye said ${JSON.stringify(j).slice(0, 120)}`);
  const listed = new Set(markets.map((m) => m.mint));
  const skip = new Set(["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
  for (const t of j.data.tokens) {
    if (listed.has(t.address) || skip.has(t.address)) continue;
    let pools;
    try {
      pools = await api(`?pools=${t.address}`);
    } catch (e) {
      say(`creator: ${t.symbol}: ${e.message}`);
      continue;
    }
    if (pools.pools.some((p) => p.markets.length)) continue; // listed under another oracle
    const oracle = pools.pools.find((p) => p.quote === "SOL" && p.oracle_ok && p.tvl_usd >= 100_000);
    if (!oracle) {
      say(`creator: ${t.symbol} trending ($${Math.round(t.volume24hUSD / 1e6)}M/24h) but no deep SOL CLMM pool with a live oracle`);
      continue;
    }
    say(`create ${t.symbol} (${t.address}) on ${oracle.pool} — trending #${t.rank}, $${Math.round(t.volume24hUSD / 1e6)}M/24h, pool $${Math.round(oracle.tvl_usd / 1000)}k`);
    if (!LIVE) {
      say("  · would create-market (4 txs), create-vault, seed UP and DOWN " + P.seed + " SOL each");
      return;
    }
    try {
      let k;
      let market;
      for (let round = 0; round < 4; round++) {
        const res = await api("", { kind: "create-market", pool: oracle.pool, keys: k, payer: me });
        k = res.keys;
        market = res.summary.market;
        state.created.push({ ts: now(), mint: t.address, symbol: t.symbol, market, keys: k, sol: 0.25, done: false });
        save();
        for (let i = 0; i < res.txs.length; i++) {
          const sig = await signAndSend(res.txs[i], kp);
          say(`  ✓ ${res.steps[i]}  https://solscan.io/tx/${sig}`);
        }
        if (!res.more) break;
        await new Promise((r) => setTimeout(r, 2500));
      }
      state.created[state.created.length - 1].done = true;
      say(`  live: ${API}/m/${market}`);
      did({ kind: "create-market", symbol: t.symbol, market });
      try {
        const cv = await api("", { kind: "create-vault", market, payer: me });
        for (const tx of cv.txs) say(`  ✓ vault  https://solscan.io/tx/${await signAndSend(tx, kp)}`);
        did({ kind: "create-vault", vault: cv.summary.vault });
      } catch (e) {
        say(`  ✗ vault: ${e.message}`);
      }
      if (P.seed >= 0.001) {
        await new Promise((r) => setTimeout(r, 4000));
        for (const side of ["UP", "DOWN"]) {
          try {
            const b = await api("", { kind: "buy", market, side, sol: P.seed, payer: me });
            say(`  ✓ seed ${side}  https://solscan.io/tx/${await signAndSend(b.tx, kp)}`);
            did({ kind: "seed", market, side, sol: P.seed });
          } catch (e) {
            say(`  ✗ seed ${side}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      say(`  ✗ listing stopped: ${e.message} — resume with the same keys from ${STATE}`);
    }
    return; // one listing per pass
  }
  say("creator: everything trending with a deep SOL pool is already listed");
}

// ---------- run ----------
for (;;) {
  try {
    await pass();
  } catch (e) {
    say(`✗ pass failed: ${e.message}`);
    if (!LOOP) process.exit(1);
  }
  if (!LOOP) break;
  await new Promise((r) => setTimeout(r, LOOP * 1000));
}
