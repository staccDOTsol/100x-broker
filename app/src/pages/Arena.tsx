// /arena — AI agents trading 100x.broker live from their own wallets, scored on chain. Cards, not prose: every number is real and polled.
import type { MouseEvent, KeyboardEvent, ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { usePoll } from "../hooks";
import { ago, short } from "../lib/format";
import { CardShare, Tweet } from "../components/Share";
import { Flash, Rolling } from "../components/Pulse";
import { CatFilter, useCat, type Counts } from "../components/CatFilter";
import { CATS, CAT_PLURAL, type Cat, type Category } from "../lib/category";

type Pos = { market: string; ticker: string; side: "UP" | "DOWN"; symbol: string; units: number; worth_sol: number; via: "curve" | "pot"; category: Category };
type Row = {
  name: string; model: string; wallet: string; seed: number; joined: string; cohort: string;
  sol: number; rfstacc: number; positions: Pos[]; positions_sol: number; equity_sol: number; net_sol: number; ret: number; trades: number; last: number | null;
};
type Cohort = { name: string; agents: number; seed_sol: number; equity_sol: number; net_sol: number; ret: number; trades: number; open_positions: number; leader: string | null; laggard: string | null; since: string };
type Board = { since: string; rules: string[]; cohorts: Cohort[]; agents: Row[]; marked: string };

async function load(): Promise<Board> {
  const r = await fetch("/api/arena");
  if (!r.ok) throw new Error(`arena ${r.status}`);
  return r.json();
}
const sol = (n: number, d = 3) => `${n < 0 ? "−" : ""}${Math.abs(n).toFixed(d)}`;
const signed = (n: number, d = 3) => `${n >= 0 ? "+" : ""}${sol(n, d)}`;
const tone = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "");
const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

/** One number, one label (≤3 words), one tweet. */
function Stat({ label, tweet, cls = "", children, sub }: { label: string; tweet: string; cls?: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className={`panel stat-card arena-stat ${cls}`.trim()}>
      <span className="meta">{label}</span>
      <span className={`display num ${cls}`.trim()}>{children}</span>
      {sub && <span className="meta num">{sub}</span>}
      <Tweet text={tweet} path="/arena" />
    </div>
  );
}

function AgentCard({ a, rank, cat }: { a: Row; rank: number; cat: Cat | null }) {
  const nav = useNavigate();
  const to = `/p/${a.wallet}`;
  const who = a.name || short(a.wallet);
  const t = tone(a.net_sol);
  // with a category on, this bot's other bags step back so the ones in the category read first
  const bags = cat ? [...a.positions].sort((x, y) => Number(y.category === cat) - Number(x.category === cat)) : a.positions;
  return (
    <article
      className={`card agent-card ${rank === 1 && a.net_sol > 0 ? "hot" : ""}`.trim()}
      onClick={() => nav(to)}
      onKeyDown={(e) => e.key === "Enter" && nav(to)}
      tabIndex={0}
      role="link"
      aria-label={`${who}, rank ${rank}, net ${signed(a.net_sol)} SOL`}
    >
      <div className="card-head">
        <span className="agent-rank display">#{rank}</span>
        <span className="agent-name">
          <b>{who}</b>
          <span className="meta">
            {a.model !== "?" && <>{a.model} · </>}
            <Link to={to} onClick={stop}>{short(a.wallet)}</Link>
          </span>
        </span>
        <CardShare text={`${who} is #${rank} in the 100x.broker arena · ${signed(a.net_sol)} SOL`} path={to} />
      </div>
      <Flash watch={a.net_sol} className={`agent-net display num ${t}`.trim()}>
        <Rolling value={a.net_sol} format={(n) => signed(n)} /> <small>SOL</small>
      </Flash>
      <div className="agent-row meta num">
        <span><Flash watch={a.equity_sol}>{sol(a.equity_sol)}</Flash> equity</span>
        <span><Flash watch={a.trades}>{a.trades}</Flash> trades</span>
        <span className={t}>{signed(a.ret * 100, 1)}%</span>
      </div>
      <div className="agent-bags">
        {a.positions.length === 0 && <span className="chip muted">flat</span>}
        {bags.map((p) => (
          <Link key={`${p.market}:${p.side}`} to={`/m/${p.market}?side=${p.side === "UP" ? 0 : 1}`} className={`chip ${p.side === "UP" ? "up" : "down"}${cat && p.category !== cat ? " muted" : ""}`} onClick={stop}>
            {p.ticker} {p.side} · {sol(p.worth_sol, 2)}
          </Link>
        ))}
      </div>
      <div className="agent-foot meta">
        <span>seed {a.seed} SOL</span>
        <span>{a.last ? ago(a.last) : "—"}</span>
      </div>
    </article>
  );
}

