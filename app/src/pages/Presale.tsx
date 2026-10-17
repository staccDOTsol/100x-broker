// /presale — the not-a-presale. One address: send SOL from your own wallet, $NGU is bought at the pool rate and minted
// straight back to you (ngu-crank scripts/presale.cjs on the cranker). Every number below is measured from chain by
// /api/ngu-buys, /api/ngu-history and /api/ngu-clanker; nothing here is a promise. The bulbs around the page light up
// whenever the cranker ("clanker") lands a transaction, and only then: every burst is a real transaction on chain.
import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { usePoll } from "../hooks";
import { NGU } from "../ngu";
import { NguChart } from "./Ngu";
import "../ngu.css";
import "../presale.css";

type Stat = { min: number; max: number; mean: number; median: number; n: number } | null;
type BuyRow = { sig: string; t: number; wallet: string; via: string; sol: number; ngu: number; entry_rate: number; pnl_pct: number; underwater: boolean; underwater_secs: number };
type Holder = { wallet: string; buys: number; sol: number; ngu: number; value_now_sol: number; pnl_pct: number; underwater_buys: number };
type Buys = { now: number; rate: number; sell_fee_bps: number; underwater_secs: { recovered: Stat; still_under: Stat; all: Stat }; holders: Holder[]; buys: BuyRow[] };
type Point = [number, number];
type Kind = "in" | "fill" | "refund" | "crank" | "epoch";
type ClankerEvent = { sig: string; t: number; kind: Kind; who: string | null; sol: number | null; ngu: number | null; burned: number | null; pool_ngu: number | null; pool_quote: number | null; for: string | null; bought?: number; added?: number };
type Clanker = { now: number; crank_every_secs: number; presale_every_secs: number; events: ClankerEvent[] };

const BUY_FEE = 0.069;
const MAX_SELL_FEE = 0.069;
/** Targets never run out. Raise: 1, 4.2, 6.9 SOL, then the same three a decade up, forever. */
const raiseTarget = (i: number) => Number(([1, 4.2, 6.9][i % 3] * 10 ** Math.floor(i / 3)).toPrecision(6));
/** Rate (SOL per NGU, launched at 1): 1.1×, 1.25×, 1.5×, 2×, 3×, 5×, then 10×, 20×, 50× a decade at a time. */
const RATE_FIRST = [1.1, 1.25, 1.5, 2, 3, 5];
const rateTarget = (i: number) =>
  i < RATE_FIRST.length ? RATE_FIRST[i] : Number(([1, 2, 5][(i - RATE_FIRST.length) % 3] * 10 ** (1 + Math.floor((i - RATE_FIRST.length) / 3))).toPrecision(6));
/** A hit target retires; the ladder always shows the next three. Returns the index of the first one not yet hit. */
function firstOpen(target: (i: number) => number, value: number) {
  let i = 0;
  while (target(i) <= value) i++;
  return i;
}
const SHOWN = 3;
const TG = "https://t.me/brokerx100";

