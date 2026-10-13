// /winners — the race (net realized SOL, prizes to the top), the period boards, referrers, and every realized win since genesis.
// Every surface is a card with its own tweet (ref baked in). Labels ≤3 words; the numbers do the talking. All data is the polled feed.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePoll } from "../hooks";
import { ago, short } from "../lib/format";
import { Countdown, Flash, Rolling, Sparkline, useNow } from "../components/Pulse";
import { CardShare, Tweet } from "../components/Share";
import { fetchWinners, type RaceLeader as Leader, type RaceRound as Round, type Win } from "../lib/feed";

type Race = { rule: string; live: Round | null; last: Round | null; rolling: Leader[] | null };
type Period = "24h" | "7d" | "30d" | "all";
type RefRow = { wallet: string; earned_sol: number; referred_sol: number; deposits: number; referred_wallets: number; last: number };
type Feed = {
  at: number; rate: number; count: number; wallets: number; total_sol: number; exits: number; unparks: number; wins: Win[]; race?: Race;
  boards?: Record<Period, Leader[]>; refs?: { at: number } & Record<Period, RefRow[]>;
};
const PERIODS: Period[] = ["24h", "7d", "30d", "all"];
const plabel = (p: Period) => (p === "all" ? "all-time" : p);
type Rank = "gain" | "speed" | "latest" | "ret";
const MEDAL = ["🥇", "🥈", "🥉", "4th", "5th"];
const SITE = "100x.broker";

const load = (): Promise<Feed> => fetchWinners();
const sol = (n: number, d = 3) => `${n < 0 ? "−" : ""}${Math.abs(n).toFixed(d)}`;
/** A multiplier only means something against a real cost basis; tokens that arrived by transfer have ~0 basis and would print nonsense. */
const MIN_BASIS_SOL = 0.005;
const hasBasis = (w: Win) => w.cost_sol >= MIN_BASIS_SOL;
const mult = (w: Win) => {
  if (!hasBasis(w)) return "—";
  const m = w.ret + 1;
  return `${m >= 10 ? m.toFixed(0) : m.toFixed(1)}×`;
};
/** Headline for a win: the multiplier when there's a basis, the SOL gained when there isn't. */
const headline = (w: Win) => (hasBasis(w) ? mult(w) : `+${sol(w.gain_sol, 2)}`);
/** Tweet text for a win: `${wallet} just took ${mult} on $TICKER` or `+${gain} SOL` when there's no basis. */
const winText = (w: Win, verb = "just took") => `${short(w.wallet)} ${verb} ${hasBasis(w) ? mult(w) : `+${sol(w.gain_sol)} SOL`} on $${w.ticker}`;
const winPath = (w: Win) => `/m/${w.market}`;
function held(s: number) {
  if (s < 60) return `${Math.max(1, Math.round(s))}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}
const hms = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((v) => String(v).padStart(2, "0")).join(":");
};
const sorters: Record<Rank, (a: Win, b: Win) => number> = {
  gain: (a, b) => b.gain_sol - a.gain_sol,
  speed: (a, b) => (b.per_hour_sol ?? 0) - (a.per_hour_sol ?? 0),
  ret: (a, b) => (hasBasis(b) ? b.ret : -1) - (hasBasis(a) ? a.ret : -1),
  latest: (a, b) => b.ts - a.ts,
};
const et = (ts: number) =>
  new Date(ts * 1000).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";

const WhatChip = ({ w }: { w: Win }) =>
  w.kind === "exit" ? (
    <Link to={`/m/${w.market}?side=${w.side ?? 0}`} className={`chip ${w.side === 1 ? "down" : "up"}`}>
      {w.ticker} {w.side === 1 ? "DOWN" : "UP"}
    </Link>
  ) : (
    <Link to={`/yield/${w.vault}`} className="chip">
      {w.ticker} vault
    </Link>
  );

/**
 * Ranked wallets as rows that physically move when the order changes: each row is absolutely positioned by rank, so a
 * wallet climbing from 5th to 2nd slides up past the others. Net bar scales to the leader. Every row tweets itself.
 * `when` is the phrase that lands in the tweet: "this race", "this 24h", "all-time".
 */
function RankRows({ rows, prizes = [], me, when }: { rows: Leader[]; prizes?: number[]; me?: string; when: string }) {
  const ROW = 44;
  const shown = rows.slice(0, 25);
  const top = Math.max(1e-9, ...shown.map((r) => Math.abs(r.net_sol)));
  if (!shown.length) return <p className="fine">Nobody's green yet.</p>;
  return (
    <div className="ranks" style={{ height: shown.length * ROW }}>
      {shown.map((r, i) => {
        const paid = i < prizes.length;
        return (
          <div
            key={r.wallet}
            className={`rank-row ${paid ? "paid" : ""} ${r.wallet === me ? "me" : ""} ${r.net_sol >= 0 ? "up" : "down"}`}
            style={{ transform: `translateY(${i * ROW}px)` }}
          >
            <span className="pos display num">{paid ? MEDAL[i] : i + 1}</span>
            <Link to={`/p/${r.wallet}`} className="who num">
              {short(r.wallet)}
              {r.wallet === me && <span className="chip you">you</span>}
            </Link>
            <span className="bar" aria-hidden>
              <i style={{ width: `${Math.max(2, (Math.abs(r.net_sol) / top) * 100)}%` }} />
            </span>
            <Flash watch={r.net_sol} className="net num display">
              {r.net_sol >= 0 ? "+" : ""}
              {sol(r.net_sol)}
            </Flash>
            <span className="meta num side">
              {r.trades} exits{r.ref_sol ? ` · refs +${sol(r.ref_sol, 4)}` : ""}
            </span>
            <span className="prize num">{paid ? `${prizes[i]} SOL` : ""}</span>
            <Tweet text={`#${i + 1} ${short(r.wallet)} ${r.net_sol >= 0 ? "+" : ""}${sol(r.net_sol)} SOL ${when} on ${SITE}`} path={`/p/${r.wallet}`} />
          </div>
        );
      })}
    </div>
  );
}

