// TradingView datafeed for SOL per $NGU. Points come from /api/ngu-history (one per transaction that moved the rate);
// bars carry the last rate forward through quiet periods, so the chart is the step line the rate actually is.
type Point = [number, number];
type Bar = { time: number; open: number; high: number; low: number; close: number };

const RESOLUTIONS = ["1", "5", "15", "60", "240", "1D"];
const seconds = (res: string) => (res.endsWith("D") ? Number(res.slice(0, -1) || 1) * 86400 : Number(res) * 60);

let cache: { at: number; points: Point[] } | null = null;
async function points(maxAgeMs = 15_000): Promise<Point[]> {
  if (cache && cache.points.length && Date.now() - cache.at < maxAgeMs) return cache.points;
  // An empty or failed answer is retried: TradingView never re-asks after "no data".
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`/api/ngu-history${i ? `?r=${Date.now()}` : ""}`).catch(() => null);
    const j = r?.ok ? ((await r.json()) as { points: Point[] }) : null;
    if (j?.points?.length) {
      cache = { at: Date.now(), points: j.points };
      return j.points;
    }
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  throw new Error("history unavailable");
}

function bars(pts: Point[], res: string, from: number, to: number): Bar[] {
  if (!pts.length) return [];
  const step = seconds(res);
  const out: Bar[] = [];
  let i = 0;
  let last = pts[0][1];
  const start = Math.max(Math.floor(pts[0][0] / step) * step, Math.floor(from / step) * step);
  // rate in effect at the first bucket
  while (i < pts.length && pts[i][0] < start) last = pts[i++][1];
  for (let t = start; t < to; t += step) {
    const open = last;
    let high = open, low = open;
    while (i < pts.length && pts[i][0] < t + step) {
      last = pts[i++][1];
      high = Math.max(high, last);
      low = Math.min(low, last);
    }
    out.push({ time: t * 1000, open, high, low, close: last });
  }
  return out;
}

export function nguDatafeed() {
  const subs = new Map<string, ReturnType<typeof setInterval>>();
  return {
    onReady: (cb: (c: object) => void) => setTimeout(() => cb({ supported_resolutions: RESOLUTIONS, supports_time: true }), 0),
    searchSymbols: (_q: string, _e: string, _t: string, cb: (r: object[]) => void) => cb([]),
    resolveSymbol: (_name: string, ok: (s: object) => void) =>
      setTimeout(
        () =>
          ok({
            name: "NGU",
            ticker: "NGU",
            description: "SOL per $NGU",
            type: "crypto",
            session: "24x7",
            timezone: "Etc/UTC",
            exchange: "100x.broker",
            listed_exchange: "100x.broker",
            format: "price",
            minmov: 1,
            pricescale: 1_000_000,
            has_intraday: true,
            has_daily: true,
            visible_plots_set: "ohlc",
            supported_resolutions: RESOLUTIONS,
            volume_precision: 0,
            data_status: "streaming",
          }),
        0,
      ),
    getBars: async (
      _s: object,
      res: string,
      p: { from: number; to: number; firstDataRequest: boolean },
      ok: (b: Bar[], meta: { noData: boolean }) => void,
      err: (e: string) => void,
    ) => {
      try {
        const pts = await points(p.firstDataRequest ? 0 : 15_000);
        const b = bars(pts, res, p.from, p.to);
        ok(b, { noData: b.length === 0 && (!pts.length || p.to < pts[0][0]) });
      } catch (e) {
        err(e instanceof Error ? e.message : String(e));
      }
    },
    subscribeBars: (_s: object, res: string, onTick: (b: Bar) => void, uid: string) => {
      const tick = async () => {
        const pts = await points(0).catch(() => null);
        if (!pts?.length) return;
        const now = Math.floor(Date.now() / 1000), step = seconds(res);
        const b = bars(pts, res, now - step, now + 1).at(-1);
        if (b) onTick(b);
      };
      subs.set(uid, setInterval(tick, 20_000));
    },
    unsubscribeBars: (uid: string) => {
      clearInterval(subs.get(uid));
      subs.delete(uid);
    },
  };
}