const short = (k: string | null) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : "someone");
function dur(s: number | null | undefined) {
  if (s == null || !Number.isFinite(s)) return "—";
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}
/** Four significant figures, never in exponent form: 0.000000148, 0.08496, 8,886. */
function amt(x: number | null | undefined) {
  if (x == null || !Number.isFinite(x)) return "—";
  if (Math.abs(x) >= 1000) return Math.round(x).toLocaleString("en-US");
  return x.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

/** What a clanker transaction did, as a headline and a line under it. */
function describe(e: ClankerEvent): { head: string; sub: string } {
  switch (e.kind) {
    case "in":
      return { head: `${amt(e.sol)} SOL in`, sub: `from ${short(e.who)} · clanker fills it next` };
    case "fill":
      return { head: `minted ${amt(e.ngu)} NGU`, sub: `to ${short(e.who)} at the pool rate` };
    case "refund":
      return { head: `sent ${amt(e.sol)} SOL back`, sub: `to ${short(e.who)}: under the 0.01 minimum` };
    case "crank": {
      // net Orca pool movement: Fr28 out is what the swap bought, Fr28 in is what went into liquidity (the NGU side is
      // left out: the same transaction also collects pool fees, so its net can read negative)
      const q = e.pool_quote ?? 0;
      const bought = e.bought ?? (q < 0 ? -q : 0);
      const added = e.added ?? (q > 0 ? q : 0);
      const pool = [bought ? `bought ${amt(bought)} 100xBROKER` : null, added ? `added ${amt(added)} 100xBROKER to liquidity` : null].filter(Boolean).join(" · ") || null;
      if (e.burned) return { head: `burned ${amt(e.burned)} NGU`, sub: pool ?? "swept the tax" };
      return pool ? { head: pool, sub: "from the swept tax" } : { head: "checked the tax", sub: "nothing big enough to move yet" };
    }
    default:
      return { head: "synced the pool", sub: "stake pool balance update" };
  }
}
const KIND_LABEL: Record<Kind, string> = { in: "SOL in", fill: "mint", refund: "refund", crank: "burn", epoch: "sync" };

/** Polls the clanker feed; every transaction it hasn't shown yet fires the lights (the first load only fills the log). */
function useClanker(onNew?: (added: ClankerEvent[]) => void) {
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;
  const feed = usePoll<Clanker | null>(async () => {
    const r = await fetch("/api/ngu-clanker");
    if (!r.ok) throw new Error(`clanker feed ${r.status}`);
    return r.json();
  }, [], 5_000);
  const seen = useRef<Set<string> | null>(null);
  const [burst, setBurst] = useState<{ id: number; e: ClankerEvent } | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const evs = feed.data?.events;
    if (!evs) return;
    if (!seen.current) {
      seen.current = new Set(evs.map((e) => e.sig));
      return;
    }
    const added = evs.filter((e) => !seen.current!.has(e.sig));
    if (!added.length) return;
    for (const e of added) seen.current.add(e.sig);
    // the loudest new thing wins the lights: a mint over a burn over SOL arriving over a sync
    const rank: Record<Kind, number> = { fill: 4, crank: 3, in: 2, refund: 1, epoch: 0 };
    // one sweep is two transactions (burn + swap, then liquidity): the banner shows them added up
    const cranks = added.filter((e) => e.kind === "crank");
    const sweep: ClankerEvent | null =
      cranks.length > 1
        ? {
            ...cranks[0],
            burned: cranks.reduce((a, e) => a + (e.burned ?? 0), 0),
            bought: cranks.reduce((a, e) => a + Math.max(0, -(e.pool_quote ?? 0)), 0),
            added: cranks.reduce((a, e) => a + Math.max(0, e.pool_quote ?? 0), 0),
          }
        : (cranks[0] ?? null);
    const top = [...added.filter((e) => e.kind !== "crank"), ...(sweep ? [sweep] : [])].sort((a, b) => rank[b.kind] - rank[a.kind])[0];
    setBurst({ id: Date.now(), e: top });
    setFresh(new Set(added.map((e) => e.sig)));
    onNewRef.current?.(added);
  }, [feed.data]);
  return { ...feed, burst, fresh };
}

function Lights({ burst }: { burst: { id: number; e: ClankerEvent } | null }) {
  const [live, setLive] = useState<typeof burst>(null);
  useEffect(() => {
    if (!burst) return;
    setLive(burst);
    const t = setTimeout(() => setLive((b) => (b?.id === burst.id ? null : b)), 5200);
    return () => clearTimeout(t);
  }, [burst]);
  const d = live ? describe(live.e) : null;
  return (
    <div className={`lights${live ? ` lit k-${live.e.kind}` : ""}`} aria-hidden={!live}>
      <span className="lt lt-top" key={`t${live?.id}`} />
      <span className="lt lt-right" key={`r${live?.id}`} />
      <span className="lt lt-bottom" key={`b${live?.id}`} />
      <span className="lt lt-left" key={`l${live?.id}`} />
      {live && <span className="lt-wash" key={`w${live.id}`} />}
      {live && d && (
        <div className="lt-banner" key={`n${live.id}`} role="status">
          <span className="lt-who">clanker</span>
          <span className="lt-head">{d.head}</span>
          <span className="lt-sub">{d.sub}</span>
        </div>
      )}
    </div>
  );
}