function RefLeaders({ rows, when }: { rows: RefRow[]; when: string }) {
  if (!rows.length)
    return (
      <p className="fine">
        No payouts yet. <Link to="/me">Your link →</Link>
      </p>
    );
  return (
    <table className="arena-table winners-table race-table">
      <thead>
        <tr>
          <th>#</th>
          <th>referrer</th>
          <th className="num">earned</th>
          <th className="num">referred</th>
          <th className="num">wallets</th>
          <th className="num">deposits</th>
          <th>last</th>
          <th aria-label="share" />
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 25).map((r, i) => (
          <tr key={r.wallet}>
            <td className="rank">{i + 1}</td>
            <td>
              <Link to={`/p/${r.wallet}`}>{short(r.wallet)}</Link>
            </td>
            <td className="num net up">+{sol(r.earned_sol, 4)}</td>
            <td className="num">{sol(r.referred_sol, 2)}</td>
            <td className="num">{r.referred_wallets}</td>
            <td className="num">{r.deposits}</td>
            <td className="sub">{ago(r.last)}</td>
            <td className="share-cell">
              <Tweet text={`#${i + 1} ${short(r.wallet)} earned +${sol(r.earned_sol, 4)} SOL referring ${when} on ${SITE}`} path={`/p/${r.wallet}`} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The race: prize, clock, who's winning, how far you are from money. One tweet for the whole card. */
function RaceHead({ race, me }: { race: Race; me?: string }) {
  const now = useNow();
  const r = race.live;
  if (!r) {
    const last = race.last;
    const paid = last ? last.prizes_sol.reduce((a, b) => a + b, 0) : 0;
    return (
      <section className="race-head">
        <div className="race-pitch">
          <h1 className="display">Next race soon.</h1>
          {last && (
            <div className="win-tags">
              <span className="chip">
                <b className="num">{paid} SOL</b> paid
              </span>
              <span className="chip num">{et(last.end)}</span>
              {!last.final && <span className="chip">final scan pending</span>}
              <CardShare text={`${paid} SOL paid out in the last race on ${SITE}`} path="/winners" />
            </div>
          )}
        </div>
      </section>
    );
  }
  const left = r.end - now;
  const prize = r.prizes_sol.reduce((a, b) => a + b, 0);
  const myIdx = me ? r.leaders.findIndex((l) => l.wallet === me) : -1;
  const lastPaid = r.leaders[r.prizes_sol.length - 1];
  const onPodium = myIdx >= 0 && myIdx < r.prizes_sol.length;
  const gap = lastPaid ? (onPodium ? 0 : lastPaid.net_sol - (myIdx >= 0 ? r.leaders[myIdx].net_sol : 0)) : 0;
  return (
    <section className={`race-head ${left < 3600 ? "hot" : ""}`}>
      <div className="race-pitch">
        <div className="meta kicker">
          <span className="live-dot" aria-hidden /> live race
          <CardShare text={`${prize} SOL race on ${SITE} · ${hms(left)} left`} path="/winners" />
        </div>
        <h1 className="display">
          <Rolling value={prize} format={(n) => n.toFixed(0)} /> SOL
          <br />
          on the line.
        </h1>
        <div className="podium">
          {r.prizes_sol.map((p, i) => (
            <span key={i} className={`chip podium-chip p${i}`}>
              {MEDAL[i]} {p} SOL
            </span>
          ))}
        </div>
        <div className="win-tags">
          <span className="chip">net realized</span>
          <span className="chip">any wallet</span>
          <span className="chip">close to score</span>
        </div>
      </div>
      <div className="clock-card panel">
        <Countdown to={r.end} label={left > 0 ? "next payout" : "scoring"} />
        <Link to="/" className="btn signal big display">
          Enter race →
        </Link>
        <p className="meta num gap-line">
          {onPodium ? (
            <>
              you're {MEDAL[myIdx]} · <b>hold it</b>
            </>
          ) : lastPaid ? (
            <>
              <b className="up">{gap > 0 ? `+${sol(gap)} SOL` : "one green exit"}</b> to {MEDAL[r.prizes_sol.length - 1]} {short(lastPaid.wallet)}
            </>
          ) : (
            "podium open"
          )}
        </p>
      </div>
    </section>
  );
}

function Leaderboard({ data, me }: { data: Feed; me?: string }) {
  const [kind, setKind] = useState<"pnl" | "refs">("pnl");
  const [period, setPeriod] = useState<Period>("24h");
  const race = data.race;
  const raceTab = kind === "pnl" && period === "24h" && race;
  const live = race?.live;
  const when = period === "all" ? "all-time" : `this ${period}`;
  return (
    <section className="arena race" aria-label="Leaderboard">
      <div className="winners-bar">
        <div className="seg" role="tablist" aria-label="board">
          <button className="chip" aria-pressed={kind === "pnl"} onClick={() => setKind("pnl")}>
            P&amp;L
          </button>
          <button className="chip" aria-pressed={kind === "refs"} onClick={() => setKind("refs")}>
            referrers
          </button>
        </div>
        <div className="seg" role="tablist" aria-label="window">
          {PERIODS.map((p) => (
            <button key={p} className="chip" aria-pressed={period === p} onClick={() => setPeriod(p)}>
              {plabel(p)}
            </button>
          ))}
        </div>
      </div>
      {raceTab ? (
        live ? (
          <RankRows rows={live.leaders} prizes={live.prizes_sol} me={me} when="this race" />
        ) : (
          <>
            {race.last && <RankRows rows={race.last.leaders} prizes={race.last.prizes_sol} me={me} when="last race" />}
            <p className="meta">rolling 24h</p>
            <RankRows rows={race.rolling ?? []} me={me} when="this 24h" />
          </>
        )
      ) : kind === "pnl" ? (
        <RankRows rows={data.boards?.[period] ?? []} me={me} when={when} />
      ) : (
        <RefLeaders rows={data.refs?.[period] ?? []} when={when} />
      )}
      <details className="fine">
        <summary>how it's scored</summary>
        <ul className="rule-bits">
          <li>net realized SOL</li>
          <li>exits · unparks · refs</li>
          <li>
            raw: <a href="/api/winners">/api/winners</a>
          </li>
        </ul>
      </details>
    </section>
  );
}

/** Wins as they land. New rows slide in; multiplier (or SOL gained when there's no basis) is the headline. Each row tweets itself. */
function Landing({ wins }: { wins: Win[] }) {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(wins.map((w) => w.sig));
      return;
    }
    const now = new Set<string>();
    for (const w of wins) if (!seen.current.has(w.sig)) (seen.current.add(w.sig), now.add(w.sig));
    if (now.size) {
      setFresh(now);
      const t = setTimeout(() => setFresh(new Set()), 5000);
      return () => clearTimeout(t);
    }
  }, [wins]);
  const rows = [...wins].sort(sorters.latest).slice(0, 8);
  if (!rows.length) return null;
  return (
    <ol className="landing" aria-live="polite">
      {rows.map((w) => (
        <li key={w.sig} className={`land ${fresh.has(w.sig) ? "fresh" : ""} ${hasBasis(w) && w.ret >= 1 ? "loud" : ""}`}>
          <span className={`mult display num ${w.side === 1 ? "down" : "up"}`}>{headline(w)}</span>
          <span className="what">
            <Link to={`/p/${w.wallet}`} className="num">
              {short(w.wallet)}
            </Link>{" "}
            <WhatChip w={w} />
          </span>
          <span className="won num up">{hasBasis(w) ? `+${sol(w.gain_sol)} SOL` : "SOL won"}</span>
          <span className="meta num">
            {held(w.hold_s)} ·{" "}
            <a href={`https://solscan.io/tx/${w.sig}`} target="_blank" rel="noreferrer">
              {ago(w.ts)}
            </a>
          </span>
          <CardShare text={winText(w)} path={winPath(w)} />
        </li>
      ))}
    </ol>
  );
}

