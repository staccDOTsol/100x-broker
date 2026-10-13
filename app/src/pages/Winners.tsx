// /winners — every realized win, all time: UP/DOWN exits and vault unparks that paid more than they cost. Rank by size, speed, or recency.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { usePoll } from "../hooks";
import { ago, short } from "../lib/format";

type Win = {
  sig: string; ts: number; wallet: string; kind: "exit" | "unpark"; market: string; vault?: string; ticker: string; side?: 0 | 1;
  cost_sol: number; out_sol: number; gain_sol: number; ret: number; hold_s: number; per_hour_sol: number | null;
};
type Leader = { wallet: string; net_sol: number; won_sol: number; lost_sol: number; ref_sol: number; trades: number; best_sol: number; best_sig: string; first: number; last: number };
type Round = { start: number; end: number; prize_sol: number; prizes_sol: number[]; final: boolean; leaders: Leader[] };
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

async function load(): Promise<Feed> {
  const r = await fetch("/api/winners");
  if (!r.ok) throw new Error(`winners ${r.status}`);
  return r.json();
}
const sol = (n: number, d = 3) => `${n < 0 ? "−" : ""}${Math.abs(n).toFixed(d)}`;
function held(s: number) {
  if (s < 60) return `${Math.max(1, Math.round(s))}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}
const sorters: Record<Rank, (a: Win, b: Win) => number> = {
  gain: (a, b) => b.gain_sol - a.gain_sol,
  speed: (a, b) => (b.per_hour_sol ?? 0) - (a.per_hour_sol ?? 0),
  ret: (a, b) => b.ret - a.ret,
  latest: (a, b) => b.ts - a.ts,
};

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
function left(s: number) {
  if (s <= 0) return "0s";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(x).padStart(2, "0")}s`;
}
const et = (ts: number) =>
  new Date(ts * 1000).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";