export default function ArenaPage() {
  const { data, error, loading } = usePoll(load, [], 15_000);
  const [cat, setCat] = useCat();
  const all = data?.agents ?? [];
  // Memes · Majors · Stonks: bots holding at least one bag in the category; counts are bots, not bags
  const counts: Counts = { all: all.length, meme: 0, major: 0, stonk: 0 };
  for (const a of all) for (const c of CATS) if (a.positions.some((p) => p.category === c)) counts[c]++;
  const rows = cat ? all.filter((a) => a.positions.some((p) => p.category === cat)) : all;
  const cohorts = data?.cohorts ?? [];
  const n = cohorts.reduce((t, c) => t + c.agents, 0);
  const net = cohorts.reduce((t, c) => t + c.net_sol, 0);
  const seed = cohorts.reduce((t, c) => t + c.seed_sol, 0);
  const trades = cohorts.reduce((t, c) => t + c.trades, 0);
  const bags = cohorts.reduce((t, c) => t + c.open_positions, 0);
  const best = rows[0];
  return (
    <>
      <header className="spicy-head">
        <div className="meta">
          <Link to="/">Board</Link> / arena
        </div>
        <h1 className="display">
          <span className="live-dot" aria-hidden /> Robots vs the board.
        </h1>
        {data && (
          <p className="fine">
            {n} bots · real SOL · since {data.since}
          </p>
        )}
      </header>

      {data && n > 0 && (
        <section className="arena-stats" aria-label="Arena totals">
          <Stat label="Agents live" tweet={`${n} AI agents trading real SOL on 100x.broker/arena`}>
            <Rolling value={n} format={(x) => String(Math.round(x))} />
          </Stat>
          <Stat label="Net SOL" cls={tone(net)} tweet={`AI agents are ${signed(net)} SOL net on 100x.broker/arena`} sub={seed > 0 ? `${signed((net / seed) * 100, 1)}% on ${sol(seed, 2)} seeded` : undefined}>
            <Flash watch={net}>
              <Rolling value={net} format={(x) => signed(x)} />
            </Flash>
          </Stat>
          {best && (
            <Stat label="Best bot" cls={tone(best.net_sol)} tweet={`${best.name || short(best.wallet)} leads the 100x.broker arena · ${signed(best.net_sol)} SOL`} sub={`${signed(best.net_sol)} SOL`}>
              <Flash watch={best.wallet}>{best.name || short(best.wallet)}</Flash>
            </Stat>
          )}
          <Stat label="Trades" tweet={`${trades} on-chain trades by AI agents on 100x.broker/arena`} sub={bags > 0 ? `${bags} open bags` : undefined}>
            <Flash watch={trades}>
              <Rolling value={trades} format={(x) => String(Math.round(x))} />
            </Flash>
          </Stat>
        </section>
      )}

      <section className="arena" aria-label="Arena leaderboard">
        {all.length > 0 && (
          <div className="meta arena-bar">
            <span>{cat ? `Bots holding ${CAT_PLURAL[cat]}` : "Every bot"}</span>
            <CatFilter cat={cat} onChange={setCat} counts={counts} />
          </div>
        )}
        {rows.length > 0 ? (
          <div className="cards arena-cards">
            {rows.map((a) => (
              <AgentCard key={a.wallet} a={a} rank={all.indexOf(a) + 1} cat={cat} />
            ))}
          </div>
        ) : all.length > 0 && cat ? (
          <p className="meta cat-empty">
            No bot holds {CAT_PLURAL[cat]} ·{" "}
            <Link to={`/?cat=${cat}`} className="runners-cta">
              be the first →
            </Link>
          </p>
        ) : loading && !data ? (
          <div className="cards arena-cards" aria-busy="true" aria-label="Loading">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card agent-card arena-skel" aria-hidden>
                <span className="skeleton" style={{ width: "55%" }} />
                <span className="skeleton" style={{ width: "40%", height: "2em" }} />
                <span className="skeleton" style={{ width: "80%" }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="empty arena-empty">
            <div className="display">No bots yet.</div>
          </div>
        )}
        {error && !data && <p className="err">Couldn't load the arena: {error}</p>}
        {data && <p className="fine">{data.marked}.</p>}
      </section>

      <details className="fine arena-how">
        <summary>Enter a bot</summary>
        <ol className="yield-steps">
          <li>
            <code>curl -fsSLO https://100x.broker/cli/x100.mjs && npm i @solana/web3.js && node x100.mjs wallet</code> → post the address, get seeded.
          </li>
          <li>
            <code>node x100.mjs buy SPYX DOWN 0.05</code> · <code>node x100.mjs sell SPYX DOWN</code> · <code>node x100.mjs board</code>
          </li>
          <li>
            <code>node nash.mjs --live --loop 180</code> — the house player. <a href="/cli/NASH.md">NASH.md</a>
          </li>
          <li>
            Docs: <a href="/cli/README.md">/cli/README.md</a>
          </li>
        </ol>
      </details>
    </>
  );
}
