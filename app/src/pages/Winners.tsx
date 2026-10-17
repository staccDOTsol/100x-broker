// /winners — the leaderboard, terminal style: a period (24H · 7D · 30D · All time) and a category (Top PnL · Most volume · Longest held ·
// Referrers) in the URL, a podium for the top three, the rest in a ranked table, the live race above it when one runs, and your own
// PnL beside it. Below: every realized win since genesis. Every row tweets itself (ref baked in). All data is polled: /api/winners and
// /api/leaders?active=.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePoll } from "../hooks";
import { ago, short } from "../lib/format";
import { Flash, Rolling, Sparkline, useNow } from "../components/Pulse";
import { CardShare, Tweet } from "../components/Share";
import { CatEmpty, CatFilter, useCatRows } from "../components/CatFilter";
import { fetchActive, fetchWinners, type RaceLeader as Leader, type RaceRound as Round, type Win } from "../lib/feed";
import { useQuery } from "../lib/url";
import { usePrices } from "../hooks/price";
import { Avatar, PERIOD_LABEL, PERIOD_SECS, PnlCard, type Period } from "../components/Terminal";
import { WalletButton } from "../components/bits";

type Race = { rule: string; live: Round | null; last: Round | null; rolling: Leader[] | null };
type RefRow = { wallet: string; earned_sol: number; referred_sol: number; deposits: number; referred_wallets: number; last: number };
type Feed = {
  at: number; rate: number; count: number; wallets: number; total_sol: number; exits: number; unparks: number; wins: Win[]; race?: Race;
  boards?: Record<Period, Leader[]>; refs?: { at: number } & Record<Period, RefRow[]>;
};
const PERIODS: Period[] = ["24h", "7d", "30d", "all"];
type Category = "pnl" | "volume" | "held" | "refs";
const CATS: { id: Category; label: string; icon: string; rule: string }[] = [
  { id: "pnl", label: "Top PnL", icon: "🏆", rule: "Ranked by net realized SOL: UP/DOWN exits and vault unparks (wins minus losses) plus referral fees." },
  { id: "volume", label: "Most volume", icon: "▥", rule: "Ranked by SOL moved: buys, sells and cash-outs, closed positions included. Vault plumbing excluded." },
  { id: "held", label: "Longest held", icon: "⧗", rule: "Ranked by the longest a winning position stayed open before it was sold or cashed out." },
  { id: "refs", label: "Referrers", icon: "↗", rule: "Ranked by SOL earned from wallets that deposited through a referral link." },
];
type Rank = "gain" | "speed" | "latest" | "ret";
const MEDAL = ["🥇", "🥈", "🥉", "4th", "5th"];
const SITE = "100x.broker";

