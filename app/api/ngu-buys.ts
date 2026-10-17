// /api/ngu-buys — every $NGU buy (not-a-presale or direct), what it cost, what it's worth now, and how long it sat
// underwater: from the buy until its NGU × SOL-per-NGU × (1 − sell fee) first covered the SOL paid. Plus per-holder
// totals and min / max / mean / median of the underwater time, measured from the rate history.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { NGU } from "../src/ngu.js";
import { nguHistory, sellFeeBps, type Point } from "./_lib/nguHistory.js";

const stats = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0], max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length, median: s[Math.floor(s.length / 2)], n: s.length };
};

function recoveredAt(points: Point[], t0: number, lamports: number, ngu: number, keep: number): number | null {
  for (const [t, rate] of points) if (t >= t0 && ngu * rate * keep >= lamports) return t;
  return null;
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  if (!NGU.mint || !NGU.stakePool || !NGU.state) return res.status(404).json({ error: "NGU not launched" });
  try {
    const [h, fee] = await Promise.all([nguHistory(), sellFeeBps()]);
    const keep = 1 - fee / 10000;
    const now = Math.floor(Date.now() / 1000);
    const rate = h.points.at(-1)?.[1] ?? 1;
    const buys = h.buys.map((b) => {
      const back = recoveredAt(h.points, b.t, b.lamports, b.ngu, keep);
      const valueNow = b.ngu * rate * keep;
      return {
        sig: b.sig, t: b.t, wallet: b.wallet, via: b.via,
        sol: b.lamports / 1e9, ngu: b.ngu / 1e9, entry_rate: b.lamports / b.ngu,
        value_now_sol: valueNow / 1e9, pnl_pct: (valueNow / b.lamports - 1) * 100,
        underwater: back === null, recovered_at: back, underwater_secs: (back ?? now) - b.t,
      };
    });
    const holders = new Map<string, { wallet: string; buys: number; sol: number; ngu: number; value_now_sol: number; underwater_buys: number }>();
    for (const b of buys) {
      const x = holders.get(b.wallet) ?? { wallet: b.wallet, buys: 0, sol: 0, ngu: 0, value_now_sol: 0, underwater_buys: 0 };
      x.buys++; x.sol += b.sol; x.ngu += b.ngu; x.value_now_sol += b.value_now_sol; x.underwater_buys += b.underwater ? 1 : 0;
      holders.set(b.wallet, x);
    }
    res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=300");
    return res.status(200).json({
      now, rate, sell_fee_bps: fee,
      breakeven_rise_pct: (1 / keep - 1) * 100, // on top of the buy fee already reflected in each buy's NGU
      underwater_secs: {
        recovered: stats(buys.filter((b) => !b.underwater).map((b) => b.underwater_secs)),
        still_under: stats(buys.filter((b) => b.underwater).map((b) => b.underwater_secs)),
        all: stats(buys.map((b) => b.underwater_secs)),
      },
      holders: [...holders.values()].map((x) => ({ ...x, pnl_pct: (x.value_now_sol / x.sol - 1) * 100 })).sort((a, b) => b.sol - a.sol),
      buys: buys.reverse(),
    });
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
