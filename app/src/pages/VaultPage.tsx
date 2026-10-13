// /yield/:vault — one delta-neutral vault, opened up: where the NAV sits, where the range is, what the keeper does next,
// who parked what, and the same Park / Unpark slip as the list. Every panel deep-links (#nav, #range, #hedge, #activity, #ticket).
import { useEffect, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { usePoll } from "../hooks";
import { usePrices } from "../hooks/price";
import { useUnderlying } from "../hooks/underlying";
import { ageLabel, fetchVaultFeed, findVault, growthSince, keeperNext, xPriceAtTick, xValueAt, type DnEv } from "../lib/dn";
import { setHash } from "../lib/url";
import { Bolt, Rolling } from "../components/Numbers";
import { VaultTicket } from "../components/VaultTicket";
import { HedgeBadge, LopsidedNote, VaultNums, VaultStats, loadRow, pct0, pctSigned, realizedNote, vaultNumbers, type Row } from "./Yield";
import { Flex, useRefWallet, vaultShare } from "../components/Flex";
import { ago, amount as fmtAmount, price, short, usd, usdPrice } from "../lib/format";

const KEEPER_RESERVE = 30_000_000n; // scripts/dn/keeper.ts defaults: RESERVE_SOL 0.03 + MIN_DEPLOY_SOL 0.05
const KEEPER_MIN_DEPLOY = 50_000_000n;
const HARVEST_MIN_SOL = 1_500_000n; // HARVEST_MIN_SOL 0.003 ÷ 2 (the SOL side of the owed fees)
const solscan = (k: string) => `https://solscan.io/account/${k}`;
const raydium = (pool: string) => `https://raydium.io/clmm/create-position/?pool_id=${pool}`;

async function loadOne(key: PublicKey): Promise<Row | null> {
  const v = await findVault(key);
  return v ? loadRow(v) : null;
}

export default function VaultPage() {
  const { vault = "" } = useParams();
  const key = useMemo(() => {
    try {
      return new PublicKey(vault);
    } catch {
      return null;
    }
  }, [vault]);
  const row = usePoll(() => (key ? loadOne(key) : Promise.resolve(null)), [vault]);
  const r = row.data;
  const under = useUnderlying(r?.underlying);

  // deep-linked panel: the fragment is evaluated before the panel exists, so re-apply it once rendered
  useEffect(() => {
    const h = window.location.hash;
    if (!r || !h) return;
    const t = setTimeout(() => {
      history.replaceState(null, "", window.location.pathname + window.location.search);
      window.location.hash = h;
    }, 150);
    return () => clearTimeout(t);
  }, [r?.v.key.toBase58()]);

  if (!key) return <NotFound what="That isn't a vault address." />;
  if (row.loading && !r) return <VaultSkeleton />;
  if (!r) return <NotFound what={row.error ? `Couldn't load: ${row.error}` : "No vault at this address."} />;
  return <VaultBody r={r} ticker={under?.symbol ?? short(r.underlying)} image={under?.image ?? null} onDone={row.refresh} />;
}

function VaultBody({ r, ticker, image, onDone }: { r: Row; ticker: string; image: string | null; onDone: () => void }) {
  const refWallet = useRefWallet();
  const { v, x } = r;
  const px = usePrices();
  const key = v.key.toBase58();
  const growth = growthSince(x.sharePrice, r.createdTs);
  return (
    <>
      <header className="vault-head">
        <div className="vault-id">
          <div className="meta">
            <Link to="/">Board</Link> / <Link to="/yield">yield</Link> / {ticker}
          </div>
          <h1 className="display">
            {image && <img className="tokimg xl" src={image} alt="" />}${ticker} <span className="muted">/ SOL</span>
          </h1>
          <div className="vault-links meta">
            <HedgeBadge r={r} />
            <Link to={`/m/${v.market.toBase58()}`}>−100× DOWN market →</Link>
            <a href={raydium(v.pool.toBase58())} target="_blank" rel="noreferrer">
              Raydium pool ↗
            </a>
            <a href={solscan(key)} target="_blank" rel="noreferrer">
              vault on solscan ↗
            </a>
            <Flex
              target={vaultShare(v.key, ticker, refWallet, (() => { const p = vaultNumbers(r).projected; return p !== null ? pct0(Math.pow(1 + p / 365, 365) - 1) : null; })())}
              className="btn ghost small"
              label="Flex"
            />
          </div>
          <div className="addr">{key}</div>
        </div>
        <div className="yield-tvl">
          <span className="meta">
            <Bolt stamp={x.nav.toString()} /> parked
          </span>
          <strong className="display">
            <Rolling value={px.lamportsUsd(x.nav)} format={usd} />
          </strong>
          <span className="meta num">
            {fmtAmount(x.nav, 9, 4)} SOL · {fmtAmount(x.supply, 9, x.supply < 1_000_000_000n ? 3 : 2)} receipts{growth ? <> · {ageLabel(growth.age)}</> : null}
          </span>
        </div>
      </header>
      <VaultNums r={r} />
      <VaultStats r={r} ticker={ticker} />
      <div className="mkt-grid vault-grid">
        <div className="col">
          <NavPanel r={r} ticker={ticker} />
          <RangePanel r={r} ticker={ticker} />
          <section className="panel" id="activity">
            <h2 className="meta">
              <Anchor id="activity" />
              Activity · who parked, who unparked, what the keeper did
            </h2>
            <Activity vault={key} ticker={ticker} sharePrice={x.sharePrice} />
          </section>
        </div>
        <div className="col">
          <section className="panel" id="ticket">
            <h2 className="meta">
              <Anchor id="ticket" />
              Park / Unpark
            </h2>
            <VaultTicket view={r} ticker={ticker} onDone={onDone} className="in-panel" />
          </section>
          <HedgePanel r={r} ticker={ticker} />
          <ReceiptsPanel r={r} />
          <PlumbingPanel r={r} ticker={ticker} />
        </div>
      </div>
    </>
  );
}

/** NAV, leg by leg — the same sum the program does before it lets anyone in or out. */
function NavPanel({ r, ticker }: { r: Row; ticker: string }) {
  const { v, x } = r;
  const px = usePrices();
  const xSol = (n: bigint) => xValueAt(n, x.twapPriceX64, v.xIsToken0);
  const dNet = (x.d * 9_600n) / 10_000n;
  const legs: { label: string; sol: bigint; note: string; cls?: string }[] = [
    { label: "SOL · sub-account", sol: x.free, note: "above the rent floor" },
    { label: "WSOL", sol: x.wsol, note: "wrapped, waiting for the pool" },
    { label: "Loose quote · r-fstacc", sol: x.quoteSol, note: "hedge change, at the stake pool's rate" },
    { label: `${ticker} in position`, sol: xSol(x.xInPos), note: `${fmtAmount(x.xInPos, x.xDecimals, 0)} ${ticker} at the market's TWAP` },
    ...(x.xLoose > 0n ? [{ label: `${ticker} loose`, sol: xSol(x.xLoose), note: `${fmtAmount(x.xLoose, x.xDecimals, 2)} ${ticker} in the ATA` }] : []),
    { label: "SOL in position", sol: x.solInPos, note: "at pool spot" },
    { label: "Uncollected fees", sol: xSol(x.feeX) + x.feeSol, note: `${fmtAmount(x.feeX, x.xDecimals, 2)} ${ticker} + ${fmtAmount(x.feeSol, 9, 6)} SOL`, cls: "up" },
    { label: "DOWN bucket · at pot, after the 4% fee", sol: dNet, note: `${fmtAmount(x.held, x.downDecimals, 0)} DOWN · ${usd(px.lamportsUsd(x.d))} gross`, cls: "down" },
  ];
  const share = (n: bigint) => (x.nav > 0n ? `${((Number(n) / Number(x.nav)) * 100).toFixed(1)}%` : "—");
  return (
    <section className="panel" id="nav">
      <h2 className="meta">
        <Anchor id="nav" />
        NAV · {usd(px.lamportsUsd(x.nav))} <span className="num">· {fmtAmount(x.nav, 9, 4)} SOL</span>
      </h2>
      <div className="vtable" role="table" aria-label="NAV breakdown">
        <div className="vrow navrow meta" role="row">
          <span role="columnheader">Leg</span>
          <span role="columnheader">SOL</span>
          <span role="columnheader">USD</span>
          <span role="columnheader">of NAV</span>
        </div>
        {legs.map((l) => (
          <div className="vrow navrow num" role="row" key={l.label}>
            <span role="cell">
              <span className={l.cls}>{l.label}</span> <span className="meta">{l.note}</span>
            </span>
            <span role="cell">{fmtAmount(l.sol, 9, 6)}</span>
            <span role="cell">{usd(px.lamportsUsd(l.sol))}</span>
            <span role="cell" className="muted">
              {share(l.sol)}
            </span>
          </div>
        ))}
        <div className="vrow navrow num total" role="row">
          <span role="cell">NAV</span>
          <span role="cell">{fmtAmount(x.nav, 9, 6)}</span>
          <span role="cell">{usd(px.lamportsUsd(x.nav))}</span>
          <span role="cell" className="muted">
            100%
          </span>
        </div>
      </div>
      <p className="note">
        {ticker} is valued at the −100× market's own TWAP, not pool spot, so a wick can't mint cheap receipts. The DOWN bucket counts at what
        the pot would pay to redeem it today, fee included — the curve price is hype, the pot is money.
      </p>
    </section>
  );
}

/** Where the position sits against the pool's price and the market's TWAP. */
function RangePanel({ r, ticker }: { r: Row; ticker: string }) {
  const { v, x } = r;
  const px = usePrices();
  // orient in X-price space: left is the cheaper end of the range regardless of which side of the pool X is on
  const s = v.xIsToken0 ? 1 : -1;
  const lo = Math.min(v.tickLower * s, v.tickUpper * s);
  const hi = Math.max(v.tickLower * s, v.tickUpper * s);
  const cur = x.poolTick * s;
  const tw = x.twapTick * s;
  const span = Math.max(1, hi - lo);
  const dLo = Math.min(lo, cur, tw) - span * 0.15;
  const dHi = Math.max(hi, cur, tw) + span * 0.15;
  const pos = (t: number) => `${(((t - dLo) / (dHi - dLo)) * 100).toFixed(2)}%`;
  const inRange = v.tickLower <= x.poolTick && x.poolTick < v.tickUpper;
  const through = Math.min(1, Math.max(0, (cur - lo) / span));
  const at = (t: number) => xPriceAtTick(t, v.xIsToken0, x.xDecimals);
  // the cheap end of the range is tickLower when X is token0, tickUpper when it's token1
  const [floorTick, ceilTick] = at(v.tickLower) <= at(v.tickUpper) ? [v.tickLower, v.tickUpper] : [v.tickUpper, v.tickLower];
  const floor = at(floorTick);
  const ceil = at(ceilTick);
  const spot = at(x.poolTick);
  const twap = at(x.twapTick);
  const fmt = (p: number) => `${usdPrice(px.solPriceUsd(p))} · ${price(p)} SOL`;
  return (
    <section className="panel" id="range">
      <h2 className="meta">
        <Anchor id="range" />
        Range · {inRange ? <span className="up">in range</span> : <span className="down">out of range</span>}
        {v.position ? null : <span className="muted"> · no position yet</span>}
      </h2>
      <div className={`range ${inRange ? "in" : "out"}`} role="img" aria-label={`Pool tick ${x.poolTick}, TWAP tick ${x.twapTick}, range ${v.tickLower} to ${v.tickUpper}`}>
        <div className="range-track">
          <div className="range-band" style={{ left: pos(lo), width: `calc(${pos(hi)} - ${pos(lo)})` }} />
          <i className="range-mark twap" style={{ left: pos(tw) }} title={`TWAP tick ${x.twapTick}`} />
          <i className="range-mark spot" style={{ left: pos(cur) }} title={`pool tick ${x.poolTick}`} />
        </div>
        <div className="range-labels meta num">
          <span>
            floor <b>{usdPrice(px.solPriceUsd(floor))}</b>
            <br />
            {price(floor)} SOL · tick {floorTick}
          </span>
          <span className="r">
            ceiling <b>{usdPrice(px.solPriceUsd(ceil))}</b>
            <br />
            {price(ceil)} SOL · tick {ceilTick}
          </span>
        </div>
      </div>
      <div className="panel-row">
        <span className="muted">
          <i className="range-key spot" /> pool spot
        </span>
        <span className="num">
          {fmt(spot)} <span className="meta">tick {x.poolTick}</span>
        </span>
      </div>
      <div className="panel-row">
        <span className="muted">
          <i className="range-key twap" /> market TWAP
        </span>
        <span className="num">
          {fmt(twap)} <span className="meta">tick {x.twapTick}</span>
        </span>
      </div>
      <p className="note">
        {inRange ? (
          <>
            Spot is {Math.round(through * 100)}% of the way from floor to ceiling — the position is earning fees on every trade. Liquidity{" "}
            <span className="num">{x.liquidity.toString()}</span>.
          </>
        ) : cur < lo ? (
          <>
            {ticker} is trading <b>below the floor</b>: the position is all {ticker} and earns nothing until the price comes back. The DOWN bucket is
            what's carrying the book.
          </>
        ) : (
          <>
            {ticker} is trading <b>above the ceiling</b>: the position is all SOL and earns nothing until the price comes back. Hedge target is
            what's left of the {ticker} exposure.
          </>
        )}
      </p>
    </section>
  );
}

/** The hedge, the band, and the keeper's next move — the same arithmetic the keeper runs and the program checks. */
function HedgePanel({ r, ticker }: { r: Row; ticker: string }) {
  const { v, x } = r;
  const px = usePrices();
  const next = keeperNext(v, x);
  const cut = (dD: bigint) => (dD * BigInt(v.keeperBps)) / 10_000n;
  const idle = x.free + x.wsol;
  const canDeploy = idle > KEEPER_RESERVE + KEEPER_MIN_DEPLOY;
  const ok = x.dStar === 0n ? x.d === 0n : x.errBps <= BigInt(v.bandBps);
  return (
    <section className="panel" id="hedge">
      <h2 className="meta">
        <Anchor id="hedge" />
        Hedge · <span className={ok ? "up" : "down"}>{ok ? "inside the band" : "drifting"}</span>
      </h2>
      <div className="panel-row">
        <span className="muted">D · DOWN bucket at pot</span>
        <span className="num">
          {usd(px.lamportsUsd(x.d))} <span className="meta">{fmtAmount(x.d, 9, 5)} SOL</span>
        </span>
      </div>
      <div className="panel-row">
        <span className="muted">D* · target = {ticker} exposure ÷ 100</span>
        <span className="num">
          {usd(px.lamportsUsd(x.dStar))} <span className="meta">{fmtAmount(x.dStar, 9, 5)} SOL</span>
        </span>
      </div>
      <div className="panel-row">
        <span className="muted">Error</span>
        <span className={`num ${ok ? "up" : "down"}`}>
          {x.errBps.toString()} bps <span className="meta">band {v.bandBps} bps</span>
        </span>
      </div>
      <div className="panel-row">
        <span className="muted">Max loss per rebalance</span>
        <span className="num">{(v.maxLossBps / 100).toFixed(2)}% of NAV</span>
      </div>
      <div className="panel-row">
        <span className="muted">Keeper cut</span>
        <span className="num">{v.keeperBps / 100}% of |ΔD| + harvested fees</span>
      </div>
      <div className="hedge-next">
        <span className="meta">what the keeper does next</span>
        {next.kind === "nothing" && <p>Nothing — {next.why}.</p>}
        <LopsidedNote r={r} ticker={ticker} />
        {next.kind === "buy" && (
          <p>
            Buy <b className="num down">≈{fmtAmount(next.down, x.downDecimals, 0)} DOWN</b> — adds <b className="num">{usd(px.lamportsUsd(next.dD))}</b> of pot share.
            Pockets <span className="num">{usd(px.lamportsUsd(cut(next.dD)))}</span> for the trouble.
          </p>
        )}
        {next.kind === "sell" && (
          <p>
            Redeem <b className="num down">{fmtAmount(next.down, x.downDecimals, 0)} DOWN</b> at the pot (−4%) for ≈ <b className="num">{usd(px.lamportsUsd(next.expect))}</b>.
            Pockets <span className="num">{usd(px.lamportsUsd(cut(next.dD)))}</span>.
          </p>
        )}
        {next.kind === "capped" && (
          <p>
            The whole DOWN pot ({usd(px.lamportsUsd(x.pot))}) can't cover {usd(px.lamportsUsd(x.dStar))} of exposure. The keeper buys what the budget
            allows; the program only asks that the hedge gets no worse.
          </p>
        )}
        <p className="meta">
          {canDeploy ? (
            <>
              {fmtAmount(idle, 9, 4)} SOL idle — the keeper deploys past 0.08 SOL: hedge first, then half to {ticker}, into the pool.
            </>
          ) : (
            <>{fmtAmount(idle, 9, 4)} SOL idle, under the keeper's 0.08 SOL deploy floor.</>
          )}
          {x.feeSol >= HARVEST_MIN_SOL ? <> Fees are worth harvesting ({fmtAmount(x.feeSol, 9, 5)} SOL side).</> : null}
        </p>
      </div>
    </section>
  );
}

function ReceiptsPanel({ r }: { r: Row }) {
  const { v, x } = r;
  const px = usePrices();
  const growth = growthSince(x.sharePrice, r.createdTs);
  const change = x.sharePrice - 1;
  return (
    <section className="panel" id="receipts">
      <h2 className="meta">
        <Anchor id="receipts" />
        Receipts
      </h2>
      <div className="panel-row">
        <span className="muted">Out there</span>
        <span className="num">
          <a href={`https://solscan.io/token/${v.shareMint.toBase58()}`} target="_blank" rel="noreferrer">
            {fmtAmount(x.supply, 9, 4)}
          </a>{" "}
          <span className="meta">{short(v.shareMint.toBase58())}</span>
        </span>
      </div>
      <div className="panel-row">
        <span className="muted">Share price</span>
        <span className="num">
          {x.sharePrice.toFixed(6)} SOL <span className="meta">{usdPrice(px.solPriceUsd(x.sharePrice))}</span>
        </span>
      </div>
      <div className="panel-row">
        <span className="muted">Since launch</span>
        <span className={`num ${change < 0 ? "down" : change > 0 ? "up" : ""}`}>
          {x.supply > 0n ? pctSigned(change) : "—"}
          {growth ? <span className="meta"> · {growth.kind === "apy" ? `${pctSigned(growth.apy)} APY` : growth.kind === "raw" ? realizedNote(growth, vaultNumbers(r).projected) : "warming up"}</span> : null}
        </span>
      </div>
      <div className="panel-row">
        <span className="muted">Born</span>
        <span className="num">{r.createdTs ? `${new Date(r.createdTs * 1000).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · ${ago(r.createdTs)}` : "—"}</span>
      </div>
      <p className="note">
        A receipt started at 1.000000 SOL. There is no price history on chain — just where it is now, and where it started. Rent and the first
        hedge cost a few bps on day one; fees pay it back.
      </p>
    </section>
  );
}

function PlumbingPanel({ r, ticker }: { r: Row; ticker: string }) {
  const { v } = r;
  const rows: { label: string; key: string | null; to?: string; extra?: { href: string; text: string } }[] = [
    { label: "Vault", key: v.key.toBase58() },
    { label: "SOL sub-account", key: v.solPda.toBase58() },
    { label: "Position", key: v.position?.toBase58() ?? null },
    { label: "Position NFT", key: v.positionNft?.toBase58() ?? null },
    { label: "Share mint", key: v.shareMint.toBase58() },
    { label: "DOWN mint", key: v.downMint.toBase58() },
    { label: `${ticker} mint`, key: v.xMint.toBase58() },
    { label: "Raydium pool", key: v.pool.toBase58(), extra: { href: raydium(v.pool.toBase58()), text: "raydium ↗" } },
    { label: "Market", key: v.market.toBase58(), to: `/m/${v.market.toBase58()}` },
    { label: "Creator", key: v.creator.toBase58(), to: `/p/${v.creator.toBase58()}` },
  ];
  return (
    <section className="panel" id="plumbing">
      <h2 className="meta">
        <Anchor id="plumbing" />
        Plumbing
      </h2>
      {rows.map((p) => (
        <div className="panel-row" key={p.label}>
          <span className="muted">{p.label}</span>
          <span className="num plumb">
            {p.key === null ? (
              <span className="meta">none yet</span>
            ) : (
              <>
                {p.to ? <Link to={p.to}>{short(p.key)}</Link> : <span>{short(p.key)}</span>}
                {p.extra && (
                  <a className="meta" href={p.extra.href} target="_blank" rel="noreferrer">
                    {p.extra.text}
                  </a>
                )}
                <a className="meta" href={solscan(p.key)} target="_blank" rel="noreferrer">
                  solscan ↗
                </a>
              </>
            )}
          </span>
        </div>
      ))}
    </section>
  );
}

/** The vault's story, one line per tx, in the Feed's voice. */
function Activity({ vault, ticker, sharePrice }: { vault: string; ticker: string; sharePrice: number }) {
  const { data, loading, error } = usePoll(() => fetchVaultFeed(vault), [vault]);
  const px = usePrices();
  if (loading && !data)
    return (
      <div className="feed">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="skeleton" style={{ height: 18, width: `${70 - i * 10}%` }} />
        ))}
      </div>
    );
  const rows = data ?? [];
  if (!rows.length) return <p className="note">{error ? "The vault's diary is taking a breather." : "Quiet. The first deposit writes the first line."}</p>;
  const weight = (e: DnEv) => (e.kind === "deposit" ? Number(e.lamports ?? 0) : e.kind === "withdraw" ? Number(e.shares ?? 0) * sharePrice : 0);
  const big = Math.max(1, ...rows.map(weight));
  return (
    <ol className="feed" aria-live="polite">
      {rows.map((e) => (
        <li key={e.sig} className={`ev ev-${e.kind} ${weight(e) / big > 0.5 ? "loud" : ""}`}>
          <a className="when meta" href={`https://solscan.io/tx/${e.sig}`} target="_blank" rel="noreferrer">
            {ago(e.ts)}
          </a>
          <span className="what">
            <DnLine e={e} ticker={ticker} lamportsUsd={px.lamportsUsd} />
          </span>
        </li>
      ))}
    </ol>
  );
}

