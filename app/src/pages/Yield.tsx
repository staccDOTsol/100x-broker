// /yield — delta-neutral LP vaults as cards: ticker, parked, projected, receipt. Every card tweets itself with the referral baked in.
// The helpers (loadRow, vaultNumbers, badges) are shared with the vault's own page (/yield/:vault) and the market-page widget.
import { Link } from "react-router-dom";
import { usePoll } from "../hooks";
import { usePrices } from "../hooks/price";
import { useUnderlying } from "../hooks/underlying";
import { DAY, YEAR, ageLabel, fetchVaultFeed, growthSince, listVaults, loadVault, poolApr, vaultCreatedTs, yearsToMultiple, type Vault, type VaultView } from "../lib/dn";
import { Bolt } from "../components/Numbers";
import { Delta, Flash, Rolling } from "../components/Pulse";
import { VaultTicket } from "../components/VaultTicket";
import { amount as fmtAmount, short, usd } from "../lib/format";
import { hedgeCoverage } from "../lib/dn";
import { useRefWallet, vaultShare } from "../components/Flex";
import { CardShare } from "../components/Share";

export type Row = VaultView & { apr: Awaited<ReturnType<typeof poolApr>> };
const created = new Map<string, number | null>();
/** One vault with its pool APR; the birth timestamp is fetched once per session. */
export async function loadRow(v: Vault): Promise<Row> {
  const k = v.key.toBase58();
  if (!created.has(k)) {
    // the signature scan through the proxy gets rate-limited; the vault's own feed (edge-cached) knows when it was born too.
    // Only a real timestamp is cached — a miss is retried on the next poll instead of showing "warming up" all day.
    let ts = await vaultCreatedTs(v.key).catch(() => null);
    if (ts === null) ts = await fetchVaultFeed(k).then((evs) => evs.find((e) => e.kind === "born")?.ts ?? evs[evs.length - 1]?.ts ?? null).catch(() => null);
    if (ts !== null) created.set(k, ts);
  }
  const [view, apr] = await Promise.all([loadVault(v, created.get(k) ?? null), poolApr(v.pool)]);
  return { ...view, apr };
}
async function loadAll(): Promise<Row[]> {
  return Promise.all((await listVaults()).map(loadRow));
}

