// Coins with no market yet, one tap to list. Same /api/runners feed as the board strip; only coins with an oracle-able pool and
// no existing market are offered. With a category picked (Memes · Majors · Stonks, the `cat` query param) the feed is that
// category's own universe — /api/runners?cat=stonk is every tokenized stock by 24 h volume, not just what is trending.
import { Link } from "react-router-dom";
import { usePoll } from "../hooks";
import { Delta } from "./Pulse";
import { CatFilter, useCat, type Counts } from "./CatFilter";
import { CAT_LABEL, CAT_PLURAL, type Cat, type Category } from "../lib/category";

type Pick = { mint: string; symbol: string; logo: string | null; chg24: number | null; vol24: number | null; pump: boolean; category: Category; market: unknown; listable: unknown; venue_hint: string | null };

async function fetchFeed(cat: Cat | null): Promise<Pick[]> {
  const r = await fetch(cat ? `/api/runners?cat=${cat}` : "/api/runners");
  if (!r.ok) throw new Error(`runners ${r.status}`);
  const j = (await r.json()) as { runners?: Pick[] };
  return j.runners ?? [];
}
/** Unlisted, biggest 24h volume first — the one with the most flow is the one to list. */
const unlisted = (rows: Pick[]) => rows.filter((p) => !p.market && p.listable).sort((a, b) => (b.vol24 ?? 0) - (a.vol24 ?? 0));

const vol = (n: number | null) => (n !== null && n > 0 ? `$${n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: n >= 1e5 ? 1 : 0 })}` : null);

const MAX = 8;
const NONE: Pick[] = [];

export function RunnerPicks({ current, onPick }: { current: string; onPick: (mint: string) => void }) {
  const [cat, setCat] = useCat();
  // trending always (it is what the counts are about); the category's own feed when one is picked
  const trend = usePoll(() => fetchFeed(null), [], 60_000);
  const own = usePoll(() => (cat ? fetchFeed(cat) : Promise.resolve(NONE)), [cat], 60_000);
  const base = unlisted(trend.data ?? NONE);
  const counts: Counts = { all: base.length, meme: 0, major: 0, stonk: 0 };
  for (const p of base) if (p.category === "meme" || p.category === "major" || p.category === "stonk") counts[p.category]++;
  // usePoll keeps the last rows across a cat switch; `loading` is true until the new cat's first fetch lands
  const ownRows = cat && !own.loading && own.data ? own.data : null;
  const rows = cat ? unlisted(ownRows ?? NONE) : base;
  // the category's feed may hold more than trending does: the chip says what the list will show
  if (cat && ownRows) counts[cat] = rows.length;
  const picks = rows.filter((p) => p.mint !== current).slice(0, MAX);
  if (!trend.data && !ownRows) return null;
  if (picks.length === 0 && !cat) return null;
  const allListed = !!cat && !!ownRows && ownRows.length > 0 && rows.length === 0;
  return (
    <div className="picks" aria-label="Coins without a market">
      <span className="meta picks-head">
        <span className="live-dot" aria-hidden /> {cat ? CAT_LABEL[cat] : "Running"} · unlisted · by volume
        <CatFilter cat={cat} onChange={setCat} counts={counts} />
      </span>
      {picks.length === 0 ? (
        <p className="meta cat-empty">
          {allListed ? (
            <>
              Every {cat === "stonk" ? "stonk" : cat === "major" ? "major" : "meme"} listed ·{" "}
              <Link to={`/?cat=${cat}`} className="runners-cta">
                trade one →
              </Link>
            </>
          ) : !ownRows ? (
            "looking…"
          ) : (
            `No ${CAT_PLURAL[cat!]} with a pool · paste a CA`
          )}
        </p>
      ) : (
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
      )}
    </div>
  );
}

export default RunnerPicks;