export default function PresalePage() {
  useEffect(() => {
    document.title = "The not-a-presale · $NGU · 100x.broker";
  }, []);
  const addr = NGU.presaleAddress ?? "";
  const [qr, setQr] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const addrRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (addr) QRCode.toDataURL(`solana:${addr}`, { margin: 1, width: 280, color: { dark: "#15120f", light: "#fbf3df" } }).then(setQr).catch(() => {});
  }, [addr]);
  const buysQ = usePoll<Buys | null>(async () => {
    const r = await fetch("/api/ngu-buys");
    if (!r.ok) throw new Error(`buys ${r.status}`);
    return r.json();
  }, [], 15_000);
  const histQ = usePoll<Point[] | null>(async () => {
    const r = await fetch("/api/ngu-history");
    if (!r.ok) throw new Error(`history ${r.status}`);
    return ((await r.json()) as { points: Point[] }).points;
  }, [], 30_000);
  // a fill means the buys, holders and rate just changed: fetch them now instead of on the next tick
  const clanker = useClanker((added) => {
    if (added.some((e) => e.kind === "fill")) {
      buysQ.refresh();
      histQ.refresh();
    }
  });
  const buys = buysQ.data ?? null;
  const hist = histQ.data ?? null;

  // Pace of the rate over the trailing 24h (or since launch, if younger): log-growth per second.
  const pace = useMemo(() => {
    if (!hist || hist.length < 2) return null;
    const [t1, r1] = hist[hist.length - 1];
    const from = hist.find((p) => p[0] >= t1 - 24 * 3600) ?? hist[0];
    const g = Math.log(r1 / from[1]) / Math.max(1, t1 - from[0]);
    return { g, windowSecs: t1 - from[0], rate: r1 };
  }, [hist]);
  const sellFee = buys ? buys.sell_fee_bps / 10000 : null;
  const need = sellFee == null ? null : 1 / ((1 - BUY_FEE) * (1 - sellFee)) - 1;
  const beSecs = need != null && pace && pace.g > 0 ? Math.log(1 + need) / pace.g : null;
  const maxLossNow = sellFee == null ? null : 1 - (1 - BUY_FEE) * (1 - sellFee);
  const maxLossCap = 1 - (1 - BUY_FEE) * (1 - MAX_SELL_FEE);

  const presaleBuys = useMemo(() => (buys?.buys.filter((b) => b.via === "not-a-presale") ?? []).slice().sort((a, b) => a.t - b.t), [buys]);
  // Live raise: the buy history (exact, but cached for ~20 s) plus what the clanker feed has seen since: fills the
  // history hasn't caught yet, and SOL that has landed but isn't minted yet.
  const live = useMemo(() => {
    const known = new Set(buys?.buys.map((b) => b.sig) ?? []);
    const evs = clanker.data?.events ?? [];
    const answered = new Set(evs.flatMap((e) => (e.for ? [e.for] : [])));
    const fills = evs.filter((e) => e.kind === "fill" && !known.has(e.sig));
    const pending = evs.filter((e) => e.kind === "in" && (e.sol ?? 0) >= 0.01 && !answered.has(e.sig));
    const sum = (xs: ClankerEvent[]) => xs.reduce((a, e) => a + (e.sol ?? 0), 0);
    return { fills, pending, filled: sum(fills), landing: sum(pending) };
  }, [buys, clanker.data]);
  const minted = presaleBuys.reduce((a, b) => a + b.sol, 0) + live.filled;
  const raised = minted + live.landing;
  const buyers = new Set([...presaleBuys.map((b) => b.wallet), ...[...live.fills, ...live.pending].flatMap((e) => (e.who ? [e.who] : []))]).size;
  const raiseFrom = firstOpen(raiseTarget, raised);
  const rate = buys?.rate ?? pace?.rate ?? null;
  const rateFrom = firstOpen(rateTarget, rate ?? 1);

  const doCopy = () => {
    if (!navigator.clipboard) return selectAddr("failed");
    navigator.clipboard.writeText(addr).then(
      () => {
        setCopy("done");
        setTimeout(() => setCopy("idle"), 1600);
      },
      () => selectAddr("failed"),
    );
  };
  const selectAddr = (s: "failed") => {
    setCopy(s);
    const el = addrRef.current;
    if (el) {
      const r = document.createRange();
      r.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
  };

  const evs = clanker.data?.events ?? [];
  const lastMove = evs.find((e) => e.kind !== "in");
  const now = clanker.data?.now ?? Math.floor(Date.now() / 1000);

  return (
    <div className="ngu ps">
      <Lights burst={clanker.burst} />

      <section className="ps-stage">
        <div className="ps-pitch">
          <span className="meta ps-kicker">$NGU · a game · not a presale</span>
          <h1 className="display ps-h1">
            Send SOL.
            <br />
            <em>NGU comes back.</em>
          </h1>
          <p className="ps-lead">
            You all said you were very, very tired of losing. So: one address. Send SOL from your own wallet and $NGU (staked SOL whose SOL
            rate only goes up) lands back in that same wallet. Nothing to connect, nothing to sign on a website. Then the only move is to wait.
          </p>
        </div>

        <div className="ps-targets" aria-label="raise targets">
          <div className="ps-tgt-head">
            <span className="meta">raise targets · SOL through this address</span>
            <span className="num ps-raised">
              <span key={raised.toFixed(4)} className="ps-bump">
                {buys ? amt(raised) : "…"}
              </span>{" "}
              <small>SOL · {buyers} {buyers === 1 ? "buyer" : "buyers"}</small>
            </span>
          </div>
          {live.landing > 0 && (
            <p className="ps-landing" role="status">
              <span className="ps-dot" aria-hidden /> {amt(live.landing)} SOL just landed from {live.pending.map((e) => short(e.who)).join(", ")}. Clanker is minting it.
            </p>
          )}
          <ol className="ps-ladder">
            {Array.from({ length: SHOWN }, (_, k) => {
              const i = raiseFrom + k, tg = raiseTarget(i);
              return (
                <li key={i} className={`ps-rung${k === 0 ? " next" : ""}`}>
                  <span className="ps-rung-n num">T{i + 1}</span>
                  <span className="ps-rung-v num">{amt(tg)} SOL</span>
                  <span className="ps-bar" aria-hidden>
                    <span style={{ transform: `scaleX(${Math.min(1, raised / tg)})` }} />
                  </span>
                  <span className="ps-rung-s num">{buys ? `${amt(tg - raised)} to go` : "…"}</span>
                </li>
              );
            })}
          </ol>
          {raiseFrom > 0 && <span className="meta ps-retired">retired: T1{raiseFrom > 1 ? `–T${raiseFrom}` : ""}</span>}
          <p className="ps-fine muted">Targets never run out: each one retires when it's hit and the next steps up. They're milestones, not caps. The address never closes and there's no allocation: every SOL buys at the live rate.</p>
        </div>

        <aside className="ps-ticket" aria-label="send SOL here">
          <div className="ps-ticket-top">
            <span className="ps-admit display">Admit one</span>
            <span className="meta">send SOL here</span>
          </div>
          {qr ? <img className="ps-qr" src={qr} alt={`QR code for ${addr}`} width={220} height={220} /> : <span className="ps-qr ps-qr-wait" />}
          <button className={`ps-addr${copy !== "idle" ? ` ${copy}` : ""}`} onClick={doCopy} disabled={!addr} aria-label="copy the address">
            <span ref={addrRef} className="num">
              {addr}
            </span>
            <span className="ps-addr-cta">{copy === "done" ? "copied ✓" : copy === "failed" ? "selected · press copy" : "copy address"}</span>
          </button>
          <ul className="ps-rules">
            <li>
              <b>From a wallet you control.</b> Never an exchange: the NGU goes to whoever sent the SOL.
            </li>
            <li>Minimum 0.01 SOL. Less is sent back.</li>
            <li>
              Bought at {rate ? rate.toFixed(6) : "…"} SOL per NGU, minus the 6.9% buy fee that feeds the burn. Minted to you: no transfer tax.
            </li>
            <li>
              Arrives in about 15 seconds. Sell only on <a href="/ngu">/ngu</a>.
            </li>
          </ul>
        </aside>
      </section>

      <section className="ps-clanker" aria-label="clanker">
        <header className="ps-cl-head">
          <h2 className="display ps-cl-title">
            <span className={`ps-dot${clanker.error ? " err" : ""}`} aria-hidden /> Clanker
          </h2>
          <p className="ps-cl-status">
            {clanker.error && !clanker.data
              ? "can't reach the feed right now; retrying"
              : lastMove
                ? <>last move <b className="num">{dur(now - lastMove.t)}</b> ago · sweeps the tax every 5 min · watches this address every 15 s</>
                : clanker.loading
                  ? "waking up…"
                  : "sweeps the tax every 5 min · watches this address every 15 s"}
          </p>
        </header>
        <ol className="ps-log">
          {clanker.loading && !clanker.data && <li className="ps-log-empty muted">loading the last moves…</li>}
          {clanker.data && evs.length === 0 && <li className="ps-log-empty muted">Clanker hasn't moved yet. Send the first SOL and watch the lights.</li>}
          {evs.slice(0, 12).map((e) => {
            const d = describe(e);
            return (
              <li key={e.sig} className={`ps-log-row k-${e.kind}${clanker.fresh.has(e.sig) ? " fresh" : ""}`}>
                <span className="num ps-log-t">{dur(now - e.t)} ago</span>
                <span className="ps-chip">{KIND_LABEL[e.kind]}</span>
                <span className="ps-log-what">
                  <b>{d.head}</b> <span className="muted">{d.sub}</span>
                </span>
                <a className="ps-log-tx num" href={`https://solscan.io/tx/${e.sig}`} target="_blank" rel="noreferrer">
                  tx ↗
                </a>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="ps-two">
        <div className="ps-catch">
          <h2 className="meta">the catch, measured</h2>
          <div className="ps-loss">
            <span className="meta">most you can lose selling on /ngu today</span>
            <span className="num ps-loss-v">{maxLossNow == null ? "…" : `${(maxLossNow * 100).toFixed(2)}%`}</span>
            <span className="ps-loss-sub">
              6.9% buy fee + a {sellFee == null ? "…" : `${(sellFee * 100).toFixed(2)}%`} sell fee. The sell fee steps up each epoch toward 6.9%; at
              that point the ceiling is {(maxLossCap * 100).toFixed(2)}%, less whatever the rate has climbed since you bought.
            </span>
          </div>
          <p className="ps-be">
            Break-even needs a <b className="num">{need == null ? "…" : `${(need * 100).toFixed(2)}%`}</b> rise. At the pace of the last{" "}
            {pace ? dur(pace.windowSecs) : "…"}, a buy right now gets there in{" "}
            <b className="num ps-be-v">{need == null || !pace ? "…" : beSecs ? dur(beSecs) : "— (no growth yet)"}</b>.
          </p>
          <div className="ps-uw" role="table" aria-label="time underwater">
            <div className="ps-uw-row ps-uw-h meta" role="row">
              <span role="columnheader">buys</span>
              <span role="columnheader">n</span>
              <span role="columnheader">min</span>
              <span role="columnheader">mean</span>
              <span role="columnheader">max</span>
            </div>
            {(
              [
                ["still underwater, for", buys?.underwater_secs.still_under ?? null],
                ["back above water, took", buys?.underwater_secs.recovered ?? null],
              ] as const
            ).map(([k, s]) => (
              <div key={k} className="ps-uw-row" role="row">
                <span role="cell">{k}</span>
                <span role="cell" className="num">{buys ? (s?.n ?? 0) : "…"}</span>
                <span role="cell" className="num">{dur(s?.min)}</span>
                <span role="cell" className="num">{dur(s?.mean)}</span>
                <span role="cell" className="num">{dur(s?.max)}</span>
              </div>
            ))}
          </div>
          <p className="muted ps-fine">The pace is whatever volume has been, not a forecast. The burn loop can't push the rate down; how fast it climbs depends on people moving $NGU.</p>
        </div>

        <div className="ps-rate">
          <h2 className="meta">rate targets · SOL per NGU</h2>
          <span className="num ps-rate-v">{rate ? rate.toFixed(6) : "…"}</span>
          <ol className="ps-ladder ps-ladder-rate">
            {Array.from({ length: SHOWN }, (_, k) => {
              const i = rateFrom + k, tg = rateTarget(i);
              const pct = rate ? Math.max(0, Math.min(1, Math.log(rate) / Math.log(tg))) : 0;
              // only the next target gets an ETA: stretching a short, early pace out to 10× reads like a promise
              const eta = k === 0 && rate && pace && pace.g > 0 ? Math.log(tg / rate) / pace.g : null;
              return (
                <li key={i} className={`ps-rung${k === 0 ? " next" : ""}`}>
                  <span className="ps-rung-n num">R{i + 1}</span>
                  <span className="ps-rung-v num">{tg}×</span>
                  <span className="ps-bar" aria-hidden>
                    <span style={{ transform: `scaleX(${pct})` }} />
                  </span>
                  <span className="ps-rung-s num">{k > 0 ? (rate ? `+${amt((tg / rate - 1) * 100)}%` : "…") : eta ? `~${dur(eta)} at this pace` : hist ? "no pace yet" : "…"}</span>
                </li>
              );
            })}
          </ol>
          {rateFrom > 0 && <span className="meta ps-retired">retired: R1{rateFrom > 1 ? `–R${rateFrom}` : ""}</span>}
          <p className="muted ps-fine">The next target's ETA extrapolates the last {pace ? dur(pace.windowSecs) : "…"} of rate growth. Early on that window is short and noisy.</p>
        </div>
      </section>

      <NguChart />

      <section>
        <h2 className="meta">every holder</h2>
        <div className="ps-table" role="table" aria-label="every holder">
          <div className="ps-row ps-head meta" role="row">
            <span>wallet</span>
            <span className="r">buys</span>
            <span className="r">SOL in</span>
            <span className="r">worth now</span>
            <span className="r">P/L</span>
            <span className="r">underwater</span>
          </div>
          <TableState q={buysQ} empty={!buys?.holders.length} what="holders" />
          {(buys?.holders ?? []).map((h) => (
            <div key={h.wallet} className="ps-row" role="row">
              <a className="num" href={`https://solscan.io/account/${h.wallet}`} target="_blank" rel="noreferrer">
                {short(h.wallet)}
              </a>
              <span className="num r">{h.buys}</span>
              <span className="num r">{h.sol.toFixed(4)}</span>
              <span className="num r">{h.value_now_sol.toFixed(4)}</span>
              <span className={`num r ${h.pnl_pct >= 0 ? "up" : "down"}`}>
                {h.pnl_pct >= 0 ? "+" : ""}
                {h.pnl_pct.toFixed(2)}%
              </span>
              <span className="num r">{h.underwater_buys ? `${h.underwater_buys} of ${h.buys}` : "none"}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="meta">every buy</h2>
        <div className="ps-table" role="table" aria-label="every buy">
          <div className="ps-row ps-head meta" role="row">
            <span>when</span>
            <span>wallet</span>
            <span className="r">SOL</span>
            <span>via</span>
            <span className="r">P/L</span>
            <span className="r">underwater</span>
          </div>
          <TableState q={buysQ} empty={!buys?.buys.length} what="buys" />
          {(buys?.buys ?? []).slice(0, 60).map((b) => (
            <div key={b.sig} className={`ps-row${b.via === "not-a-presale" ? " via-here" : ""}`} role="row">
              <a className="num" href={`https://solscan.io/tx/${b.sig}`} target="_blank" rel="noreferrer">
                {dur((buys?.now ?? b.t) - b.t)} ago
              </a>
              <span className="num">{short(b.wallet)}</span>
              <span className="num r">{b.sol.toFixed(4)}</span>
              <span>{b.via === "not-a-presale" ? <span className="ps-chip">this address</span> : "direct"}</span>
              <span className={`num r ${b.pnl_pct >= 0 ? "up" : "down"}`}>
                {b.pnl_pct >= 0 ? "+" : ""}
                {b.pnl_pct.toFixed(2)}%
              </span>
              <span className="num r">{b.underwater ? `${dur(b.underwater_secs)}, counting` : `${dur(b.underwater_secs)}, then above`}</span>
            </div>
          ))}
        </div>
      </section>

      <p className="muted ngu-foot">
        It's a buy at the live rate, not an allocation: there's no presale price, cap or vesting. P/L is SOL in vs. what that $NGU sells for on /ngu
        right now, after the sell fee. Not financial advice. Talk to us: <a href={TG}>t.me/brokerx100</a>
      </p>
    </div>
  );
}

function TableState({ q, empty, what }: { q: { loading: boolean; error: string | null; data: unknown }; empty: boolean; what: string }) {
  if (q.loading && !q.data) return <div className="ps-row ps-state muted">loading {what}…</div>;
  if (q.error && !q.data) return <div className="ps-row ps-state down">couldn't load {what} ({q.error}); retrying</div>;
  if (q.data && empty) return <div className="ps-row ps-state muted">no {what} yet. Be first.</div>;
  return null;
}