/** Compounded multiples from hours of data get astronomically large; say so with a power of ten instead of a shrug. */
export const fmtMult = (mult: number): string => {
  if (!Number.isFinite(mult)) return "×10^300+";
  if (mult - 1 < 1e7) return fmtBig(mult - 1);
  return `×10^${Math.floor(Math.log10(mult))}`;
};
/** Extrapolations from hours of data explode; print the whole number with commas, and past a billion percent switch to a power of ten. */
export const fmtBig = (x: number): string => {
  if (!Number.isFinite(x) || x > 1e7) return fmtMult(x + 1);
  if (x < -0.9999) return "−100%";
  const pct = Math.abs(x * 100);
  return `${x < 0 ? "−" : "+"}${pct.toLocaleString("en-US", { maximumFractionDigits: pct >= 100 ? 0 : 1, minimumFractionDigits: pct >= 100 ? 0 : 1 })}%`;
};
export const pct0 = (x: number) => `${(x * 100).toFixed(Math.abs(x * 100) >= 100 ? 0 : 1)}%`;
/** Signed, 2 dp, a real minus sign: "+0.12%", "−0.41%". */
export const pctSigned = (x: number) => `${x < 0 ? "−" : "+"}${Math.abs(x * 100).toFixed(2)}%`;
/** The realized line: the pace extrapolated (simple, compounded, doubling time) and what it is made of (fees at the pool's rate, the rest is the hedge). */
export function realizedNote(raw: { change: number; age: number; apr: number }, projected: number | null): string {
  if (raw.change < 0 && raw.age < DAY) return "day-one costs, not a trend";
  const fees = projected !== null ? projected * (raw.age / YEAR) : null;
  const split = fees !== null ? ` · fees ${pctSigned(fees)} · hedge ${pctSigned(raw.change - fees)}` : "";
  if (raw.change <= 0) return `${fmtBig(raw.apr)}/yr simple${split}`;
  const mult = Math.pow(1 + raw.change, YEAR / raw.age);
  return `${fmtBig(raw.apr)}/yr simple · ${fmtMult(mult)} compounded · 2× in ${doubling(raw.change, raw.age)}${split}`;
}
/** How long the share price takes to double if it keeps the pace it set over `ageSecs`. */
export function doubling(change: number, ageSecs: number) {
  if (!(change > 0) || !(ageSecs > 0)) return "—";
  return horizon((ageSecs * (Math.log(2) / Math.log(1 + change))) / 31_557_600);
}
export function horizon(years: number | null) {
  if (years === null) return "—";
  if (!Number.isFinite(years) || years > 500) return "heat death";
  const days = years * 365.25;
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} h`;
  if (days < 90) return `${Math.round(days)} ${Math.round(days) === 1 ? "day" : "days"}`;
  if (years < 2) return `${Math.round(days / 30.4)} months`;
  return `${years.toFixed(1)} years`;
}

/** Everything the tiles and badges derive from one row. */
export function vaultNumbers(r: Row) {
  const { v, x, apr } = r;
  const lpVal = x.xVal + x.solPos;
  const lpShare = x.nav > 0n ? Number(lpVal) / Number(x.nav) : 0;
  const projected = apr && apr.day > 0 ? (apr.day / 100) * lpShare : null;
  // the pool quotes a simple rate (fees over the last 24 h, annualised); the keeper harvests and redeploys, so daily compounding is the honest headline
  const compounded = projected !== null ? Math.pow(1 + projected / 365, 365) - 1 : null;
  const growth = growthSince(x.sharePrice, r.createdTs);
  const sustained = growth?.kind === "apy" ? growth.apy : null;
  // what the share price has actually done, compounded forward at that pace: the owner's rule is that this is the headline whenever
  // it exists (an hour of data or more, going up); the pool-fee projection is the fallback and the footnote
  const pace = growth?.kind === "raw" && growth.change > 0 && growth.age >= 3600 ? { change: growth.change, age: growth.age, simple: growth.apr, mult: Math.pow(1 + growth.change, YEAR / growth.age) } : null;
  const headline = pace ? pace.mult - 1 : compounded ?? sustained;
  const hedged = x.dStar === 0n ? x.d === 0n : x.errBps <= BigInt(v.bandBps);
  const cover = hedgeCoverage(x);
  return { lpVal, lpShare, projected, compounded, growth, sustained, pace, headline, hedged, cover };
}

/** Lamports → rolling USD, or a dash until the SOL price is known. Never invents a number. */
export function Money({ lamports }: { lamports: bigint }) {
  const px = usePrices();
  const u = px.lamportsUsd(lamports);
  return u === null ? <span className="muted">—</span> : <Rolling value={u} format={usd} />;
}

export default function YieldPage() {
  const { data, loading, error, refresh } = usePoll(loadAll, []);
  const rows = data ?? [];
  const tvl = rows.reduce((s, r) => s + r.x.nav, 0n);
  return (
    <>
      <header className="yield-head">
        <div className="yield-copy">
          <div className="meta">
            <Link to="/">Board</Link> / yield
          </div>
          <h1 className="display">Park SOL.</h1>
          <p className="num yield-line">LP · hedge · keep the fees</p>
          <details className="fine">
            <summary>how</summary>
            <ul className="yield-frags">
              <li>LP the pool</li>
              <li>Hedge with DOWN</li>
              <li>Keep fees</li>
              <li>Receipt gets heavier</li>
            </ul>
          </details>
        </div>
        <div className="stat-card yield-tvl">
          <span className="meta">
            <Bolt stamp={tvl.toString()} /> parked
          </span>
          <strong className="display num">
            <Money lamports={tvl} />
          </strong>
          <span className="meta num">
            {rows.length} vault{rows.length === 1 ? "" : "s"} · {fmtAmount(tvl, 9, 3)} SOL
          </span>
        </div>
      </header>
      {loading && !data && <span className="skeleton" style={{ height: 220 }} />}
      {error && !data && <p className="note">Vaults are taking a breather: {error}</p>}
      <div className="vault-cards">
        {rows.map((r) => (
          <VaultCard key={r.v.key.toBase58()} r={r} onDone={refresh} />
        ))}
      </div>
      {data && rows.length === 0 && <p className="note">No vaults yet.</p>}
    </>
  );
}

/** The four tiles: projected APY, what the share price has actually done, doubling horizon, parked. */
export function VaultNums({ r }: { r: Row }) {
  const { x } = r;
  const { compounded, growth, sustained, pace, headline } = vaultNumbers(r);
  const raw = growth?.kind === "raw" ? growth : null;
  return (
    <div className="vc-nums">
      <div className="vc-num">
        <span className="meta">{pace ? `APY · ${ageLabel(pace.age).replace(/ old$/, "")}` : "APY · projected"}</span>
        <strong className="display">{pace ? fmtMult(pace.mult) : compounded !== null ? <Rolling value={compounded} format={pct0} /> : "—"}</strong>
        <span className="meta num">{pace ? `${fmtBig(pace.simple)}/yr simple` : r.apr ? `pool ${r.apr.day.toFixed(1)}%/yr` : "no pool rate"}</span>
      </div>
      <div className="vc-num">
        <span className="meta">realized</span>
        <strong className={`display ${raw ? (raw.change < 0 ? "down" : "up") : ""}`}>
          {sustained !== null ? <Rolling value={sustained} format={pct0} /> : raw ? <Rolling value={raw.change} format={pctSigned} /> : <span className="muted">warming up</span>}
        </strong>
        <span className="meta num">
          <Flash watch={x.sharePrice}>{x.sharePrice.toFixed(6)} SOL</Flash>
          {growth ? <> · {ageLabel(growth.age)}</> : null}
        </span>
      </div>
      <div className="vc-num">
        <span className="meta">2× in</span>
        <strong className="display">{pace ? doubling(pace.change, pace.age) : horizon(headline !== null ? yearsToMultiple(headline, 2) : null)}</strong>
        <span className="meta num">10× in {pace ? horizon((pace.age * (Math.log(10) / Math.log(1 + pace.change))) / YEAR) : horizon(headline !== null ? yearsToMultiple(headline, 10) : null)}</span>
      </div>
      <div className="vc-num">
        <span className="meta">parked</span>
        <strong className="display">
          <Money lamports={x.nav} />
        </strong>
        <span className="meta num">{fmtAmount(x.nav, 9, 4)} SOL · {fmtAmount(x.supply, 9, x.supply < 1_000_000_000n ? 3 : 2)} receipts</span>
      </div>
    </div>
  );
}

/** LP / DOWN bucket / dry powder / keeper cut. */
export function VaultStats({ r, ticker }: { r: Row; ticker: string }) {
  const { v, x } = r;
  const px = usePrices();
  const { lpVal } = vaultNumbers(r);
  return (
    <dl className="vc-stats">
      <div>
        <dt>LP</dt>
        <dd className="num">
          {usd(px.lamportsUsd(lpVal))} <span className="muted">{fmtAmount(x.xTotal, x.xDecimals, 0)} {ticker} + {fmtAmount(x.solPos, 9, 3)} SOL</span>
        </dd>
      </div>
      <div>
        <dt>DOWN bucket</dt>
        <dd className="num">
          {usd(px.lamportsUsd(x.d))} <span className="muted">target {usd(px.lamportsUsd(x.dStar))}</span>
        </dd>
      </div>
      <div>
        <dt>Dry powder</dt>
        <dd className="num">{fmtAmount(x.free + x.wsol + x.quoteSol, 9, 4)} SOL</dd>
      </div>
      <div>
        <dt>Keeper cut</dt>
        <dd className="num">{v.keeperBps / 100}%</dd>
      </div>
    </dl>
  );
}

export function HedgeBadge({ r }: { r: Row }) {
  const { x } = r;
  const { hedged, cover } = vaultNumbers(r);
  const tight = cover.down >= 0.8 && cover.up >= 0.8;
  return (
    <span className={`badge ${hedged && tight ? "ok" : "warn"}`} title={`Hedge ${hedged ? "sized" : "drifting"} · ${x.errBps.toString()} bps off target · covers a pump ${pct0(cover.up)}, a dump ${pct0(cover.down)}`}>
      <Bolt stamp={x.d.toString()} title="hedge" /> {hedged ? "hedged" : "drifting"} · ↓{pct0(cover.down)}
    </span>
  );
}

function VaultCard({ r, onDone }: { r: Row; onDone: () => void }) {
  const { v, x } = r;
  const under = useUnderlying(r.underlying);
  const ticker = under?.symbol ?? short(r.underlying);
  const key = v.key.toBase58();
  const refWallet = useRefWallet();
  const { compounded } = vaultNumbers(r);
  const apy = compounded !== null ? pct0(compounded) : null;
  const live = x.supply > 0n;
  return (
    <section className="card vault-tile" id={key}>
      <div className="card-head">
        {under?.image && <img className="tokimg" src={under.image} alt="" />}
        <Link className="card-ticker display" to={`/yield/${key}`}>
          ${ticker}
          <span className="muted">/SOL</span>
        </Link>
        <HedgeBadge r={r} />
      </div>
      <div className="tile-nums">
        <div className="tile-num">
          <span className="meta">
            <Bolt stamp={x.nav.toString()} /> parked
          </span>
          <strong className="display num">
            <Money lamports={x.nav} />
          </strong>
          <span className="meta num">{fmtAmount(x.nav, 9, 3)} SOL</span>
        </div>
        {compounded !== null && (
          <div className="tile-num up">
            <span className="meta">projected APY</span>
            <strong className="display num">
              <Rolling value={compounded} format={pct0} />
            </strong>
            <span className="meta num">pool fees</span>
          </div>
        )}
        <div className="tile-num">
          <span className="meta">receipt</span>
          <strong className="display num">
            <Flash watch={x.sharePrice}>{x.sharePrice.toFixed(4)}</Flash>
          </strong>
          <span className="meta num">SOL {live ? <Delta x={x.sharePrice - 1} /> : null}</span>
        </div>
      </div>
      <LopsidedNote r={r} ticker={ticker} />
      <div className="tile-foot">
        <Link className="chip" to={`/yield/${key}`}>
          details
        </Link>
        <Link className="chip" to={`/m/${v.market.toBase58()}`}>
          market
        </Link>
        <CardShare text={`$${ticker}/SOL vault on 100x.broker${apy ? ` · ${apy} projected` : ""}`} path={`/yield/${key}`} target={vaultShare(v.key, ticker, refWallet, apy)} />
      </div>
      <VaultTicket view={r} ticker={ticker} onDone={onDone} className="in-panel" />
    </section>
  );
}

/** The honest line when the book is lopsided: the hedge can only win what the other pot holds. */
export function LopsidedNote({ r, ticker }: { r: Row; ticker: string }) {
  const px = usePrices();
  const { cover } = vaultNumbers(r);
  const starved = r.x.dStar > 0n && r.x.pot <= r.x.dStar; // the whole DOWN pot is smaller than the hedge the vault needs: nothing to buy
  if (r.x.dStar === 0n && r.x.xTotal === 0n) {
    return (
      <p className="warn lopsided" role="note">
        <b>Not deployed yet.</b> Keeper's next pass.
      </p>
    );
  }
  if (!starved && cover.down >= 0.8 && cover.up >= 0.8) return null;
  const weak = cover.down < cover.up ? "dump" : "pump";
  const pct = Math.round(Math.min(cover.down, cover.up) * 100);
  return (
    <p className="warn lopsided" role="note">
      <b>Lopsided book.</b> UP {usd(px.quoteUsd(r.x.potUp))} · DOWN {usd(px.quoteUsd(r.x.pot))}.{" "}
      {starved ? <>DOWN pot too small.</> : <>${ticker} {weak} ~{pct}% covered.</>} <Link to={`/m/${r.v.market.toBase58()}`}>Balance it →</Link>
    </p>
  );
}
