// lastbidwins.fun — Stars War, played from X. A link in a post opens this page (inside the wallet's own browser on a phone),
// you pick a team and beat the last bid in one click, and it sends you back to X with a reply under the game's thread (or a
// quote of it) that carries every number in tokens and dollars. Token games swap the shortfall in from SOL in the same click.
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { usePoll, humanError } from "../hooks";
import { WalletButton } from "../components/bits";
import { useToasts } from "../components/Toasts";
import { sendWarRaw } from "../lib/war-confirm";
import { useWarLiveGames } from "../hooks/war-live";
import type { WarClientView } from "../lib/war-view";
import { WarQuotePosition } from "../components/WarQuotePosition";
import { captureRef, storedRef } from "../lib/ref";
import { isMobileBrowser, walletBrowserLinks } from "../lib/mobile";
import { bullSvg, snekSvg, bearSvg, crownSvg } from "../../api/_lib/creatures";
import { autoTeam, payoff, phantomLink, xCompose } from "../lib/war";
import { chooseQuoteWarTarget, effectiveWarMinBid, formatWarTokenAmount, parseWarTokenAmount, planWarBids, sortQuoteWarGames, warPlanTotals } from "../lib/war-routing";
import { signAndSendWarTransactions, WarSendError } from "../lib/war-send";

const SITE = "https://lastbidwins.fun";
const TEAMS = ["Bull", "Snek", "Bear"] as const;
const TEAM_COLOR = ["var(--war-gold)", "var(--war-snek)", "var(--war-bear)"];
const SVG = [bullSvg, snekSvg, bearSvg];
type Amt = { raw: string; units: number; usd: number | null };
type View = WarClientView & {
  me: { keys: number; owed: Amt; tokenBalance: Amt | null; solBalance: number } | null; thread: string | null; featured: number;
};
const clientView = (g: WarClientView): View => ({ ...g, me: g.me ?? null, thread: g.thread ?? null, featured: g.featured ?? 0 });

const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K` : n >= 1 ? n.toFixed(2) : n.toPrecision(3));
const money = (u: number | null) => (u === null ? "" : u >= 1 ? `$${u.toFixed(2)}` : `$${u.toPrecision(2)}`);
const both = (a: Amt, sym: string) => `${compact(a.units)} $${sym}${a.usd === null ? "" : ` (~${money(a.usd)})`}`;
const short = (k: string | null) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : "nobody");
const clock = (s: number) => `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:` : ""}${String(Math.floor((s % 3600) / 60)).padStart(Math.floor(s / 3600) ? 2 : 1, "0")}:${String(s % 60).padStart(2, "0")}`;

/** "post ↗" on any card: a ready post with this game's numbers and both tap links (Phantom for phones, ours for the card). */
function ShareX({ text, game, me, thread }: { text: string; game: number; me: string | null; thread: string | null }) {
  const action = `${SITE}/a?op=bid&g=${game}${me ? `&ref=${me}` : ""}`;
  const x = xCompose(`${text}\n📱 ${phantomLink(action)}`, action, thread);
  return (
    <a className="war-share" href={isMobileBrowser() ? x.app : x.web} target="_blank" rel="noopener noreferrer" title="post this on X with both tap links">
      post ↗
    </a>
  );
}

function Creature({ team, crowned = false, size = 64 }: { team: number; crowned?: boolean; size?: number }) {
  const s = size * 0.36, cx = size / 2, cy = size * (crowned ? 0.6 : 0.55);
  const body = SVG[team](cx, cy, s) + (crowned ? crownSvg(cx, cy - s * 1.25, s * 0.85) : "");
  return <span className="war-creature" aria-hidden="true" dangerouslySetInnerHTML={{ __html: `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>` }} />;
}

