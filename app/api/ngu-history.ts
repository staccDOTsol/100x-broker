// /api/ngu-history — SOL per $NGU after every transaction that moved it, launch to now (see _lib/nguHistory.ts), plus
// the rate's growth annualized over trailing windows: simple (APR) and compounded (APY).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { NGU } from "../src/ngu.js";
import { nguHistory, type Point } from "./_lib/nguHistory.js";

const YEAR = 365 * 24 * 3600;
const WINDOWS: [string, number | null][] = [["1h", 3600], ["24h", 86400], ["7d", 7 * 86400], ["30d", 30 * 86400], ["since_launch", null]];

/** The rate in force at time t: the history is a step function, each point holding until the next transaction. */
function rateAt(points: Point[], t: number) {
  let r = points[0][1];
  for (const [pt, pr] of points) {
    if (pt > t) break;
    r = pr;
  }
  return r;
}

/** Growth of SOL per NGU over each trailing window, annualized two ways. A window the history doesn't cover yet is
 *  null. APR = growth × (year / window). APY = (1 + growth)^(year / window) − 1, null when that overflows a double. */
function yieldOf(points: Point[]) {
  const [t1, r1] = points[points.length - 1];
  const t0 = points[0][0];
  const out: Record<string, unknown> = {};
  for (const [k, w] of WINDOWS) {
    const from = w == null ? t0 : t1 - w;
    if (from < t0 || t1 <= from) {
      out[k] = null;
      continue;
    }
    const r0 = rateAt(points, from), secs = t1 - from, growth = r1 / r0 - 1;
    const apy = Math.pow(r1 / r0, YEAR / secs) - 1;
    out[k] = {
      from, secs, rate_from: r0, rate_to: r1,
      growth_pct: growth * 100,
      apr_pct: growth * (YEAR / secs) * 100,
      apy_pct: Number.isFinite(apy) ? apy * 100 : null,
    };
  }
  return out;
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  if (!NGU.mint || !NGU.stakePool || !NGU.state) return res.status(404).json({ error: "NGU not launched" });
  try {
    const h = await nguHistory();
    res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=300");
    return res.status(200).json({ points: h.points, yield: h.points.length ? yieldOf(h.points) : null });
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