export default function WinnersPage() {
  const { data, error, loading } = usePoll(load, [], 15_000);
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const [rank, setRank] = useState<Rank>("gain");
  const [only, setOnly] = useState<"all" | "exit" | "unpark">("all");
  const rows = useMemo(() => {
    const w = (data?.wins ?? []).filter((x) => only === "all" || x.kind === only);
    return [...w].sort(sorters[rank]).slice(0, 300);
  }, [data, rank, only]);
  const best = useMemo(() => {
    const w = (data?.wins ?? []).filter(hasBasis);
    return w.length ? w.reduce((a, b) => (b.ret > a.ret ? b : a)) : null;
  }, [data]);
  const fastest = useMemo(
    () => (data?.wins.length ? data.wins.reduce((a, b) => ((b.per_hour_sol ?? 0) > (a.per_hour_sol ?? 0) ? b : a)) : null),
    [data],
  );
  /** Cumulative SOL won over the last 200 realized wins, oldest → newest. Real wins only; this is what the "won all-time" card draws. */
  const curve = useMemo(() => {
    const w = [...(data?.wins ?? [])].sort((a, b) => a.ts - b.ts).slice(-200);
    let acc = 0;
    return w.map((x) => ({ ts: x.ts, price: (acc += x.gain_sol) }));
  }, [data]);
  if (!data)
    return (
      <div className="race-head">
        <div className="race-pitch">
          <div className="skeleton" style={{ height: 96, width: "60%" }} />
          <div className="skeleton" style={{ height: 20, width: "40%", marginTop: 12 }} />
        </div>
        <div className="skeleton" style={{ height: 180 }} />
        {error && !loading && <p className="err">Leaderboard unavailable: {error}</p>}
      </div>
    );
  return (
    <>
      {data.race ? (
        <RaceHead race={data.race} me={me} />
      ) : (
        <header className="spicy-head">
          <h1 className="display">Leaderboard</h1>
        </header>
      )}
      <div className="win-grid">
        <Leaderboard data={data} me={me} />
        <aside className="win-aside">
          {best && (
            <div className="panel best">
              <span className="meta stat-head">
                best return
                <CardShare text={`${winText(best, "took")} on ${SITE}`} path={winPath(best)} />
              </span>
              <Link
                to={best.kind === "exit" ? `/m/${best.market}?side=${best.side ?? 0}` : `/yield/${best.vault}`}
                className={`display huge num ${best.side === 1 ? "down" : "up"}`}
              >
                {mult(best)}
              </Link>
              <span className="win-tags">
                <Link to={`/p/${best.wallet}`} className="chip num">
                  {short(best.wallet)}
                </Link>
                <WhatChip w={best} />
                <span className="chip num">
                  {sol(best.cost_sol)} → {sol(best.out_sol)}
                </span>
                <span className="chip num">{held(best.hold_s)}</span>
              </span>
            </div>
          )}
          {fastest && fastest.per_hour_sol && (
            <div className="panel stat-card">
              <span className="meta stat-head">
                fastest SOL/hr
                <CardShare text={`${short(fastest.wallet)} +${sol(fastest.per_hour_sol, 2)} SOL/hr on $${fastest.ticker} on ${SITE}`} path={winPath(fastest)} />
              </span>
              <span className="display num up">+{sol(fastest.per_hour_sol, 2)}</span>
              <span className="win-tags">
                <Link to={`/p/${fastest.wallet}`} className="chip num">
                  {short(fastest.wallet)}
                </Link>
                <WhatChip w={fastest} />
                <span className="chip num">{held(fastest.hold_s)}</span>
              </span>
            </div>
          )}
          <div className="panel stat-card">
            <span className="meta stat-head">
              won all-time
              <CardShare text={`+${sol(data.total_sol, 2)} SOL won on ${SITE} · ${data.count} wins · ${data.wallets} wallets`} path="/winners" />
            </span>
            <span className="display num up">
              +<Rolling value={data.total_sol} format={(n) => n.toFixed(2)} /> SOL
            </span>
            {curve.length >= 2 && <Sparkline series={curve} w={240} h={40} className="won-curve" label={`SOL won, last ${curve.length} wins`} />}
            <span className="win-tags">
              <span className="chip num">{data.count} wins</span>
              <span className="chip num">{data.wallets} wallets</span>
              <span className="chip num">{ago(data.at)}</span>
            </span>
          </div>
          <h2 className="display h-small">
            <span className="live-dot" aria-hidden /> Landing now
          </h2>
          <Landing wins={data.wins} />
        </aside>
      </div>

      <section className="arena winners" aria-label="All-time wins">
        <div className="winners-bar">
          <h2 className="display h-small">Every win. Ever.</h2>
          <div className="seg" role="tablist" aria-label="rank by">
            {(["gain", "ret", "speed", "latest"] as Rank[]).map((r) => (
              <button key={r} className="chip" aria-pressed={rank === r} onClick={() => setRank(r)}>
                {r === "gain" ? "biggest" : r === "speed" ? "SOL/hr" : r === "ret" ? "best ×" : "latest"}
              </button>
            ))}
          </div>
          <div className="seg" role="tablist" aria-label="kind">
            {(["all", "exit", "unpark"] as const).map((k) => (
              <button key={k} className="chip" aria-pressed={only === k} onClick={() => setOnly(k)}>
                {k === "all" ? "all" : k === "exit" ? "up/down" : "vaults"}
              </button>
            ))}
          </div>
        </div>
        {rows.length > 0 ? (
          <table className="arena-table winners-table">
            <thead>
              <tr>
                <th>#</th>
                <th>who</th>
                <th>what</th>
                <th className="num">×</th>
                <th className="num">in</th>
                <th className="num">out</th>
                <th className="num">won</th>
                <th className="num">held</th>
                <th className="num">SOL/hr</th>
                <th>when</th>
                <th aria-label="share" />
              </tr>
            </thead>
            <tbody>
              {rows.map((w, i) => (
                <tr key={w.sig} className={w.wallet === me ? "me" : undefined}>
                  <td className="rank">{i + 1}</td>
                  <td>
                    <Link to={`/p/${w.wallet}`}>{short(w.wallet)}</Link>
                  </td>
                  <td>
                    <WhatChip w={w} />
                  </td>
                  <td className={`num mult-cell ${hasBasis(w) && w.ret >= 1 ? "up" : ""}`}>{mult(w)}</td>
                  <td className="num">{sol(w.cost_sol)}</td>
                  <td className="num">{sol(w.out_sol)}</td>
                  <td className="num net up">+{sol(w.gain_sol)}</td>
                  <td className="num">{held(w.hold_s)}</td>
                  <td className="num">{w.per_hour_sol === null ? "—" : sol(w.per_hour_sol, 4)}</td>
                  <td className="sub">
                    <a href={`https://solscan.io/tx/${w.sig}`} target="_blank" rel="noreferrer">
                      {ago(w.ts)}
                    </a>
                  </td>
                  <td className="share-cell">
                    <Tweet text={`${winText(w, "took")} on ${SITE}`} path={winPath(w)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty arena-empty">
            <div className="display">No wins yet.</div>
            <p>Empty side pays.</p>
          </div>
        )}
        <details className="fine">
          <summary>what counts</summary>
          <ul className="rule-bits">
            <li>in/out in SOL</li>
            <li>average cost basis</li>
            <li>held since buy</li>
          </ul>
        </details>
      </section>
    </>
  );
}