/** X intents: a reply under the game's thread when there is one, otherwise a fresh post; or a quote of the thread. */
function intent(text: string, url: string, thread: string | null, quote = false) {
  const x = xCompose(text, url, thread, quote);
  return isMobileBrowser() ? x.app : x.web; // on a phone, the X app itself
}
const shareLink = (v: View, sc: string, me: string | null) => `${SITE}/w/${v.id}?sc=${sc}${me ? `&ref=${me}` : ""}&v=${v.tag}`;
const rawToken = (raw: bigint, decimals: number) => {
  const unit = 10n ** BigInt(decimals);
  const fraction = (raw % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${raw / unit}${fraction ? `.${fraction}` : ""}`;
};

export default function WarPage({ watchId }: { watchId?: string }) {
  const params = useParams();
  const [query] = useSearchParams();
  const id = watchId ?? params.id ?? "featured";
  const { publicKey, signAllTransactions, signTransaction } = useWallet();
  const me = publicKey?.toBase58() ?? null;
  const toasts = useToasts();
  useEffect(() => captureRef(window.location.search), []);
  const [tick, setTick] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setTick(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  const source = id === "play" ? query.get("g") ?? "play" : id;
  const mintQuery = query.get("mint");
  const seed = usePoll<View | { start: true; mint: string | null; template: View }>(async () => {
    const r = await fetch(`/api/war?g=${encodeURIComponent(source)}${mintQuery ? `&mint=${encodeURIComponent(mintQuery)}` : ""}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "couldn't load the games");
    return j;
  }, [source, mintQuery], 60_000);
  const list = useWarLiveGames();
  const liveGames = useMemo(() => (list.data?.games ?? []).map(clientView), [list.data]);
  const sourceGame = liveGames.find((g) => String(g.id) === source)
    ?? (seed.data && "id" in seed.data && (source === "play" || source === "featured" || String(seed.data.id) === source) ? seed.data : null)
    ?? (mintQuery ? liveGames.find((g) => (g.asset.mint ?? "SOL") === mintQuery) : null);
  const target = sourceGame ? chooseQuoteWarTarget(liveGames, sourceGame, tick) : null;
  const template = target?.game ?? sourceGame;
  const selectedId = target?.game.id;
  const game = usePoll<View | null>(async () => {
    if (selectedId === undefined) return null;
    const r = await fetch(`/api/war?g=${selectedId}&fresh=1`, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "couldn't load the game");
    return j as View;
  }, [selectedId], 60_000);
  // A new cheapest target already has its public state from the stream. Metadata
  // may catch up in the background without removing the quote or bid controls.
  const v: View | null = template ? { ...template, thread: game.data?.id === template.id ? game.data.thread : template.thread } : null;
  const team = publicKey ? autoTeam(publicKey) : 1; // cosmetic, assigned from the wallet's address
  const [amount, setAmount] = useState<string>("");
  const [count, setCount] = useState(() => Math.min(20, Math.max(1, Math.floor(Number(query.get("count")) || 1))));
  const [busy, setBusy] = useState<string | null>(null);
  const [batchBlocked, setBatchBlocked] = useState(false);
  const [progress, setProgress] = useState<{ confirmed: number; total: number } | null>(null);
  const [prepared, setPrepared] = useState<{ bids: number; total: bigint } | null>(null);
  const [posted, setPosted] = useState<{ sc: string; text: string; game: View } | null>(null);
  const [pendingPost, setPendingPost] = useState<{ game: number; lastAmount: string; count: number; units: number; symbol: string; team: number } | null>(null);
  useEffect(() => {
    if (!pendingPost) return;
    const landed = liveGames.find((g) => g.id === pendingPost.game && BigInt(g.lastBid.raw) >= BigInt(pendingPost.lastAmount));
    if (!landed) return;
    setPosted({ sc: "lead", game: landed, text: `${pendingPost.count === 1 ? "took the lead" : `placed ${pendingPost.count} bids`} across $${pendingPost.symbol} wars: ${compact(pendingPost.units)} $${pendingPost.symbol} for team ${TEAMS[pendingPost.team]}.\nlast move: war #${landed.id}. snipe me ↓` });
    setPendingPost(null);
  }, [pendingPost, liveGames]);
  useEffect(() => setAmount(""), [v?.asset.mint]);
  const left = v?.deadline ? Math.max(0, v.deadline - tick) : null;
  const phase = v ? (v.over ? "settled" : !v.deadline ? "open" : left === 0 ? "expired" : left! <= Math.max(v.antiSnipeSecs, 60) ? "ending" : "live") : null;
  const sym = v?.asset.symbol ?? "";
  const dec = v?.asset.decimals ?? 9;
  const opening = phase === "expired" || phase === "settled";
  const minimum = v ? opening ? v.minBid : v.minNext : null;
  const rawMin = minimum ? BigInt(minimum.raw) : 0n;
  const niceMin = rawMin;
  const minAmount = rawToken(niceMin, dec);
  const minUnits = Number(niceMin) / 10 ** dec;
  const bidRaw = useMemo(() => {
    if (!amount && v) {
      return niceMin;
    }
    const value = amount || minAmount;
    if (!/^\d+(?:\.\d*)?$/.test(value)) return 0n;
    const [whole, fraction = ""] = value.split(".");
    if (fraction.length > dec) return 0n;
    return BigInt(whole) * 10n ** BigInt(dec) + BigInt(fraction.padEnd(dec, "0") || "0");
  }, [amount, minAmount, niceMin, dec, v]);
  const totalRaw = BigInt(count) * bidRaw + BigInt(count * (count - 1) / 2);
  const totalUnits = Number(totalRaw) / 10 ** dec;
  const maxBids = count * 2;
  const maxTotalRaw = BigInt(maxBids) * bidRaw + BigInt(maxBids * (maxBids - 1) / 2);
  const maxTotalUnits = Number(maxTotalRaw) / 10 ** dec;
  const bidUsd = v?.asset.usd != null ? (Number(bidRaw) / 10 ** dec) * v.asset.usd : null;
  const tooLow = minimum ? bidRaw < BigInt(minimum.raw) : false;
  const ref = storedRef()?.toBase58() ?? null;
  const handoff = isMobileBrowser() && !publicKey;

  async function run(op: string, extra: Record<string, unknown>, label: string) {
    if (!publicKey || !v) return null;
    setBusy(op);
    setProgress(null);
    let toastId: number | undefined;
    try {
      const r = await fetch("/api/war", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, g: v.id, wallet: me, ...extra }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "couldn't build the transaction");
      const txs = (j.txs as string[]).map((b) => VersionedTransaction.deserialize(Uint8Array.from(atob(b), (c) => c.charCodeAt(0))));
      toastId = toasts.push({ s: "pending", title: label, body: txs.length > 1 ? `Sign ${txs.length} transactions once; they submit in order.` : "Your wallet wants a word." });
      await signAndSendWarTransactions(txs, { signAllTransactions, signTransaction }, sendWarRaw, (p) => {
        setProgress(p);
        if (toastId !== undefined && p.submitted) toasts.update(toastId, { body: `${p.confirmed} / ${p.total} landed · submitting in order` });
      });
      toasts.update(toastId, { s: "ok", title: label, body: "Landed · processed on chain." });
      return j.summary;
    } catch (e) {
      if (e instanceof WarSendError && e.submitted) setBatchBlocked(true);
      const body = `${e instanceof WarSendError && e.submitted ? `${e.confirmed} of ${e.total} transactions landed; a submitted transaction may still land. Reload before another batch. ` : ""}${humanError(e)}`;
      if (toastId !== undefined) toasts.update(toastId, { s: "err", title: label, body });
      else toasts.push({ s: "err", title: label, body });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function bid() {
    if (!v || !template || busy || batchBlocked) return;
    setBusy("multibid");
    setPrepared(null);
    try {
      const r = await fetch(`/api/war?list=1&at=${Date.now()}`, { cache: "no-store" });
      const fresh = await r.json();
      if (!r.ok) throw new Error(fresh.error ?? "couldn't refresh the clocks");
      const moves = planWarBids(fresh.games, template, Math.floor(Date.now() / 1000), count, bidRaw, Math.random, undefined, "quote");
      const totals = warPlanTotals(moves);
      setPrepared(totals);
      const s = await run("multibid", { moves, team, ref }, `${totals.bids} ${totals.bids === 1 ? "bid" : "bids"} · ${rawToken(totals.total, dec)} $${sym}`);
      if (!s) return;
      void Promise.all((s.created ?? []).map((g: number) => fetch("/api/war", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "announce", g }) }).catch(() => null)));
      setPendingPost({ game: s.game, lastAmount: s.lastAmount, count: s.count, units: s.units, symbol: sym, team });
    } catch (e) {
      toasts.push({ s: "err", title: "Couldn't prepare the bids", body: humanError(e) });
    } finally {
      setBusy(null);
    }
  }
  async function settle() {
    if (!v) return;
    const s = await run("settle", {}, `Settle war #${v.id}`);
    if (s) setPosted({ sc: "won", game: v, text: `war #${v.id} is over. ${short(v.leader)} took ${both(v.winnerTakes, sym)}.` });
  }

  if (seed.data && "start" in seed.data && !sourceGame) {
    return <NewGamePreview draft={seed.data.template} first />;
  }
  if ((seed.error || game.error) && !v) return <div className="war"><p className="war-err">{seed.error ?? game.error}</p></div>;
  if (!v) return <div className="war"><p className="war-loading">loading the war…</p></div>;
  const leaderTeam = v.lastTeam ? TEAMS.indexOf(v.lastTeam as (typeof TEAMS)[number]) : 1;
  const iLead = !!me && v.leader === me;
  const byId = new Map(liveGames.filter((g) => g.asset.mint === v.asset.mint).map((g) => [g.id, g]));
  byId.set(v.id, v);
  const siblings = sortQuoteWarGames([...byId.values()], tick);
  const activeCount = siblings.filter((g) => !g.over && (!g.deadline || g.deadline > tick)).length;
  const quotePot = siblings.reduce((total, g) => total + BigInt(g.pot.raw), 0n);
  const quoteUnits = Number(quotePot) / 10 ** dec;
  const quoteUsd = v.asset.usd === null ? null : quoteUnits * v.asset.usd;
  const quoteBids = siblings.reduce((total, g) => total + g.bids, 0);
  const quoteKeys = siblings.reduce((total, g) => total + g.keys, 0);

  return (
    <div className="war">
      <header className="war-head">
        <span className="war-tag">${sym} · {activeCount} active {activeCount === 1 ? "game" : "games"}</span>
        <span className={`war-phase ${phase}`}>
          {phase === "open" ? "open · clock starts on the next bid" : phase === "expired" ? "clock's dead" : phase === "settled" ? "over" : `${phase === "ending" ? "ending" : "live"} · ${clock(left ?? 0)}`}
        </span>
      </header>
      <small className="war-routing-note" role="status">{list.status === "live" ? "Live updates" : list.status === "connecting" ? "Connecting live updates…" : "Reconnecting live updates…"}</small>

      <section className="war-pot">
        <div>
          <small>quote pot</small>
          <strong className="display">{quoteUsd !== null ? money(quoteUsd) : `${compact(quoteUnits)} $${sym}`}</strong>
          <span>{formatWarTokenAmount(quotePot, dec)} ${sym} across {siblings.length} {siblings.length === 1 ? "game" : "games"}</span>
        </div>
        <div className="war-leader">
          <Creature team={Math.max(0, leaderTeam)} crowned size={120} />
          <span>next game #{v.id}</span>
          <span>{iLead ? "you lead this game" : `leader ${short(v.leader)}`}</span>
          <ShareX game={v.id} me={me} thread={v.thread}
            text={`war #${v.id} on $${sym}: pot ${v.pot.usd !== null ? money(v.pot.usd) : `${compact(v.pot.units)} $${sym}`}${left !== null ? ` · ${clock(left)} left` : ""}. ${v.minNext.usd !== null && v.payoff ? `${money(v.minNext.usd)} to win ${money(v.payoff.win.usd)} (${v.payoff.multiple.toFixed(1)}×)` : `next bid ≥ ${both(v.minNext, sym)}`} if nobody tops it ↓`} />
        </div>
      </section>

      <section className="war-new-game">
        <div><strong>Start fresh</strong><small>A new game with a fresh minimum bid.</small></div>
        <Link className="btn small" to={`/w/new?mint=${encodeURIComponent(v.asset.mint ?? "SOL")}`}>New ${sym} game</Link>
      </section>

      {handoff && (
        <section className="war-handoff">
          <p>Open this in your wallet to play:</p>
          <div>{walletBrowserLinks().map((l) => <a key={l.name} className="btn" href={l.href}>Open in {l.name}</a>)}</div>
        </section>
      )}

      {phase === "expired" || phase === "settled" ? (
        <section className="war-ticket">
          <p>{phase === "expired" ? `${short(v.leader)} held the last bid when the clock died.` : `War #${v.id} is paid out.`} Start the next one and you're its creator: {v.pct.creator / 100}% of its pot.</p>
          <MyTeam team={team} known={!!publicKey} />
          <label className="war-multibid"><span>number of plays</span><select aria-label="Number of plays" value={count} disabled={!!busy} onChange={(e) => setCount(Number(e.target.value))}>{Array.from({ length: 20 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</select><small>Each eligible play rolls independently. A fork includes two paid opening bids so its clock starts immediately.</small><strong>Up to {rawToken(maxTotalRaw, dec)} ${sym} in paid bids</strong><small>The exact total is prepared before your wallet signs.</small></label>
          {!publicKey ? <WalletButton solo /> : (
            <div className="war-actions">
              <button className="btn war-go" disabled={batchBlocked || !!busy || !list.ready || !!list.error} onClick={bid}>{busy === "multibid" ? "Starting…" : `Start the next war · ${count} ${count === 1 ? "play" : "plays"}`}</button>
              {phase === "expired" && <button className="btn small" disabled={!!busy} onClick={settle}>{busy === "settle" ? "Settling…" : "Just settle it"}</button>}
            </div>
          )}
        </section>
      ) : (
        <section className="war-ticket">
          <MyTeam team={team} known={!!publicKey} />
          <p className="war-routing-note">The lowest required bid on ${sym} gets the next play. While every running clock on this quote is above 2:00, each play has a 25% chance to open a matching game with two paid opening bids.</p>
          <small className="war-routing-note">Next bid targets game #{v.id} · {v.pct.winner / 100}% winner share · minimum {formatWarTokenAmount(BigInt(v.minNext.raw), dec)} ${sym}</small>
          <label className="war-amount">
            <span>your bid in ${sym}</span>
            <input inputMode="decimal" placeholder={minAmount} value={amount} disabled={!!busy} onChange={(e) => setAmount(e.target.value)} />
            <small>{bidUsd !== null ? `~${money(bidUsd)} · ` : ""}next bid ≥ {both(v.minNext, sym)}</small>
            {(() => {
              // what this exact bid wins if it's the last one: 70% of the pot after 90% of the bid lands in it
              const p = payoff({ pot: BigInt(v.pot.raw), pct: v.pct }, bidRaw, team);
              const winUnits = Number(p.win) / 10 ** dec;
              const winUsd = v.asset.usd != null ? winUnits * v.asset.usd : null;
              return bidRaw > 0n && count === 1 ? <strong className="war-payoff">on this war: win {winUsd !== null ? money(winUsd) : `${compact(winUnits)} $${sym}`} if nobody tops it · {p.multiple.toFixed(1)}× your bid</strong> : null;
            })()}
          </label>
          <div className="war-quick">
            <button className="btn small" disabled={!!busy} onClick={() => setAmount(minAmount)}>min</button>
            <button className="btn small" disabled={!!busy} onClick={() => setAmount(rawToken((niceMin * 105n + 99n) / 100n, dec))}>+5%</button>
            <button className="btn small" disabled={!!busy} onClick={() => setAmount(rawToken((niceMin * 110n + 99n) / 100n, dec))}>+10%</button>
          </div>
          <label className="war-multibid">
            <span>number of plays</span>
            <select aria-label="Number of plays" value={count} disabled={!!busy} onChange={(e) => setCount(Number(e.target.value))}>
              {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <small>{`${count} independent ${count === 1 ? "roll" : "rolls"}. Each fork adds a second paid opening bid. Every paid bid adds 1 atom. Sign once, submit in order.`}</small>
            <strong>{count}–{maxBids} paid bids · {compact(totalUnits)}–{compact(maxTotalUnits)} ${sym}{v.asset.usd !== null ? ` · ~${money(totalUnits * v.asset.usd)}–${money(maxTotalUnits * v.asset.usd)}` : ""}</strong><small>The exact total is prepared before your wallet signs.</small>
          </label>
          {!publicKey ? <WalletButton solo /> : (
            <button className="btn war-go" disabled={batchBlocked || !!busy || tooLow || bidRaw <= 0n || !list.ready || !!list.error} onClick={bid}>
              {busy === "multibid" ? "Bidding…" : tooLow || bidRaw <= 0n ? `At least ${compact(minUnits)} $${sym}` : `${count === 1 ? "Play" : `Play ${count} times`} · up to ${compact(maxTotalUnits)} $${sym}`}
            </button>
          )}
          {list.error && <small className="war-err">{list.error}. Waiting for the full set of clocks before bidding.</small>}
          {v.me?.tokenBalance && maxTotalRaw > BigInt(v.me.tokenBalance.raw) && <small className="war-zap">You hold {compact(v.me.tokenBalance.units)} ${sym}; any shortfall for the prepared batch swaps in from SOL in the same click.</small>}
        </section>
      )}
      {busy === "multibid" && prepared && <p role="status" className="war-payoff">Prepared: {prepared.bids} paid {prepared.bids === 1 ? "bid" : "bids"} · {rawToken(prepared.total, dec)} ${sym}{v.asset.usd !== null ? ` · ~${money(Number(prepared.total) / 10 ** dec * v.asset.usd)}` : ""}</p>}
      {busy && progress && <p role="status" className="war-routing-note">{progress.confirmed} / {progress.total} transactions landed · submitting in order</p>}
      {batchBlocked && <section className="war-ticket"><p className="war-err">The batch stopped. Some bids may have landed; check the latest game state before trying another batch.</p><button className="btn small" onClick={() => window.location.reload()}>Reload game</button></section>}

      {posted && (
        <section className="war-post">
          <p>Now tell X. Your link pays you {v.pct.referrer / 100}% of the pot if a bid through it wins.</p>
          <div className="war-actions">
            <a className="btn war-go" href={intent(posted.text, shareLink(posted.game, posted.sc, me), posted.game.thread)} target="_blank" rel="noopener noreferrer">{posted.game.thread ? "Reply in the war thread" : "Post it"}</a>
            {posted.game.thread && <a className="btn small" href={intent(posted.text, shareLink(posted.game, posted.sc, me), posted.game.thread, true)} target="_blank" rel="noopener noreferrer">Quote the war</a>}
          </div>
        </section>
      )}

      <section className="war-stats">
        <div><small>next bid</small><b>{both(v.minNext, sym)}</b></div>
        <div><small>quote keys</small><b>{quoteKeys}</b></div>
        <div><small>quote bids</small><b>{quoteBids}</b></div>
        <div><small>next game's round</small><b>{Math.round(v.roundSecs / 60)} min · +{v.antiSnipeExtendSecs}s in the last {v.antiSnipeSecs}s</b></div>
      </section>
      {siblings.length > 1 && <details className="war-set"><summary>{siblings.length} games on ${sym}</summary><ul className="war-watch-rest">{siblings.map((g) => <li key={g.id}><span>#{g.id}</span><b>minimum {formatWarTokenAmount(BigInt(g.minBid.raw), dec)} ${sym}</b></li>)}</ul></details>}

      <WarQuotePosition mint={v.asset.mint} symbol={sym} decimals={dec} usd={v.asset.usd} revision={list.revision} disabled={!!busy} onBusyChange={(active) => setBusy(active ? "claimall" : null)} />

      <Holders id={v.id} sym={sym} me={me} thread={v.thread} />

      <section className="war-rules">
        <p>Beat the last bid. Every bid mints a key, and every later bid pays a slice to the keys before it. The clock starts on the second bid; a bid in the last {v.antiSnipeSecs}s adds {v.antiSnipeExtendSecs}s. When it dies, the last bid takes {v.pct.winner / 100}% of the pot, whoever's link brought that bid in takes {v.pct.referrer / 100}%, the war's creator {v.pct.creator / 100}%.</p>
        <p>
          <a href={v.thread ? `https://x.com/lastbidwins/status/${v.thread}` : "https://x.com/lastbidwins"} target="_blank" rel="noopener noreferrer">the war on X</a> · <Link to="/w">all wars</Link> · <a href={`https://solscan.io/account/${v.key}`} target="_blank" rel="noopener noreferrer">on chain</a>
        </p>
      </section>
    </div>
  );
}

/** Explicit creation always previews fresh defaults, even while other games are open. */
export function NewWarPage() {
  const [query] = useSearchParams();
  const mint = query.get("mint") || "SOL";
  const minimum = query.get("min");
  return <NewGameLoader key={`${mint}:${minimum}`} mint={mint} minimum={minimum} />;
}

function NewGameLoader({ mint, minimum }: { mint: string; minimum: string | null }) {
  const preview = usePoll<{ template: View }>(async () => {
    const r = await fetch(`/api/war?start=1&mint=${encodeURIComponent(mint)}${minimum !== null ? `&min=${encodeURIComponent(minimum)}` : ""}`, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "couldn't prepare the new game");
    return j;
  }, [mint, minimum], 15_000);
  if (!preview.data) {
    return <div className="war"><p className={preview.error ? "war-err" : "war-loading"}>{preview.error ?? "Preparing a fresh game…"}</p><Link to="/w">All wars</Link></div>;
  }
  return <NewGamePreview draft={preview.data.template} error={preview.error} />;
}

function NewGamePreview({ draft, first = false, error }: { draft: View; first?: boolean; error?: string | null }) {
  const [query] = useSearchParams();
  const [count, setCount] = useState(() => Math.min(20, Math.max(1, Math.floor(Number(query.get("count")) || 1))));
  const [minimum, setMinimum] = useState(() => query.get("min") ?? formatWarTokenAmount(BigInt(draft.minBid.raw), draft.asset.decimals));
  const { publicKey } = useWallet();
  const parsed = useMemo(() => {
    try { return { raw: parseWarTokenAmount(minimum, draft.asset.decimals), error: null }; }
    catch (e) { return { raw: 0n, error: e instanceof Error ? e.message : "Enter a valid minimum bid." }; }
  }, [minimum, draft.asset.decimals]);
  const opening = parsed.raw;
  const maximumBids = count * 2 - 1; // The explicit first creation always has one paid opener.
  const maximum = BigInt(maximumBids) * opening + BigInt(maximumBids * (maximumBids - 1) / 2);
  const sym = draft.asset.symbol;
  const mint = draft.asset.mint ?? "SOL";
  const openingUsd = draft.asset.usd === null ? null : Number(opening) / 10 ** draft.asset.decimals * draft.asset.usd;
  const amountError = parsed.error ?? (opening + BigInt(maximumBids - 1) > (1n << 64n) - 1n ? "Lower the minimum bid or choose fewer plays so every paid bid fits the token's amount range." : null);
  const action = new URLSearchParams({ op: "start", mint, min: formatWarTokenAmount(opening, draft.asset.decimals), count: String(count) });
  return <div className="war">
    <header className="war-head"><span className="war-tag">New ${sym} game</span><Link className="btn small" to={`/play/${mint}`}>Quote wars</Link></header>
    <section className="war-ticket">
      <MyTeam team={publicKey ? autoTeam(publicKey) : 1} known={!!publicKey} />
      <p className="war-routing-note">{first ? "No games on this quote yet. " : ""}Choose the minimum bid for your new game. Enter ${sym} directly, including decimals.</p>
      <label className="war-amount">
        <span>minimum bid in ${sym}</span>
        <input type="text" inputMode="decimal" aria-label={`Minimum bid in $${sym}`} aria-invalid={!!amountError} aria-describedby="new-game-minimum-help" value={minimum} onChange={(e) => setMinimum(e.target.value)} spellCheck={false} autoComplete="off" />
        <small id="new-game-minimum-help">{draft.asset.decimals === 0 ? "Whole tokens only." : `Up to ${draft.asset.decimals} decimal places. Smallest bid: ${formatWarTokenAmount(1n, draft.asset.decimals)} $${sym}.`}{!amountError && openingUsd !== null ? ` ~${money(openingUsd)}` : ""}</small>
        {amountError && <small className="war-err" role="alert">{amountError}</small>}
      </label>
      <div className="war-stats">
        <div><small>opening bid</small><b>{amountError ? "—" : `${formatWarTokenAmount(opening, draft.asset.decimals)} $${sym}`}</b></div>
        <div><small>clock</small><b>{Math.round(draft.roundSecs / 60)} minutes</b></div>
        <div><small>last bid wins</small><b>{draft.pct.winner / 100}% of the pot</b></div>
        <div><small>creator share</small><b>{draft.pct.creator / 100}% of the pot</b></div>
      </div>
      <label className="war-multibid">
        <span>number of plays</span>
        <select aria-label="Number of plays" value={count} onChange={(e) => setCount(Number(e.target.value))}>{Array.from({ length: 20 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}</select>
        <small>The first play creates your new game with one opening bid. Its clock starts on bid two.{count > 1 ? " Further plays follow the lowest required bid on this quote. Each eligible play rolls 25% for a fork with two paid opening bids." : ""}</small>
        {!amountError && <strong>{count === 1 ? `1 paid opening bid · ${formatWarTokenAmount(opening, draft.asset.decimals)}` : `Up to ${maximumBids} paid bids · ${formatWarTokenAmount(maximum, draft.asset.decimals)}`} ${sym}</strong>}
        <small>Plus network fees and account rent. The exact total is prepared before your wallet signs.</small>
      </label>
      {error ? <p className="war-err">{error}</p> : amountError ? <button className="btn war-go war-create-game" disabled>Enter a valid minimum bid</button> : <Link className="btn war-go war-create-game" to={`/a?${action}`}>{first ? "Open the first game" : "Create new game"}{count > 1 ? ` · ${count} plays` : ""}</Link>}
    </section>
  </div>;
}

function MyTeam({ team, known }: { team: number; known: boolean }) {
  return (
    <div className="war-myteam">
      <Creature team={team} size={44} />
      <span style={{ color: TEAM_COLOR[team] }}>{known ? `you're team ${TEAMS[team]}` : "your team is picked from your wallet"}</span>
    </div>
  );
}

export function TeamPick({ team, setTeam, teams }: { team: number; setTeam: (t: number) => void; teams: Record<string, number> }) {
  return (
    <div className="war-teams" role="radiogroup" aria-label="Team">
      {TEAMS.map((t, i) => (
        <button key={t} role="radio" aria-checked={team === i} className={team === i ? "on" : ""} style={{ borderColor: team === i ? TEAM_COLOR[i] : undefined }} onClick={() => setTeam(i)}>
          <Creature team={i} size={56} />
          <span style={{ color: TEAM_COLOR[i] }}>{t}</span>
          <small>{teams[t] ?? 0} bids</small>
        </button>
      ))}
    </div>
  );
}

type QuoteGroup = { mint: string | null; symbol: string; games: View[] };
function QuoteWarRow({ game: g, now }: { game: View; now: number }) {
  const status = g.over || (g.deadline !== 0 && g.deadline <= now) ? "ended" : g.deadline === 0 ? "waiting" : "running";
  return <li><Link to={`/w/${g.id}`}><span>#{g.id} · next {formatWarTokenAmount(effectiveWarMinBid(g), g.asset.decimals)} ${g.asset.symbol} · {g.bids.toLocaleString()} bids</span><b>{g.pot.usd !== null ? money(g.pot.usd) : `${formatWarTokenAmount(BigInt(g.pot.raw), g.asset.decimals)} $${g.asset.symbol}`}</b><small>{status}</small></Link></li>;
}
function groupByQuote(games: View[], now: number): QuoteGroup[] {
  const groups = new Map<string, QuoteGroup>();
  for (const game of games) {
    const key = game.asset.mint ?? "SOL";
    const group = groups.get(key) ?? { mint: game.asset.mint, symbol: game.asset.symbol, games: [] };
    group.games.push(game);
    groups.set(key, group);
  }
  // Compare bid amounts only within the same asset; quotes have different units.
  for (const group of groups.values()) group.games = sortQuoteWarGames(group.games, now);
  return [...groups.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || (a.mint ?? "").localeCompare(b.mint ?? ""));
}

/** Discovery and all wars share quote groups and the lowest required bid. */
function QuoteDiscovery({ mint }: { mint?: string }) {
  const [search, setSearch] = useState("");
  const list = useWarLiveGames();
  const [tick, setTick] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setTick(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  const all = groupByQuote((list.data?.games ?? []).map(clientView), tick);
  const term = search.trim().toLowerCase();
  const groups = all.filter((g) => (!mint || (/^sol$/i.test(mint) ? g.mint === null : g.mint === mint))
    && (!term || g.symbol.toLowerCase().includes(term) || (g.mint ?? "SOL").toLowerCase().includes(term)));
  return (
    <div className="war war-discovery">
      <header className="war-head">
        <span className="war-tag">last bid wins · {mint ? "quote wars" : "all quotes"}</span>
        <div className="war-actions"><Link className="btn small" to={mint ? "/w" : "/w/featured"}>{mint ? "All quotes" : "Gold run"}</Link><Link className="btn small" to={`/w/new?mint=${encodeURIComponent(mint ?? "SOL")}`}>New game</Link></div>
      </header>
      <p className="war-routing-note">One quote, many wars. Bids go to the game with the lowest required next bid for that quote. Each eligible play has a 25% chance to open a matching war with two paid opening bids, starting its clock immediately. Forks are eligible while all running clocks for the quote have more than two minutes left.</p>
      {!mint && <label className="war-quote-search"><span>Find a quote</span><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Token or mint address" /></label>}
      {list.error && <p className="war-err">{list.error}</p>}
      {!list.data ? <p className="war-loading">loading quote groups…</p> : groups.length === 0 ? <p className="war-loading">No wars found for this quote.{mint && <Link className="btn small" to={`/w/new?mint=${encodeURIComponent(mint)}`}>Open the first game</Link>}</p> : (
        <div className="war-quote-groups">
          {groups.map((group) => {
            const first = group.games[0];
            const active = group.games.filter((g) => !g.over && (!g.deadline || g.deadline > tick));
            const target = active[0] ?? first;
            const running = !target.over && target.deadline > tick;
            const pot = group.games.reduce((n, g) => n + BigInt(g.pot.raw), 0n);
            const bids = group.games.reduce((n, g) => n + g.bids, 0);
            const keys = group.games.reduce((n, g) => n + g.keys, 0);
            const units = formatWarTokenAmount(pot, first.asset.decimals);
            const total = Number(pot) / 10 ** first.asset.decimals;
            const usd = first.asset.usd === null ? null : total * first.asset.usd;
            const quote = group.mint ?? "SOL";
            return (
              <section className="war-quote-card" key={quote}>
                <header className="war-head">
                  <Link className="war-tag" to={`/play/${quote}`}>${group.symbol}</Link>
                  <span>{active.length} active {active.length === 1 ? "war" : "wars"}</span>
                </header>
                <div className="war-quote-total"><strong>{usd !== null ? money(usd) : `${units} $${group.symbol}`}</strong><small>{usd !== null ? `${units} $${group.symbol} across this quote` : "across this quote"}</small></div>
                <div className="war-quote-clock"><span>Lowest bid game</span><strong>{running ? clock(target.deadline - tick) : active.length > 0 ? "Waiting" : "Ended"}</strong></div>
                <dl className="war-quote-stats"><div className="war-quote-next"><dt>Next bid</dt><dd>{active.length > 0 ? `${formatWarTokenAmount(effectiveWarMinBid(target), target.asset.decimals)} $${group.symbol}` : "—"}</dd></div><div><dt>Bids</dt><dd>{bids.toLocaleString()}</dd></div><div><dt>Keys</dt><dd>{keys.toLocaleString()}</dd></div></dl>
                <details className="war-quote-more"><summary>{group.games.length} {group.games.length === 1 ? "game" : "games"}</summary><ul className="war-list">{group.games.map((g) => <QuoteWarRow key={g.id} game={g} now={tick} />)}</ul></details>
                <div className="war-actions"><Link className="btn war-go" to={`/w/play?g=${target.id}&mint=${encodeURIComponent(quote)}`}>Play ${group.symbol}</Link><Link className="btn small" to={`/w/new?mint=${encodeURIComponent(quote)}`}>New ${group.symbol} game</Link></div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function WatchPage() {
  const { mint } = useParams();
  return <QuoteDiscovery mint={mint} />;
}

export function WarLobby() {
  return <QuoteDiscovery />;
}

type HRow = { wallet: string; keys: number; leader: boolean; risked: { units: number; usd: number | null }; earned: { units: number; usd: number | null }; multiple: number; ifEnds: number };
/** Who holds the keys: what each put in, what their keys earned, the multiple (the leader's includes the win if it ended now). */
function Holders({ id, sym, me, thread }: { id: number; sym: string; me: string | null; thread: string | null }) {
  const h = usePoll<{ holders: number; top: HRow[]; avg: { keys: number; risked: { units: number; usd: number | null }; earned: { units: number; usd: number | null }; multiple: number } }>(
    async () => (await fetch(`/api/war?g=${id}&holders=1`)).json(), [id], 15_000);
  const d = h.data;
  if (!d || !d.holders) return null;
  const amt = (a: { units: number; usd: number | null }) => (a.usd !== null ? money(a.usd) : `${compact(a.units)} $${sym}`);
  return (
    <section className="war-holders">
      <header>
        <small>keyholders · {d.holders}</small>
        <small>avg {amt(d.avg.risked)} in · {amt(d.avg.earned)} earned · {d.avg.multiple.toFixed(2)}×</small>
        <ShareX game={id} me={me} thread={thread}
          text={`war #${id} keyholders: ${d.holders} of them, avg ${d.avg.multiple.toFixed(2)}× so far.\ntop: ${d.top.slice(0, 3).map((r) => `${short(r.wallet)}${r.leader ? "👑" : ""} ${(r.leader ? r.ifEnds : r.multiple).toFixed(2)}×`).join(" · ")}\nevery bid mints a key that earns off each later bid ↓`} />
      </header>
      <table>
        <thead><tr><th>holder</th><th>keys</th><th>in</th><th>earned</th><th>multiple</th></tr></thead>
        <tbody>
          {d.top.map((r) => (
            <tr key={r.wallet} className={r.leader ? "lead" : ""}>
              <td>{short(r.wallet)}{r.leader ? " 👑" : ""}</td>
              <td>{r.keys}</td>
              <td>{amt(r.risked)}</td>
              <td>{amt(r.earned)}</td>
              <td title={r.leader ? "dividends plus the 70% win if the clock died now" : "dividends so far ÷ what they put in"}>{(r.leader ? r.ifEnds : r.multiple).toFixed(2)}×</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