function Leaders({ rows, prizes = [] }: { rows: Leader[]; prizes?: number[] }) {
  if (!rows.length) return <p className="fine">Nobody has closed a trade or earned a referral in this window yet. First one in the green takes the lead.</p>;
  return (
    <table className="arena-table winners-table race-table">
      <thead>
        <tr>
          <th>#</th>
          <th>who</th>
          <th className="num">net</th>
          <th className="num">won</th>
          <th className="num">lost</th>
          <th className="num">refs</th>
          <th className="num">exits</th>
          <th className="num">prize</th>
          <th className="num">best</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 25).map((r, i) => (
          <tr key={r.wallet} className={i < prizes.length ? "race-paid" : undefined}>
            <td className="rank">{i === 0 && prizes.length ? "👑" : i + 1}</td>
            <td>
              <Link to={`/p/${r.wallet}`}>{short(r.wallet)}</Link>
            </td>
            <td className={`num net ${r.net_sol >= 0 ? "up" : "down"}`}>{r.net_sol >= 0 ? "+" : ""}{sol(r.net_sol)}</td>
            <td className="num">{sol(r.won_sol)}</td>
            <td className="num">{sol(r.lost_sol)}</td>
            <td className="num">{r.ref_sol ? `+${sol(r.ref_sol, 4)}` : "—"}</td>
            <td className="num">{r.trades}</td>
            <td className="num">{i < prizes.length ? `${prizes[i]} SOL` : ""}</td>
            <td className="num">
              {r.best_sig ? (
                <a href={`https://solscan.io/tx/${r.best_sig}`} target="_blank" rel="noreferrer">+{sol(r.best_sol)}</a>
              ) : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RefLeaders({ rows }: { rows: RefRow[] }) {
  if (!rows.length) return <p className="fine">No referral payouts in this window yet. Share your link from <Link to="/me">your bag</Link>: every SOL a referred wallet brings in pays you 0.05% of it, on-chain.</p>;
  return (
    <table className="arena-table winners-table race-table">
      <thead>
        <tr>
          <th>#</th>
          <th>referrer</th>
          <th className="num">earned</th>
          <th className="num">SOL referred</th>
          <th className="num">wallets</th>
          <th className="num">deposits</th>
          <th>last</th>
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
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Leaderboard({ data }: { data: Feed }) {
  const [kind, setKind] = useState<"pnl" | "refs">("pnl");
  const [period, setPeriod] = useState<Period>("24h");
  const race = data.race;
  const raceTab = kind === "pnl" && period === "24h" && race;
  return (
    <section className="arena race" aria-label="Leaderboard">
      <div className="winners-bar">
        <div className="seg" role="tablist" aria-label="board">
          <button className="chip" aria-pressed={kind === "pnl"} onClick={() => setKind("pnl")}>top P&amp;L</button>
          <button className="chip" aria-pressed={kind === "refs"} onClick={() => setKind("refs")}>top referrers</button>
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
        <RaceBoard race={race} />
      ) : kind === "pnl" ? (
        <>
          <p className="lede">Net realized P&amp;L per wallet, {period === "all" ? "all time" : `last ${period}`}: every exit and unpark, winners minus losers, plus referral fees earned.</p>
          <Leaders rows={data.boards?.[period] ?? []} />
        </>
      ) : (
        <>
          <p className="lede">Referral fees earned, {period === "all" ? "all time" : `last ${period}`}: 0.05% of every SOL your referred wallets bring in, paid on-chain by the stake pool to your r-fstacc.</p>
          <RefLeaders rows={data.refs?.[period] ?? []} />
        </>
      )}
    </section>
  );
}

function RaceBoard({ race }: { race: Race }) {
  const now = useNow();
  const r = race.live;
  return (
    <div className="race-round">
      {r ? (
        <>
          <h2 className="display race-prizes">{r.prizes_sol.map((p, i) => `${["🥇", "🥈", "🥉", "4th", "5th"][i]} ${p} SOL`).join("   ")}</h2>
          <p className="lede">
            Biggest <b>net</b> realized P&amp;L in SOL between {et(r.start)} and <b>{et(r.end)}</b>: {r.prizes_sol.map((p, i) => `${["1st", "2nd", "3rd", "4th", "5th"][i]} ${p} SOL`).join(" · ")}. Humans and agents alike: any wallet, any bot, any on-chain actor.
          </p>
          <p className="race-clock">
            ends in <b>{left(r.end - now)}</b>
          </p>
          <Leaders rows={r.leaders} prizes={r.prizes_sol} />
        </>
      ) : (
        <>
          <h2 className="display">Last round</h2>
          {race.last && (
            <>
              <p className="lede">
                Round ended {et(race.last.end)} · {race.last.prizes_sol.join(" / ")} SOL to the top {race.last.prizes_sol.length}{race.last.final ? "" : " · final scan pending"}.
              </p>
              <Leaders rows={race.last.leaders} prizes={race.last.prizes_sol} />
            </>
          )}
          <p className="lede">Next prize to be announced. The rolling last 24h, meanwhile:</p>
          <Leaders rows={race.rolling ?? []} />
        </>
      )}
      <p className="fine">
        Scored as net realized SOL per wallet: every UP/DOWN exit (sell or cash-out) and vault unpark that lands in the window counts, winners minus losers, at average cost basis, plus the referral fees your link earned in the window (r-fstacc at today's rate). Self-referrals don't count. Unrealized bags don't count; close it to score it. The house keeper and the vaults' own accounts are excluded. Ties go to whoever got there first. Agents: every board is JSON at <a href="/api/winners">/api/winners</a> → <code>race</code>, <code>boards</code>, <code>refs</code>.
      </p>
    </div>
  );
}

export default function WinnersPage() {
  const { data, error, loading } = usePoll(load, [], 30_000);
  const [rank, setRank] = useState<Rank>("gain");
  const [only, setOnly] = useState<"all" | "exit" | "unpark">("all");
  const rows = useMemo(() => {
    const w = (data?.wins ?? []).filter((x) => only === "all" || x.kind === only);
    return [...w].sort(sorters[rank]).slice(0, 300);
  }, [data, rank, only]);
  return (
    <>
      <header className="spicy-head">
        <div className="meta">
          <Link to="/">Board</Link> / winners
        </div>
        <h1 className="display">Leaderboard</h1>
      </header>
      {data ? <Leaderboard data={data} /> : <p className="fine">{loading ? "Loading the leaderboard…" : "Leaderboard unavailable."}</p>}
      <header className="spicy-head alltime-head">
        <h2 className="display">All-time winner feed</h2>
        <p className="lede">
          Every realized win since genesis. An <b className="up">UP</b>/<b className="down">DOWN</b> exit that paid more than its tokens cost, or a <Link to="/yield">/yield</Link> unpark that handed back more SOL than the receipts cost. Ranked all time.
        </p>
        {data && (
          <p className="fine">
            {data.count} wins · {data.wallets} wallets · {sol(data.total_sol, 2)} SOL won · {data.exits} exits, {data.unparks} unparks · scanned {ago(data.at)}
          </p>
        )}
      </header>
      <section className="arena winners" aria-label="All-time winner feed">
        <div className="winners-bar">
          <div className="seg" role="tablist" aria-label="rank by">
            {(["gain", "speed", "ret", "latest"] as Rank[]).map((r) => (
              <button key={r} className="chip" aria-pressed={rank === r} onClick={() => setRank(r)}>
                {r === "gain" ? "biggest" : r === "speed" ? "fastest (SOL/hr)" : r === "ret" ? "best %" : "latest"}
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
                <th className="num">in</th>
                <th className="num">out</th>
                <th className="num">won</th>
                <th className="num">held</th>
                <th className="num">SOL/hr</th>
                <th>when</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w, i) => (
                <tr key={w.sig}>
                  <td className="rank">{i + 1}</td>
                  <td>
                    <Link to={`/p/${w.wallet}`}>{short(w.wallet)}</Link>
                  </td>
                  <td>
                    {w.kind === "exit" ? (
                      <Link to={`/m/${w.market}?side=${w.side ?? 0}`} className={`chip ${w.side === 1 ? "down" : "up"}`}>
                        {w.ticker} {w.side === 1 ? "DOWN" : "UP"}
                      </Link>
                    ) : (
                      <Link to={`/yield/${w.vault}`} className="chip">
                        {w.ticker} vault
                      </Link>
                    )}
                  </td>
                  <td className="num">{sol(w.cost_sol)}</td>
                  <td className="num">{sol(w.out_sol)}</td>
                  <td className="num net up">
                    +{sol(w.gain_sol)} <small>({(w.ret * 100).toFixed(0)}%)</small>
                  </td>
                  <td className="num">{held(w.hold_s)}</td>
                  <td className="num">{w.per_hour_sol === null ? "—" : sol(w.per_hour_sol, 4)}</td>
                  <td className="sub">
                    <a href={`https://solscan.io/tx/${w.sig}`} target="_blank" rel="noreferrer">
                      {ago(w.ts)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty arena-empty">
            <div className="display">{loading && !data ? "Counting the wins…" : "No wins yet."}</div>
            {!loading && data && <p>Nobody has exited green yet. The empty side pays best; go be it.</p>}
          </div>
        )}
        {error && !data && <p className="err">Couldn't load the winner feed: {error}</p>}
        <p className="fine">
          In/out in SOL (r-fstacc at today's rate for exits). Cost is average basis of the tokens or receipts that moved. Held is since the first buy or park. Vault wins count the SOL that came back to the wallet; the 0/20 slice committed to the raise still counts as won.
        </p>
      </section>
    </>
  );
}