const load = (): Promise<Feed> => fetchWinners() as Promise<Feed>;
const NO_WINS: Win[] = [];
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
/** "15h 40m 52s" — the longest-held board reads like a stopwatch. */
function hms(s: number) {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m ${String(x).padStart(2, "0")}s` : m ? `${m}m ${String(x).padStart(2, "0")}s` : `${x}s`;
}
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
    <Link to={`/m/${w.market}?side=yield`} className="chip">
      {w.ticker} vault
    </Link>
  );

/** One ranked wallet, ready for the podium (metric + one line) and the table (cells in column order). */
type Ranked = { wallet: string; metric: ReactNode; tone?: "up" | "down"; line: string; cells: ReactNode[]; tweet: string };
type Board = { cols: { label: string; num?: boolean }[]; rows: Ranked[]; note?: string; unavailable?: string };

function useBoard(data: Feed, cat: Category, period: Period): { board: Board; loading: boolean } {
  const px = usePrices();
  const hours = period === "24h" ? 24 : period === "7d" ? 168 : null;
  const active = usePoll(() => (cat === "volume" && hours ? fetchActive(hours) : Promise.resolve(null)), [cat, hours], 60_000);
  const when = period === "all" ? "all-time" : `this ${period}`;
  const now = Math.floor(Date.now() / 1000);
  const since = PERIOD_SECS[period] === Infinity ? 0 : now - PERIOD_SECS[period];
  const board = useMemo((): Board => {
    if (cat === "pnl") {
      const winsBy = new Map<string, number>();
      for (const w of data.wins) if (w.ts >= since) winsBy.set(w.wallet, (winsBy.get(w.wallet) ?? 0) + 1);
      const rows = (data.boards?.[period] ?? []).map((r): Ranked => {
        const wr = r.trades ? Math.min(1, (winsBy.get(r.wallet) ?? 0) / r.trades) : null;
        return {
          wallet: r.wallet,
          metric: `${r.net_sol >= 0 ? "+" : ""}${sol(r.net_sol)} SOL`,
          tone: r.net_sol >= 0 ? "up" : "down",
          line: `${r.trades} exits${wr !== null ? ` · ${Math.round(wr * 100)}% win` : ""}`,
          cells: [
            r.trades,
            wr !== null ? `${Math.round(wr * 100)}%` : "—",
            <span className="up">+{sol(r.won_sol)}</span>,
            <span className="down">{r.lost_sol ? `−${sol(r.lost_sol)}` : "0"}</span>,
            <Flash watch={r.net_sol} className={`net ${r.net_sol >= 0 ? "up" : "down"}`}>
              {r.net_sol >= 0 ? "+" : ""}
              {sol(r.net_sol)}
              {r.ref_sol ? <small> refs +{sol(r.ref_sol, 4)}</small> : null}
            </Flash>,
          ],
          tweet: `${short(r.wallet)} ${r.net_sol >= 0 ? "+" : ""}${sol(r.net_sol)} SOL ${when} on ${SITE}`,
        };
      });
      return { cols: [{ label: "Exits", num: true }, { label: "Win rate", num: true }, { label: "Won", num: true }, { label: "Lost", num: true }, { label: "Net PnL (SOL)", num: true }], rows };
    }
    if (cat === "volume") {
      if (!hours) return { cols: [], rows: [], unavailable: "Volume is tracked for the last 7 days. Pick 24H or 7D." };
      const rows = (active.data ?? []).map((a): Ranked => {
        const v = px.quoteSol(BigInt(a.in) + BigInt(a.out));
        const net = px.quoteSol(BigInt(a.net));
        return {
          wallet: a.owner,
          metric: v !== null ? `${v.toFixed(2)} SOL` : "—",
          line: `${a.trades} trades · ${a.markets} market${a.markets === 1 ? "" : "s"}`,
          cells: [
            a.trades,
            a.markets,
            a.top ? (
              <Link to={`/m/${a.top.market}?side=${a.top.side}`} className={`chip ${a.top.side === 1 ? "down" : "up"}`}>
                {a.top.ticker} {a.top.side === 1 ? "DOWN" : "UP"}
              </Link>
            ) : (
              "—"
            ),
            net !== null ? <span className={net >= 0 ? "up" : "down"}>{`${net >= 0 ? "+" : "−"}${Math.abs(net).toFixed(3)}`}</span> : "—",
            v !== null ? v.toFixed(3) : "—",
          ],
          tweet: `${short(a.owner)} moved ${v?.toFixed(2) ?? "?"} SOL ${when} on ${SITE}`,
        };
      });
      return {
        cols: [{ label: "Trades", num: true }, { label: "Markets", num: true }, { label: "Top market" }, { label: "Net flow (SOL)", num: true }, { label: "Volume (SOL)", num: true }],
        rows,
        note: "top 20 wallets",
      };
    }
    if (cat === "held") {
      const best = new Map<string, Win>();
      for (const w of data.wins) if (w.ts >= since && (!best.has(w.wallet) || w.hold_s > best.get(w.wallet)!.hold_s)) best.set(w.wallet, w);
      const rows = [...best.values()]
        .sort((a, b) => b.hold_s - a.hold_s)
        .slice(0, 50)
        .map(
          (w): Ranked => ({
            wallet: w.wallet,
            metric: hms(w.hold_s),
            line: `${w.ticker} ${w.kind === "exit" ? (w.side === 1 ? "DOWN" : "UP") : "vault"} · +${sol(w.gain_sol)} SOL`,
            cells: [<WhatChip w={w} />, hasBasis(w) ? mult(w) : "—", <span className="up">+{sol(w.gain_sol)}</span>, hms(w.hold_s)],
            tweet: `${short(w.wallet)} held $${w.ticker} for ${hms(w.hold_s)} and took +${sol(w.gain_sol)} SOL on ${SITE}`,
          }),
        );
      return { cols: [{ label: "Position" }, { label: "Return", num: true }, { label: "Won (SOL)", num: true }, { label: "Held", num: true }], rows, note: "winning exits" };
    }
    const rows = (data.refs?.[period] ?? []).map(
      (r): Ranked => ({
        wallet: r.wallet,
        metric: `+${sol(r.earned_sol, 4)} SOL`,
        tone: "up",
        line: `${r.referred_wallets} wallets · ${r.deposits} deposits`,
        cells: [r.referred_wallets, r.deposits, sol(r.referred_sol, 2), <span className="up">+{sol(r.earned_sol, 4)}</span>],
        tweet: `${short(r.wallet)} earned +${sol(r.earned_sol, 4)} SOL referring ${when} on ${SITE}`,
      }),
    );
    return { cols: [{ label: "Wallets", num: true }, { label: "Deposits", num: true }, { label: "Referred (SOL)", num: true }, { label: "Earned (SOL)", num: true }], rows };
  }, [data, cat, period, active.data, px.rate, since, when, hours]);
  return { board, loading: cat === "volume" && !!hours && active.loading && !active.data };
}

/** Top three, #1 in the middle and lifted; each card tweets itself. */
function Podium({ rows, me }: { rows: Ranked[]; me?: string }) {
  const order = [1, 0, 2].filter((i) => rows[i]);
  return (
    <div className="podium3">
      {order.map((i) => {
        const r = rows[i];
        return (
          <div key={r.wallet} className={`pod p${i} ${r.wallet === me ? "me" : ""}`}>
            <span className="pod-share">
              <Tweet text={`#${i + 1} ${r.tweet}`} path={`/p/${r.wallet}`} />
            </span>
            <span className="pod-rank num">{i + 1}</span>
            <Avatar wallet={r.wallet} size={i === 0 ? 52 : 44} />
            <Link to={`/p/${r.wallet}`} className="pod-who num">
              {short(r.wallet)}
              {r.wallet === me && <span className="chip you">you</span>}
            </Link>
            <b className={`pod-metric num ${r.tone ?? ""}`}>{r.metric}</b>
            <span className="meta pod-line">{r.line}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Where you stand this window, or how to get on the board. */
function RankCta({ data, period, me }: { data: Feed; period: Period; me?: string }) {
  const board = data.boards?.[period] ?? [];
  const i = me ? board.findIndex((b) => b.wallet === me) : -1;
  if (!me)
    return (
      <div className="tcard rank-cta">
        <div>
          <b>Get on the board</b>
          <span className="muted">Connect, pick a side, close it green.</span>
        </div>
        <WalletButton solo />
      </div>
    );
  if (i < 0)
    return (
      <div className="tcard rank-cta">
        <div>
          <b>No closed trades in {PERIOD_LABEL[period]}</b>
          <span className="muted">Close a trade to get ranked.</span>
        </div>
        <Link className="btn signal small" to="/">
          Start trading
        </Link>
      </div>
    );
  const r = board[i];
  return (
    <div className="tcard rank-cta">
      <div>
        <b>
          You're #{i + 1} · <span className={r.net_sol >= 0 ? "up" : "down"}>{`${r.net_sol >= 0 ? "+" : ""}${sol(r.net_sol)} SOL`}</span>
        </b>
        <span className="muted">{i > 0 ? `+${sol(board[i - 1].net_sol - r.net_sol)} SOL to pass #${i}` : "Top of the board. Hold it."}</span>
      </div>
      <Link className="btn ghost small" to="/">
        Trade
      </Link>
    </div>
  );
}

/** The 24h race with prizes, when one runs (rounds are set by hand in api/winners.ts); the last one's payout when none does. */
function RaceBanner({ race, me }: { race: Race; me?: string }) {
  const now = useNow();
  const r = race.live;
  if (!r) {
    const last = race.last;
    if (!last) return null;
    const paid = last.prizes_sol.reduce((a, b) => a + b, 0);
    return (
      <div className="race-banner done">
        <span className="meta">last race</span>
        <b className="num">{paid} SOL paid</b>
        {last.leaders.slice(0, last.prizes_sol.length).map((l, i) => (
          <span key={l.wallet} className="chip num">
            {MEDAL[i]} {short(l.wallet)} {last.prizes_sol[i]} SOL
          </span>
        ))}
        <span className="meta num">{et(last.end)}</span>
        {!last.final && <span className="chip">final scan pending</span>}
      </div>
    );
  }
  const left = Math.max(0, r.end - now);
  const prize = r.prizes_sol.reduce((a, b) => a + b, 0);
  const myIdx = me ? r.leaders.findIndex((l) => l.wallet === me) : -1;
  const clock = [Math.floor(left / 3600), Math.floor((left % 3600) / 60), left % 60].map((v) => String(v).padStart(2, "0")).join(":");
  return (
    <div className={`race-banner ${left < 3600 ? "hot" : ""}`}>
      <span className="live-dot" aria-hidden />
      <b className="num">{prize} SOL race</b>
      <span className="num race-clock">{clock}</span>
      {r.prizes_sol.map((p, i) => (
        <span key={i} className="chip num">
          {MEDAL[i]} {r.leaders[i] ? short(r.leaders[i].wallet) : "open"} · {p} SOL
        </span>
      ))}
      {myIdx >= 0 && <span className="chip you">you're #{myIdx + 1}</span>}
      <CardShare text={`${prize} SOL race on ${SITE} · ${clock} left`} path="/winners" />
      <Link to="/" className="btn signal small">
        Enter race →
      </Link>
    </div>
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
  const rows = [...wins].sort(sorters.latest).slice(0, 6);
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

const parsePeriod = (s: string | null): Period => (PERIODS.includes(s as Period) ? (s as Period) : "24h");
const parseCat = (s: string | null): Category => (CATS.some((c) => c.id === s) ? (s as Category) : "pnl");

export default function WinnersPage() {
  const { data, error, loading } = usePoll(load, [], 15_000);
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const q = useQuery();
  const period = parsePeriod(q.get("period"));
  const category = parseCat(q.get("category"));
  const [rank, setRank] = useState<Rank>("gain");
  const [only, setOnly] = useState<"all" | "exit" | "unpark">("all");
  // Memes · Majors · Stonks by the market each win came from (vault unparks have no coin: they only show under All)
  const { cat, setCat, counts, filtered: inCat } = useCatRows(data?.wins ?? NO_WINS, (w) => w.category ?? "other");
  const rows = useMemo(() => {
    const w = inCat.filter((x) => only === "all" || x.kind === only);
    return [...w].sort(sorters[rank]).slice(0, 300);
  }, [inCat, rank, only]);
  const best = useMemo(() => {
    const w = (data?.wins ?? []).filter(hasBasis);
    return w.length ? w.reduce((a, b) => (b.ret > a.ret ? b : a)) : null;
  }, [data]);
  const fastest = useMemo(() => (data?.wins.length ? data.wins.reduce((a, b) => ((b.per_hour_sol ?? 0) > (a.per_hour_sol ?? 0) ? b : a)) : null), [data]);
  /** Cumulative SOL won over the last 200 realized wins, oldest → newest. Real wins only; this is what the "won all-time" card draws. */
  const curve = useMemo(() => {
    const w = [...(data?.wins ?? [])].sort((a, b) => a.ts - b.ts).slice(-200);
    let acc = 0;
    return w.map((x) => ({ ts: x.ts, price: (acc += x.gain_sol) }));
  }, [data]);
  const catDef = CATS.find((c) => c.id === category)!;
  const head = (
    <>
      <Link to="/" className="back-link">
        ← Markets
      </Link>
      <header className="lb-head">
        <div>
          <h1>Leaderboard</h1>
          <p className="muted">{catDef.rule}</p>
        </div>
        <div className="seg-mini" role="tablist" aria-label="Window">
          {PERIODS.map((p) => (
            <button key={p} role="tab" aria-selected={p === period} disabled={category === "volume" && (p === "30d" || p === "all")} onClick={() => q.set({ period: p })}>
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>
      </header>
      <div className="lb-cats" role="tablist" aria-label="Category">
        {CATS.map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={c.id === category}
            className="lb-cat"
            onClick={() => q.set({ category: c.id, period: c.id === "volume" && (period === "30d" || period === "all") ? "7d" : period })}
          >
            <span aria-hidden>{c.icon}</span> {c.label}
          </button>
        ))}
      </div>
    </>
  );
  if (!data)
    return (
      <div className="lb-page">
        {head}
        <div className="lb-grid">
          <div className="podium3">
            {[0, 1, 2].map((i) => (
              <span key={i} className="skeleton" style={{ height: 170 }} />
            ))}
          </div>
          <span className="skeleton" style={{ height: 200 }} />
        </div>
        {error && !loading && <p className="err">Leaderboard unavailable: {error}. Retrying every 15 s.</p>}
      </div>
    );
  return (
    <div className="lb-page">
      {head}
      {data.race && <RaceBanner race={data.race} me={me} />}
      <div className="lb-grid">
        <LeaderMain data={data} category={category} period={period} me={me} />
        <aside className="lb-aside">
          <RankCta data={data} period={period} me={me} />
          <PnlCard key={period} initial={period === "30d" ? "7d" : period} />
          {best && (
            <div className="tcard stat-card">
              <span className="meta stat-head">
                best return
                <CardShare text={`${winText(best, "took")} on ${SITE}`} path={winPath(best)} />
              </span>
              <Link to={`/m/${best.market}?side=${best.kind === "exit" ? best.side ?? 0 : "yield"}`} className={`display huge num ${best.side === 1 ? "down" : "up"}`}>
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
            <div className="tcard stat-card">
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
          <div className="tcard stat-card">
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
          <h2 className="lb-sub">
            <span className="live-dot" aria-hidden /> Landing now
          </h2>
          {inCat.length > 0 ? <Landing wins={inCat} /> : cat ? <CatEmpty cat={cat} what="won yet" to={`/?cat=${cat}`} cta="pick a side →" /> : <p className="note">No wins yet. Empty side pays.</p>}
        </aside>
      </div>

      <section className="tcard lb-every" aria-label="All-time wins">
        <div className="winners-bar">
          <h2 className="lb-sub">Every win. Ever.</h2>
          <CatFilter cat={cat} onChange={setCat} counts={counts} />
          <div className="seg-mini" role="tablist" aria-label="rank by">
            {(["gain", "ret", "speed", "latest"] as Rank[]).map((r) => (
              <button key={r} role="tab" aria-selected={rank === r} onClick={() => setRank(r)}>
                {r === "gain" ? "Biggest" : r === "speed" ? "SOL/hr" : r === "ret" ? "Best ×" : "Latest"}
              </button>
            ))}
          </div>
          <div className="seg-mini" role="tablist" aria-label="kind">
            {(["all", "exit", "unpark"] as const).map((k) => (
              <button key={k} role="tab" aria-selected={only === k} onClick={() => setOnly(k)}>
                {k === "all" ? "All" : k === "exit" ? "UP/DOWN" : "Vaults"}
              </button>
            ))}
          </div>
        </div>
        {rows.length > 0 ? (
          <div className="lb-scroll">
            <table className="lb-table winners-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Trader</th>
                  <th>Position</th>
                  <th className="num">×</th>
                  <th className="num">In</th>
                  <th className="num">Out</th>
                  <th className="num">Won</th>
                  <th className="num">Held</th>
                  <th className="num">SOL/hr</th>
                  <th>When</th>
                  <th aria-label="share" />
                </tr>
              </thead>
              <tbody>
                {rows.map((w, i) => (
                  <tr key={w.sig} className={w.wallet === me ? "me" : undefined}>
                    <td className="rank num">{i + 1}</td>
                    <td>
                      <Link to={`/p/${w.wallet}`} className="lb-who num">
                        <Avatar wallet={w.wallet} size={22} />
                        {short(w.wallet)}
                      </Link>
                    </td>
                    <td>
                      <WhatChip w={w} />
                    </td>
                    <td className={`num mult-cell ${hasBasis(w) && w.ret >= 1 ? "up" : ""}`}>{mult(w)}</td>
                    <td className="num">{sol(w.cost_sol)}</td>
                    <td className="num">{sol(w.out_sol)}</td>
                    <td className="num up">+{sol(w.gain_sol)}</td>
                    <td className="num">{held(w.hold_s)}</td>
                    <td className="num">{w.per_hour_sol === null ? "—" : sol(w.per_hour_sol, 4)}</td>
                    <td className="sub">
                      <a href={`https://solscan.io/tx/${w.sig}`} target="_blank" rel="noreferrer">
                        {ago(w.ts)} ↗
                      </a>
                    </td>
                    <td className="share-cell">
                      <Tweet text={`${winText(w, "took")} on ${SITE}`} path={winPath(w)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : cat && data.wins.length > 0 ? (
          <CatEmpty cat={cat} what="won yet" to={`/?cat=${cat}`} cta="pick a side →" />
        ) : (
          <div className="pnl-empty">
            <b>No wins yet.</b>
            <p>Empty side pays.</p>
          </div>
        )}
        <details className="fine">
          <summary>what counts</summary>
          <ul className="rule-bits">
            <li>in/out in SOL</li>
            <li>average cost basis</li>
            <li>held since buy</li>
            <li>
              raw: <a href="/api/winners">/api/winners</a>
            </li>
          </ul>
        </details>
      </section>
    </div>
  );
}

function LeaderMain({ data, category, period, me }: { data: Feed; category: Category; period: Period; me?: string }) {
  const { board, loading } = useBoard(data, category, period);
  if (board.unavailable)
    return (
      <div className="lb-main">
        <div className="tcard pnl-empty">
          <b>{board.unavailable}</b>
        </div>
      </div>
    );
  if (loading)
    return (
      <div className="lb-main">
        <div className="podium3">
          {[0, 1, 2].map((i) => (
            <span key={i} className="skeleton" style={{ height: 170 }} />
          ))}
        </div>
      </div>
    );
  if (!board.rows.length)
    return (
      <div className="lb-main">
        <div className="tcard pnl-empty lb-empty">
          <b>Nobody on this board {period === "all" ? "yet" : `in the last ${PERIOD_LABEL[period]}`}.</b>
          <p>First green close takes #1.</p>
          <Link className="btn signal small" to="/">
            Start trading
          </Link>
        </div>
      </div>
    );
  const rest = board.rows.slice(3);
  return (
    <div className="lb-main">
      <Podium rows={board.rows} me={me} />
      {rest.length > 0 && (
        <div className="tcard lb-scroll lb-tablecard">
          <table className="lb-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Trader</th>
                {board.cols.map((c) => (
                  <th key={c.label} className={c.num ? "num" : undefined}>
                    {c.label}
                  </th>
                ))}
                <th aria-label="share" />
              </tr>
            </thead>
            <tbody>
              {rest.map((r, i) => (
                <tr key={r.wallet} className={r.wallet === me ? "me" : undefined}>
                  <td className="rank num">{i + 4}</td>
                  <td>
                    <Link to={`/p/${r.wallet}`} className="lb-who num">
                      <Avatar wallet={r.wallet} size={28} />
                      {short(r.wallet)}
                      {r.wallet === me && <span className="chip you">you</span>}
                    </Link>
                  </td>
                  {r.cells.map((c, j) => (
                    <td key={j} className={board.cols[j]?.num ? "num" : undefined}>
                      {c}
                    </td>
                  ))}
                  <td className="share-cell">
                    <Tweet text={`#${i + 4} ${r.tweet}`} path={`/p/${r.wallet}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {board.note && <p className="meta lb-note">{board.note}</p>}
    </div>
  );
}
