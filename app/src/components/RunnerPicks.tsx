// Trending coins with no market yet, one tap to list. Same /api/runners feed as the board strip; only coins with an
// oracle-able pool and no existing market are offered. Renders nothing when the feed is empty.
import { usePoll } from "../hooks";
import { Delta } from "./Pulse";

type Pick = { mint: string; symbol: string; logo: string | null; chg24: number | null; vol24: number | null; pump: boolean; market: unknown; listable: unknown; venue_hint: string | null };

/** Unlisted runners, biggest 24h volume first — the one with the most flow is the one to list. */
async function fetchPicks(): Promise<Pick[]> {
  const r = await fetch("/api/runners");
  if (!r.ok) throw new Error(`runners ${r.status}`);
  const j = (await r.json()) as { runners?: Pick[] };
  return (j.runners ?? [])
    .filter((p) => !p.market && p.listable)
    .sort((a, b) => (b.vol24 ?? 0) - (a.vol24 ?? 0));
}

const vol = (n: number | null) => (n !== null && n > 0 ? `$${n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: n >= 1e5 ? 1 : 0 })}` : null);

const MAX = 8;

export function RunnerPicks({ current, onPick }: { current: string; onPick: (mint: string) => void }) {
  const { data } = usePoll(fetchPicks, [], 60_000);
  const picks = (data ?? []).filter((p) => p.mint !== current).slice(0, MAX);
  if (picks.length === 0) return null;
  return (
    <div className="picks" aria-label="Trending coins without a market">
      <span className="meta picks-head">
        <span className="live-dot" aria-hidden /> Running · unlisted · by volume
      </span>
      <div className="picks-row">
        {picks.map((p, i) => (
          <button key={p.mint} type="button" className={`pick${p.pump ? " pump" : ""}${i === 0 ? " top" : ""}`} onClick={() => onPick(p.mint)} title={`List $${p.symbol}${vol(p.vol24) ? ` · ${vol(p.vol24)} / 24h` : ""}`}>
            {p.logo && <img className="tokimg" src={p.logo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = "none")} />}
            <b>${p.symbol}</b>
            <span className="num">
              <Delta x={(p.chg24 ?? 0) / 100} dp={0} />
            </span>
            {vol(p.vol24) && <span className="num muted">{vol(p.vol24)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export default RunnerPicks;
