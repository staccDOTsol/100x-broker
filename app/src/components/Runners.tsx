// Runners — what's trending on Solana right now (/api/runners, Birdeye), one card each, one door each: trade it here already,
// list it in a click, or not yet. Markets first, then listable coins, then the rest; nothing at all when the server has nothing.
import { Link } from "react-router-dom";
import { usePoll } from "../hooks";
import { Delta } from "./Pulse";
import { Tweet } from "./Share";
import { lev } from "../lib/format";

type Runner = {
  mint: string;
  symbol: string;
  name: string;
  logo: string | null;
  price: number | null;
  mc: number | null;
  vol24: number | null;
  chg24: number | null; // percent
  liq: number | null;
  rank: number | null;
  pump: boolean;
  market: { key: string; levUp: number | null; levDown: number | null } | null;
  listable: { id: string; quote: string; tvl: number } | null;
  venue_hint: "clmm" | "pumpswap" | null;
};
type Payload = { at?: number; runners?: Runner[]; error?: string };

const MAX = 16;

async function fetchRunners(): Promise<Runner[]> {
  const r = await fetch("/api/runners");
  if (!r.ok) throw new Error(`runners ${r.status}`);
  const j = (await r.json()) as Payload;
  return Array.isArray(j.runners) ? j.runners : [];
}

/** $1.2M · $340K · $12.5B — market caps are read at a glance, not to the cent. */
const mcap = (n: number | null) => (n !== null && n > 0 ? `$${n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: n >= 1e5 ? 1 : 0 })}` : "—");
const tier = (r: Runner) => (r.market ? 0 : r.listable ? 1 : 2);
// lev() takes NaN as "—"; the server sends null for that case
const levOf = (x: number | null) => lev(x === null ? NaN : x);

export function Runners() {
  const { data } = usePoll(fetchRunners, [], 30_000);
  if (!data || data.length === 0) return null;
  const cards = data
    .map((r, i) => ({ r, i }))
    .sort((a, b) => tier(a.r) - tier(b.r) || a.i - b.i)
    .slice(0, MAX)
    .map((x) => x.r);
  const tradable = cards.filter((r) => r.market).length;
  const listable = cards.filter((r) => !r.market && r.listable).length;
  return (
    <section className="runners" aria-label="Trending coins">
      <h2 className="meta runners-head">
        <span className="live-dot" aria-hidden />
        Runners · trending now
        <span className="right num">
          {tradable ? `${tradable} live` : ""}
          {tradable && listable ? " · " : ""}
          {listable ? (
            <Link to="/new" className="runners-cta">
              {listable} unlisted · be first →
            </Link>
          ) : null}
        </span>
      </h2>
      <div className="runners-strip">
        {cards.map((r) => (
          <RunnerCard key={r.mint} r={r} />
        ))}
      </div>
    </section>
  );
}

function RunnerCard({ r }: { r: Runner }) {
  const chg = r.chg24 ?? 0;
  const path = r.market ? `/m/${r.market.key}` : `/new?mint=${r.mint}`;
  const text = `$${r.symbol} is running (${chg >= 0 ? "+" : ""}${chg.toFixed(1)}% 24h) — ${r.market ? "trade it ±100×" : "list it"} on 100x.broker`;
  return (
    <article className={`runner ${r.market ? "live" : r.listable ? "ready" : "wait"}`}>
      <div className="runner-head">
        {r.logo && <img className="tokimg" src={r.logo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = "none")} />}
        <span className="display runner-sym" title={r.name}>
          ${r.symbol}
        </span>
        {r.pump && <span className="runner-pump">pump</span>}
        <Tweet text={text} path={path} />
      </div>
      <div className="runner-nums num">
        <Delta x={chg / 100} dp={1} />
        <span className="muted">{r.market ? `mc ${mcap(r.mc)}` : r.listable ? "no market yet" : `mc ${mcap(r.mc)}`}</span>
      </div>
      {r.market ? (
        <Link className="runner-act go up" to={path}>
          Trade · UP {levOf(r.market.levUp)}
        </Link>
      ) : r.listable ? (
        <Link className="runner-act go list" to={path} title={`Raydium CLMM vs ${r.listable.quote} · $${Math.round(r.listable.tvl).toLocaleString("en-US")} TVL`}>
          List ${r.symbol} · LFG
        </Link>
      ) : r.venue_hint === "pumpswap" ? (
        <span className="runner-act off">soon · pumpswap</span>
      ) : (
        <span className="runner-act off">no oracle</span>
      )}
    </article>
  );
}

export default Runners;