function DnLine({ e, ticker, lamportsUsd }: { e: DnEv; ticker: string; lamportsUsd: (raw: bigint) => number | null }) {
  const who = (k: string | undefined, label?: string) =>
    k ? (
      <Link to={`/p/${k}`} className="who num">
        {label ?? short(k)}
      </Link>
    ) : (
      <b>someone</b>
    );
  switch (e.kind) {
    case "born":
      return <>{who(e.actor)} cooked up this vault. Day one.</>;
    case "deposit": {
      const lam = BigInt(e.lamports ?? "0");
      return (
        <>
          {who(e.actor)} parked <b className="num">{fmtAmount(lam, 9, 3)} SOL</b> <span className="meta">· {usd(lamportsUsd(lam))}</span>
          {e.shares ? <span className="meta"> → {fmtAmount(BigInt(e.shares), 9, 3)} receipt{BigInt(e.shares) === 1_000_000_000n ? "" : "s"}</span> : null}
        </>
      );
    }
    case "withdraw":
      return (
        <>
          {who(e.actor)} unparked <b className="num">{e.pct !== undefined ? `${Math.round(e.pct * 100)}%` : `${fmtAmount(BigInt(e.shares ?? "0"), 9, 3)} receipts`}</b>, in kind
          <span className="meta"> · SOL, {ticker}, DOWN and a slice of the position</span>
        </>
      );
    case "rebalance": {
      const t = e.targets ?? [];
      const hedge = t.includes("DBC hedge") || t.includes("redeem");
      const pool = t.includes("Raydium");
      const verb = hedge && pool ? "deployed and hedged" : hedge ? "nudged the hedge" : pool ? (e.acts && e.acts > 1 ? "worked the pool" : "tended the position") : t.includes("stake pool") ? "shuffled SOL" : "settled a no-op";
      const bounty = BigInt(e.bounty ?? "0");
      const paid = lamportsUsd(bounty);
      return (
        <>
          {who(e.keeper, "keeper")} {verb}
          {t.length ? <> via {t.join(" + ")}</> : null}
          {bounty > 0n ? (
            <>
              , pocketed <b className="num">{paid !== null && paid < 0.01 ? "<$0.01" : usd(paid)}</b>
            </>
          ) : (
            <>, pocketed nothing</>
          )}
        </>
      );
    }
    case "bound":
      return <>{who(e.actor, "keeper")} bound the LP position to the vault</>;
  }
}

function VaultSkeleton() {
  return (
    <div aria-busy="true">
      <div className="vault-head">
        <span className="skeleton" style={{ width: 280, height: 64 }} />
        <span className="skeleton" style={{ width: 200, height: 64 }} />
      </div>
      <div className="mkt-grid vault-grid">
        <span className="skeleton" style={{ height: 420 }} />
        <div className="col">
          <span className="skeleton" style={{ height: 220 }} />
          <span className="skeleton" style={{ height: 160 }} />
        </div>
      </div>
    </div>
  );
}

function NotFound({ what }: { what: string }) {
  return (
    <div className="empty">
      <div className="display">Off the board.</div>
      <p>{what} Not even a parking meter.</p>
      <Link className="btn ghost" to="/yield">
        Back to the vaults
      </Link>
    </div>
  );
}

/** Clicking a panel title puts that panel in the URL (and the clipboard link). */
function Anchor({ id }: { id: string }) {
  return (
    <a
      href={`#${id}`}
      className="anchor"
      aria-label={`Link to ${id}`}
      onClick={(e) => {
        e.preventDefault();
        setHash(id);
        document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
      }}
    >
      #
    </a>
  );
}
