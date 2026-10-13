// /api/winners -> every realized win on 100x.broker, all time: UP/DOWN exits and vault unparks that paid more than they cost,
// plus `race`: the 24h net-P&L race (humans and agents alike), `boards`: net P&L per wallet over 24h / 7d / 30d / all time,
// and `refs`: referral earnings per referrer over the same windows (api/_lib/refs.ts).
// Baseline from api/_data/winners.json (tools/winners-build.ts), plus an incremental scan of what landed since, cached per instance.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readFileSync } from "fs";
import path from "path";
import { emptyState, rfstaccRate, scanWinners, type WinState } from "./_lib/winners.js";
import { emptyRefs, scanRefs, type RefState } from "./_lib/refs.js";

let mem: { at: number; st: WinState } | null = null;
let inflight: Promise<WinState> | null = null;
const TTL = 90_000;

function baseline(): WinState {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), "api", "_data", "winners.json"), "utf8")) as WinState;
  } catch {
    return emptyState();
  }
}
async function state(): Promise<WinState> {
  if (mem && Date.now() - mem.at < TTL) return mem.st;
  if (!inflight) {
    inflight = scanWinners(mem?.st ?? baseline(), { maxPerAccount: 400 })
      .then((st) => {
        mem = { at: Date.now(), st };
        return st;
      })
      .finally(() => {
        inflight = null;
      });
  }
  // serve what we have while the first scan of this instance runs, if it takes too long
  if (mem) return Promise.race([inflight, new Promise<WinState>((r) => setTimeout(() => r(mem!.st), 4_000))]);
  return inflight;
}

let rmem: { at: number; st: RefState } | null = null;
let rinflight: Promise<RefState> | null = null;
function refBaseline(): RefState {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), "api", "_data", "refs.json"), "utf8")) as RefState;
  } catch {
    return emptyRefs();
  }
}
async function refState(): Promise<RefState> {
  if (rmem && Date.now() - rmem.at < TTL) return rmem.st;
  if (!rinflight) {
    rinflight = scanRefs(rmem?.st ?? refBaseline(), { maxSigs: 2000 })
      .then((st) => {
        rmem = { at: Date.now(), st };
        return st;
      })
      .catch(() => rmem?.st ?? refBaseline()) // a flaky RPC leaves the referral board stale, not broken
      .finally(() => {
        rinflight = null;
      });
  }
  if (rmem) return Promise.race([rinflight, new Promise<RefState>((r) => setTimeout(() => r(rmem!.st), 4_000))]);
  return rinflight;
}

const WINDOWS = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, all: Infinity } as const;
function refBoard(st: RefState, start: number, rate: number) {
  const by = new Map<string, { wallet: string; earned_sol: number; referred_sol: number; deposits: number; funders: Set<string>; last: number }>();
  for (const h of st.hits) {
    if (h.ts < start) continue;
    const b = by.get(h.referrer) ?? { wallet: h.referrer, earned_sol: 0, referred_sol: 0, deposits: 0, funders: new Set<string>(), last: h.ts };
    b.earned_sol += (h.fee / 1e9) * rate;
    b.referred_sol += h.lamports / 1e9;
    b.deposits++;
    b.funders.add(h.funder);
    b.last = Math.max(b.last, h.ts);
    by.set(h.referrer, b);
  }
  return [...by.values()]
    .sort((x, y) => y.earned_sol - x.earned_sol || y.referred_sol - x.referred_sol)
    .slice(0, 50)
    .map(({ funders, ...b }) => ({ ...b, referred_wallets: funders.size }));
}

/** The 24h race: net realized P&L per wallet (wins minus losses, exits + unparks) inside a 24h window. Any on-chain actor counts,
 *  humans or agents; only the house keeper and the vaults' own PDAs are excluded (botAddresses). Rounds are listed here by hand. */
