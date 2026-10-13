// /yield — delta-neutral LP vaults. Numbers first (Monitor), one ticket per vault (Operate), the catch in the footnote.
// The tiles and the stat list are shared with the vault's own page (/yield/:vault).
import { Link } from "react-router-dom";
import { usePoll } from "../hooks";
import { usePrices } from "../hooks/price";
import { useUnderlying } from "../hooks/underlying";
import { DAY, YEAR, ageLabel, fetchVaultFeed, growthSince, listVaults, loadVault, poolApr, vaultCreatedTs, yearsToMultiple, type Vault, type VaultView } from "../lib/dn";
import { Bolt, Rolling } from "../components/Numbers";
import { VaultTicket } from "../components/VaultTicket";
import { amount as fmtAmount, short, usd } from "../lib/format";
import { hedgeCoverage } from "../lib/dn";
import { Flex, useRefWallet, vaultShare } from "../components/Flex";

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
  if (raw.change < 0 && raw.age < DAY) return "the dip is day-one costs (swap fees + the hedge marked at the pot), not a trend; fees close it";
  const fees = projected !== null ? projected * (raw.age / YEAR) : null;
  const split = fees !== null ? ` · fees ≈ ${pctSigned(fees)} + hedge ${pctSigned(raw.change - fees)}` : "";
  if (raw.change <= 0) return `at this pace: ${fmtBig(raw.apr)}/yr simple${split}`;
  const mult = Math.pow(1 + raw.change, YEAR / raw.age);
  return `at this pace: ${fmtBig(raw.apr)}/yr simple · ${fmtMult(mult)} compounded · doubles every ${doubling(raw.change, raw.age)}${split}`;
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

export default function YieldPage() {
  const { data, loading, error, refresh } = usePoll(loadAll, []);
  const px = usePrices();
  const rows = data ?? [];
  const tvl = rows.reduce((s, r) => s + r.x.nav, 0n);
  const keeperBps = rows[0]?.v.keeperBps ?? 100;
  return (
    <>
      <header className="yield-head">
        <div className="yield-copy">
          <div className="meta">
            <Link to="/">Board</Link> / yield
          </div>
          <h1 className="display">
            99.99% risk-free money<sup>*</sup>
          </h1>
          <p className="lede">
            <b>You long it? Long it. Short? Short it. Don't want to be long or short but think it's gonna be a wild ride? This page.</b>
          </p>
          <ol className="yield-steps">
            <li>Pick a coin below.</li>
            <li>
              Press <b>Park &amp; deploy</b>.
            </li>
            <li>Your receipt gets heavier from trading fees. Price up, price down, doesn't matter: you're not betting on direction, you're paid for the ride.</li>
          </ol>
          <details className="fine">
            <summary>how it actually works</summary>
            <p>
              Ethena on Solana, for any coin: Ethena holds ETH and shorts the perp to earn the spread. We hold the coin in its Raydium pool and short it
              with the coin's own <b className="down">−100× DOWN</b>, sized to exposure ÷ 100, so what's left is pool fees. No funding, no exchange, no
              liquidation, and it works on any coin with a pool. The hedge is tight when the market's pots are balanced; when they're lopsided it covers one
              direction better than the other, and every vault shows you how much, live. Your receipt is a plain SPL token priced at the vault's NAV: nothing
              to claim, it just gets heavier. Anyone can run the keeper for {keeperBps / 100}% of what it moves, and the program refuses any rebalance that
              leaks value or loosens the hedge.
            </p>
          </details>
          <p className="fine">
            * The 0.01%: a lopsided book hedges one direction better than the other, a thin oracle can be yanked, and we wrote the code last
            night. Deposit what you'd leave in a parking meter.
          </p>
        </div>
        <div className="yield-tvl">
          <span className="meta">
            <Bolt stamp={tvl.toString()} /> parked, all vaults
          </span>
          <strong className="display">
            <Rolling value={px.lamportsUsd(tvl)} format={usd} />
          </strong>
          <span className="meta num">
            {rows.length} vault{rows.length === 1 ? "" : "s"} · {fmtAmount(tvl, 9, 3)} SOL
          </span>
        </div>
      </header>
      {loading && !data && <span className="skeleton" style={{ height: 220 }} />}
      {error && !data && <p className="note">Vaults are taking a breather: {error}</p>}
      {rows.map((r) => (
        <VaultCard key={r.v.key.toBase58()} r={r} onDone={refresh} />
      ))}
      {data && rows.length === 0 && <p className="note">No vaults yet. The first one is being born.</p>}
    </>
  );
}