const ROUNDS: { end: number; prizes_sol: number[] }[] = [
  { end: Date.UTC(2026, 9, 14, 3, 0, 0) / 1000, prizes_sol: [4, 2, 1] }, // 2026-10-13 23:00 ET: 1st/2nd/3rd
];
const DAY = 86400;
type Row = { gain_sol: number; ts: number; wallet: string; sig: string; ref?: boolean };
function board(rows: Row[], start: number, end: number) {
  const by = new Map<string, { wallet: string; net_sol: number; won_sol: number; lost_sol: number; ref_sol: number; trades: number; best_sol: number; best_sig: string; first: number; last: number }>();
  for (const r of rows) {
    if (r.ts < start || r.ts >= end) continue;
    const b = by.get(r.wallet) ?? { wallet: r.wallet, net_sol: 0, won_sol: 0, lost_sol: 0, ref_sol: 0, trades: 0, best_sol: 0, best_sig: "", first: r.ts, last: r.ts };
    b.net_sol += r.gain_sol;
    if (r.ref) {
      // referral fees count toward net P&L but are not trades
      b.ref_sol += r.gain_sol;
      b.last = Math.max(b.last, r.ts);
      by.set(r.wallet, b);
      continue;
    }
    if (r.gain_sol > 0) b.won_sol += r.gain_sol;
    else b.lost_sol -= r.gain_sol;
    b.trades++;
    if (r.gain_sol > b.best_sol) {
      b.best_sol = r.gain_sol;
      b.best_sig = r.sig;
    }
    b.first = Math.min(b.first, r.ts);
    b.last = Math.max(b.last, r.ts);
    by.set(r.wallet, b);
  }
  // ties go to whoever got there first
  return [...by.values()].sort((x, y) => y.net_sol - x.net_sol || x.last - y.last);
}
function race(rows: Row[], now: number, scanned: number) {
  const live = ROUNDS.find((r) => now < r.end);
  const done = [...ROUNDS].reverse().find((r) => now >= r.end);
  const round = (r: { end: number; prizes_sol: number[] }) => ({
    start: r.end - DAY,
    end: r.end,
    prizes_sol: r.prizes_sol,
    prize_sol: r.prizes_sol.reduce((a, b) => a + b, 0),
    final: now >= r.end && scanned >= r.end,
    leaders: board(rows, r.end - DAY, r.end).slice(0, 50),
  });
  return {
    rule: "net realized SOL P&L per wallet inside the round's 24h: UP/DOWN exits + vault unparks (wins minus losses) plus referral fees earned; any on-chain actor; house keeper and vault PDAs excluded; ties to the earlier finisher",
    live: live ? round(live) : null,
    last: done ? round(done) : null,
    rolling: live ? null : board(rows, now - DAY, now + 1).slice(0, 50),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const [st, rate, rst] = await Promise.all([state(), rfstaccRate(), refState()]);
    const wins = st.wins.map((w) => {
      const f = w.unit === "rfstacc" ? rate : 1;
      return { ...w, cost_sol: w.cost * f, out_sol: w.out * f, gain_sol: w.gain * f, per_hour_sol: w.hold_s > 0 ? (w.gain * f) / (w.hold_s / 3600) : null };
    });
    const total = wins.reduce((a, w) => a + w.gain_sol, 0);
    const losses = (st.losses ?? []).map((w) => ({ ...w, gain_sol: w.gain * (w.unit === "rfstacc" ? rate : 1) }));
    const now = Math.floor(Date.now() / 1000);
    const refRows = rst.hits.map((h) => ({ gain_sol: (h.fee / 1e9) * rate, ts: h.ts, wallet: h.referrer, sig: h.sig, ref: true }));
    const rows = [...wins, ...losses, ...refRows];
    res.setHeader("cache-control", "public, max-age=30, s-maxage=60, stale-while-revalidate=600").json({
      at: st.at,
      rate,
      count: wins.length,
      wallets: new Set(wins.map((w) => w.wallet)).size,
      total_sol: total,
      exits: wins.filter((w) => w.kind === "exit").length,
      unparks: wins.filter((w) => w.kind === "unpark").length,
      race: race(rows, now, Math.min(st.at, rst.at)),
      boards: Object.fromEntries(Object.entries(WINDOWS).map(([k, s]) => [k, board(rows, now - s, now + 1).slice(0, 50)])),
      refs: { at: rst.at, ...Object.fromEntries(Object.entries(WINDOWS).map(([k, s]) => [k, refBoard(rst, now - s, rate)])) },
      wins,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "winners failed" });
  }
}