/** The four tiles: projected APY, what the share price has actually done, doubling horizon, parked. */
export function VaultNums({ r }: { r: Row }) {
  const { x, apr } = r;
  const px = usePrices();
  const { lpShare, projected, compounded, growth, sustained, pace, headline } = vaultNumbers(r);
  const raw = growth?.kind === "raw" ? growth : null;
  const feeLine = (
    <>
      pool fees {apr ? `${apr.day.toFixed(1)}%/yr` : "—"} (last-24h pace) × {Math.round(lpShare * 100)}% deployed = {projected !== null ? pct0(projected) : "—"} simple, {compounded !== null ? pct0(compounded) : "—"} compounded
      {apr && apr.tvl > 0 && apr.tvl < 25_000 ? <> · <b className="down">pool holds ${Math.round(apr.tvl).toLocaleString("en-US")}</b>: a fee rate on a puddle, it will swing wildly</> : null}
    </>
  );
  return (
    <div className="vc-nums">
      <div className="vc-num">
        <span className="meta">{pace ? `APY · the last ${ageLabel(pace.age).replace(/ old$/, "")}, compounded forward` : "APY · if the last 24 h of pool fees repeat"}</span>
        <strong className="display">{pace ? fmtMult(pace.mult) : compounded !== null ? <Rolling value={compounded} format={pct0} /> : "—"}</strong>
        <span className="meta num">
          {pace ? (
            <>
              {fmtBig(pace.simple)}/yr simple · doubles every <b>{doubling(pace.change, pace.age)}</b> · fees alone: {feeLine}
            </>
          ) : (
            feeLine
          )}
        </span>
      </div>
      <div className="vc-num">
        <span className="meta">{raw ? "realized · since launch" : "APY · realized"}</span>
        <strong className={`display ${raw ? (raw.change < 0 ? "down" : "up") : ""}`}>
          {sustained !== null ? <Rolling value={sustained} format={pct0} /> : raw ? <Rolling value={raw.change} format={pctSigned} /> : <span className="muted">warming up</span>}
        </strong>
        <span className="meta num">
          share price {x.sharePrice.toFixed(6)} SOL
          {growth ? <> · {ageLabel(growth.age)}</> : null}
          {raw ? (
            <> · {realizedNote(raw, projected)}</>
          ) : sustained !== null ? (
            <> · since launch</>
          ) : null}
        </span>
      </div>
      <div className="vc-num">
        <span className="meta">2× your bag in</span>
        <strong className="display">{pace ? doubling(pace.change, pace.age) : horizon(headline !== null ? yearsToMultiple(headline, 2) : null)}</strong>
        <span className="meta num">10× in {pace ? horizon((pace.age * (Math.log(10) / Math.log(1 + pace.change))) / YEAR) : horizon(headline !== null ? yearsToMultiple(headline, 10) : null)}</span>
      </div>
      <div className="vc-num">
        <span className="meta">parked</span>
        <strong className="display">
          <Rolling value={px.lamportsUsd(x.nav)} format={usd} />
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
          {usd(px.lamportsUsd(lpVal))} <span className="muted">({fmtAmount(x.xTotal, x.xDecimals, 0)} {ticker} + {fmtAmount(x.solPos, 9, 3)} SOL)</span>
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
        <dd className="num">{v.keeperBps / 100}% of what it moves</dd>
      </div>
    </dl>
  );
}

export function HedgeBadge({ r }: { r: Row }) {
  const { x } = r;
  const { hedged, cover } = vaultNumbers(r);
  const tight = cover.down >= 0.8 && cover.up >= 0.8;
  return (
    <span className={`badge ${hedged && tight ? "ok" : "warn"}`} title="Sized for a balanced book; coverage is what the hedge actually pays per direction right now">
      <Bolt stamp={x.d.toString()} title="hedge" /> {hedged ? "sized" : "drifting"} · {x.errBps.toString()} bps · covers ↑{pct0(cover.up)} ↓{pct0(cover.down)}
    </span>
  );
}

function VaultCard({ r, onDone }: { r: Row; onDone: () => void }) {
  const { v } = r;
  const under = useUnderlying(r.underlying);
  const ticker = under?.symbol ?? short(r.underlying);
  const key = v.key.toBase58();
  const refWallet = useRefWallet();
  const proj = vaultNumbers(r).projected;
  const apyLabel = proj !== null ? pct0(Math.pow(1 + proj / 365, 365) - 1) : null;
  return (
    <section className="vault-card" id={key}>
      <div className="vc-main">
        <div className="vc-id">
          {under?.image && <img className="tokimg" src={under.image} alt="" />}
          <h2 className="display">
            <Link to={`/yield/${key}`}>
              ${ticker} <span className="muted">/ SOL</span>
            </Link>
          </h2>
          <HedgeBadge r={r} />
          <Link className="meta" to={`/m/${v.market.toBase58()}`}>
            market →
          </Link>
          <Link className="meta vc-more" to={`/yield/${key}`}>
            details →
          </Link>
          <Flex target={vaultShare(v.key, ticker, refWallet, apyLabel)} />
        </div>
        <VaultNums r={r} />
        <LopsidedNote r={r} ticker={ticker} />
        <VaultStats r={r} ticker={ticker} />
      </div>
      <VaultTicket view={r} ticker={ticker} onDone={onDone} />
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
        <b>Not deployed yet.</b> The keeper swaps half to ${ticker}, buys the DOWN hedge and adds the liquidity on its next pass; coverage reads 0% until then.
      </p>
    );
  }
  if (!starved && cover.down >= 0.8 && cover.up >= 0.8) return null;
  const weak = cover.down < cover.up ? "dump" : "pump";
  const pct = Math.round(Math.min(cover.down, cover.up) * 100);
  return (
    <p className="warn lopsided" role="note">
      <b>Lopsided book.</b> UP pot {usd(px.quoteUsd(r.x.potUp))} vs DOWN pot {usd(px.quoteUsd(r.x.pot))}.{" "}
      {starved ? (
        <>
          The DOWN pot is smaller than the hedge this vault needs ({usd(px.lamportsUsd(r.x.dStar))}), so there is nothing for the keeper to buy until it refills — a tip to the
          pots or anyone buying DOWN does it.{" "}
        </>
      ) : (
        <>
          The hedge pays out of the other side's pot, so a ${ticker} {weak} is only ~{pct}% covered right now.{" "}
        </>
      )}
      The hedge is bought on the DOWN curve and marked at what the pot would pay, so on a thin book it shows as a dip on day one and closes as the book fills. The empty side
      pays the most, so it balances when people show up. <Link to={`/m/${r.v.market.toBase58()}`}>Help balance it →</Link>
    </p>
  );
}
