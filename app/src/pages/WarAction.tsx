// /a — the X action link. A post or a bot reply carries e.g. lastbidwins.fun/a?op=bid&g=1083&team=snek&amt=2x&ref=<wallet>.
// Tapping it never shows the site: on a phone the page hands itself to Phantom's in-app browser at once; with a wallet present
// it connects, has the server build the transaction, asks the wallet to sign, sends, and returns to X with the reply under the
// war's thread already written (and an action link in it, so the next player is one tap away too).
//   op = bid (default) | play | next | claim | settle | start (start takes mint=<mint>|SOL); count=1..20 plays
import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { WalletName } from "@solana/wallet-adapter-base";
import { VersionedTransaction } from "@solana/web3.js";
import { humanError } from "../hooks";
import { sendWarRaw } from "../lib/war-confirm";
import { storedRef, captureRef } from "../lib/ref";
import { isMobileBrowser, walletBrowserLinks } from "../lib/mobile";
import { bullSvg, snekSvg, bearSvg, crownSvg } from "../../api/_lib/creatures";
import { autoTeam, phantomLink, xCompose } from "../lib/war";
import { chooseQuoteWarTarget, chooseWarTarget, parseWarTokenAmount, planWarBids, type WarBidMove, type WarRoutingGame } from "../lib/war-routing";
import { signAndSendWarTransactions, WarSendError } from "../lib/war-send";

const SITE = "https://lastbidwins.fun";
const BURNER = "Burner";
const TEAMS = ["Bull", "Snek", "Bear"];
const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K` : n >= 1 ? n.toFixed(2) : n.toPrecision(3));
const money = (u: number | null | undefined) => (u == null ? "" : u >= 1 ? `$${u.toFixed(2)}` : `$${u.toPrecision(2)}`);
const exactUnits = (raw: string, decimals: number) => {
  if (!decimals) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return `${padded.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
};
type Stage = "finding" | "connecting" | "building" | "signing" | "sending" | "posting" | "error";
const SAY: Record<Stage, string> = {
  finding: "Finding your wallet…", connecting: "Connect in your wallet", building: "Building your move…", signing: "Sign in your wallet",
  sending: "Sending…", posting: "Done. Back to X…", error: "",
};
type Amount = { units: number; usd: number | null };
type Stake = WarRoutingGame & {
  asset: WarRoutingGame["asset"] & { symbol: string; decimals: number };
  bids: number; lastBid: { raw: string };
  pot: Amount; minNext: Amount & { raw: string };
  payoffs?: { team: string; win: Amount; multiple: number }[];
  payoff?: { win: Amount; multiple: number };
  phase: string;
};
type ActionBidMove = WarBidMove | { op: "start"; mint: string | null; amount: string; min?: string };
// Action links accept the same token amounts and multipliers as the transaction builder.
function actionAmount(game: Stake, value: string, opening = false) {
  const min = BigInt(opening ? game.minBid.raw : game.minNext.raw);
  const spec = value.toLowerCase().replace(/\s/g, "");
  if (["2x", "2×", "double"].includes(spec)) return min * 2n;
  if (["+10%", "10pct", "10%"].includes(spec)) return (min * 11n) / 10n;
  if (["+5%", "5pct", "5%"].includes(spec)) return (min * 105n) / 100n;
  const match = spec.match(/^(\d+(?:\.\d+)?)(k|m|b)?$/);
  if (!match) return min;
  const multiplier = match[2] === "k" ? 1_000n : match[2] === "m" ? 1_000_000n : match[2] === "b" ? 1_000_000_000n : 1n;
  const raw = parseWarTokenAmount(match[1], game.asset.decimals) * multiplier;
  return raw < min ? min : raw;
}

export default function WarAction() {
  const q = new URLSearchParams(window.location.search);
  const op = q.get("op") ?? "bid";
  const g = q.get("g") ?? "featured";
  const { wallets, select, wallet, publicKey, signAllTransactions, signTransaction } = useWallet();
  // teams are cosmetic: a wallet's team comes from its address (the server does the same)
  const teamName = (q.get("team") ?? "auto").toLowerCase();
  const picked = ["bull", "snek", "bear"].indexOf(teamName);
  const team = picked >= 0 ? picked : publicKey ? autoTeam(publicKey) : 1;
  const [stage, setStage] = useState<Stage>("finding");
  const [err, setErr] = useState<string | null>(null);
  const [handoff, setHandoff] = useState(false);
  const [back, setBack] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string>(g);
  const [spend, setSpend] = useState<(Amount & { raw?: string; count: number; plays: number; games: number }) | null>(null);
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null);
  const [completedTransactions, setCompletedTransactions] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const started = useRef(false);
  useEffect(() => captureRef(window.location.search), []);
  // what's at stake, in dollars, while the wallet does its thing
  const [stake, setStake] = useState<Stake | null>(null);
  const webLink = (game?: string) => {
    const params = new URLSearchParams(q);
    const route = op === "start" ? "new" : op === "play" ? "play" : g;
    params.delete("op");
    if (game !== undefined || op !== "play") params.delete("g");
    if (op === "start" && !params.has("mint")) params.set("mint", "SOL");
    return `/w/${game ?? route}${params.size ? `?${params}` : ""}`;
  };
  useEffect(() => {
    if (op !== "bid" && op !== "play" && op !== "start") return;
    const m = q.get("mint");
    const params = new URLSearchParams(op === "start" ? { start: "1" } : { g: op === "play" ? "play" : g });
    if ((op === "play" || op === "start") && m) params.set("mint", m);
    if (op === "start" && q.has("min")) params.set("min", q.get("min")!);
    fetch(`/api/war?${params}`).then((r) => r.json()).then((j) => !j.error && setStake(j.template ?? j)).catch(() => null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 1) find a wallet. Extensions register a beat after load, so give them a moment; a phone with none goes to Phantom.
  useEffect(() => {
    if (wallet || publicKey) return;
    const t = setTimeout(() => {
      const real = wallets.filter((w) => w.readyState === "Installed" && w.adapter.name !== BURNER);
      if (!real.length) {
        // straight into Phantom; only if the phone blocks that jump does a button show up
        if (isMobileBrowser()) {
          setTimeout(() => setHandoff(true), 1500);
          return window.location.replace(walletBrowserLinks()[0].href);
        }
        // no wallet on a desktop: show the war itself (the web version) rather than an error
        return window.location.replace(webLink());
      }
      setStage("connecting");
      select((real.find((w) => w.adapter.name === "Phantom") ?? real[0]).adapter.name as WalletName);
    }, 900);
    return () => clearTimeout(t);
  }, [wallets, wallet, publicKey, select]);

  // 2) connected: build, sign, send, go back to X
  useEffect(() => {
    if (!publicKey || started.current) return;
    started.current = true;
    void run();
  }, [publicKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    const me = publicKey!.toBase58();
    let confirmed = 0;
    let transactionCount = 0;
    let attempted = false;
    try {
      setStage("building");
      setErr(null);
      setSpend(null);
      setSending(null);
      setCompletedTransactions(0);
      setSubmitted(false);
      const ref = q.get("ref") ?? storedRef()?.toBase58() ?? null;
      const count = Number(q.get("count") ?? 1);
      if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("choose between 1 and 20 plays");
      const body: { op: string; g: string; wallet: string; team: string; amt: string; min: string | null; count: number; ref: string | null; mint: string | null; zap: boolean; moves?: ActionBidMove[] } = { op, g, wallet: me, team: teamName, amt: q.get("amt") ?? "min", min: q.get("min"), count, ref: ref === me ? null : ref, mint: q.get("mint"), zap: q.get("zap") !== "0" };
      if (op === "bid" || op === "play" || count > 1 && (op === "next" || op === "start")) {
        const forceStart = op === "start";
        const params = new URLSearchParams(forceStart ? { start: "1" } : { g: op === "play" ? "play" : g });
        const fresh = String(Date.now());
        params.set("at", fresh);
        if ((op === "play" || forceStart) && body.mint) params.set("mint", body.mint);
        if (forceStart && body.min !== null) params.set("min", body.min);
        const [sourceResponse, gamesResponse] = await Promise.all([fetch(`/api/war?${params}`, { cache: "no-store" }), fetch(`/api/war?list=1&at=${fresh}`, { cache: "no-store" })]);
        const [source, listed] = await Promise.all([sourceResponse.json(), gamesResponse.json()]);
        if (!sourceResponse.ok || source.error) throw new Error(source.error ?? "couldn't find that war");
        if (!gamesResponse.ok || listed.error || !Array.isArray(listed.games)) throw new Error(listed.error ?? "couldn't check the running clocks");
        const sourceTemplate = (source.start ? source.template : source) as Stake;
        const games = (listed.games as Stake[]).filter((game) => game.id !== sourceTemplate.id);
        // Each play gets its own eligible roll. Forks include both paid opening bids before routing the next play.
        const now = Math.floor(Date.now() / 1000);
        const set = [...games, sourceTemplate];
        const quoteScope = op === "bid" || op === "play";
        const first = forceStart ? { game: sourceTemplate, op: "next" as const }
          : quoteScope ? chooseQuoteWarTarget(set, sourceTemplate, now)
          : chooseWarTarget(set, sourceTemplate, now);
        const template = quoteScope ? first.game : sourceTemplate;
        const firstAmount = forceStart
          ? body.min === null ? BigInt(template.minBid.raw) : parseWarTokenAmount(body.min, template.asset.decimals)
          : actionAmount(first.game, body.amt, first.op === "next");
        const moves = planWarBids(set, template, now, count, firstAmount, Math.random, forceStart ? "next" : undefined, "quote");
        body.moves = moves.map((move, index): ActionBidMove => {
          if (move.g !== -1) return move;
          if (index === 0) return { op: "start", mint: template.asset.mint, amount: move.amount, ...(body.min === null ? {} : { min: body.min }) };
          return { op: move.op, amount: move.amount, from: 0 };
        });
        body.op = "multibid";
        setStake(template);
      }
      const r = await fetch("/api/war", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "couldn't build that move");
      const txs = (j.txs as string[]).map((b) => VersionedTransaction.deserialize(Uint8Array.from(atob(b), (c) => c.charCodeAt(0))));
      const s = j.summary;
      const totalUnits = s.units ?? s.opening;
      if (typeof totalUnits === "number") setSpend({ units: totalUnits, raw: s.total ?? s.amount, usd: s.usd ?? null, count: s.count ?? count, plays: s.plays ?? count, games: s.moves ? new Set((s.moves as { game: number }[]).map((move) => move.game)).size : 1 });
      setTargetId(String(s.game ?? body.g));
      setStage("signing");
      await signAndSendWarTransactions(txs, { signAllTransactions, signTransaction }, sendWarRaw, (progress) => {
        confirmed = progress.confirmed;
        transactionCount = progress.total;
        attempted = progress.submitted;
        setSubmitted(attempted);
        setStage("sending");
        setSending({ done: confirmed, total: transactionCount });
      });
      setStage("posting");
      const did = s.op === "multibid" ? s.moves[s.moves.length - 1].op : s.op ?? op;
      const gameId = s.game ?? (op === "claimall" ? "featured" : body.g);
      const created: number[] = s.created ?? (["start", "next", "fork"].includes(did) ? [Number(gameId)] : []);
      await Promise.all(created.map((id) => fetch("/api/war", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "announce", g: id }) }).catch(() => null)));
      const viewResponse = await fetch(`/api/war?g=${gameId}`);
      const v = await viewResponse.json();
      if (!viewResponse.ok || v.error) throw new Error(v.error ?? "couldn't load the landed game for your post");
      const sym = v.asset?.symbol ?? "";
      // the card on this player's post is theirs: "<them> took the lead", pot and next bid, in tokens and USD
      const snipe = `${SITE}/a?op=bid&g=${v.id}&ref=${me}&sc=${did === "bid" ? "lead" : did === "claim" ? "divs" : "live"}&v=${v.tag}`;
      let text: string;
      const odds = v.payoff ? `${money(v.minNext?.usd) || `${compact(v.minNext?.units ?? 0)} $${sym}`} to win ${money(v.payoff.win?.usd) || `${compact(v.payoff.win?.units ?? 0)} $${sym}`} (${(v.payoff.multiple ?? 0).toFixed(1)}×)` : "";
      const bids = s.count ?? count;
      if (s.op === "multibid" && bids > 1) {
        const wars = new Set((s.moves as { game: number }[]).map((move) => move.game)).size;
        const plays = s.plays ?? count;
        text = `placed ${bids} bids${bids > plays ? ` from ${plays} play${plays === 1 ? "" : "s"}` : ""} across ${wars} war${wars === 1 ? "" : "s"} on $${sym}: ${compact(s.units)} $${sym}${s.usd != null ? ` (~${money(s.usd)})` : ""} for ${TEAMS[team]}.\nlatest lead: war #${v.id}. ${odds ? `top me: ${odds} ↓` : "tap to top me ↓"}`;
      }
      else if (did === "bid") text = `took the lead in war #${v.id}${bids > 1 ? ` with ${bids} bids` : ""}: ${compact(s.units)} $${sym}${s.usd != null ? ` (~${money(s.usd)})` : ""} for ${TEAMS[team]}.\npot ~${money(v.pot?.usd)}. ${odds ? `top me: ${odds} ↓` : "tap to top me ↓"}`;
      else if (did === "start" || did === "next" || did === "fork") text = `opened war #${v.id} on $${sym}: ${compact(s.units ?? s.opening)} $${sym}${s.usd != null ? ` (~${money(s.usd)})` : ""} in${bids > 1 ? ` across ${bids} bids` : ""}. ${v.deadline ? "clock is running" : "clock starts on your bid"} ↓`;
      else if (did === "claimall") text = `my keys across ${s.wars} war${s.wars === 1 ? "" : "s"} just paid me ${(s.totals as { owed: number; symbol: string }[]).map((t) => `${compact(t.owed)} $${t.symbol}`).join(" + ")}${s.usd != null ? ` (~${money(s.usd)})` : ""}. every bid mints a key that earns off each later bid ↓`;
      else if (did === "claim") text = `my keys in war #${v.id} paid me ${compact(s.owed)} $${sym}${s.usd != null ? ` (~${money(s.usd)})` : ""}. every bid mints a key that earns off every bid after it ↓`;
      else text = `war #${v.id} settled: the last bid took ${compact(v.winnerTakes?.units ?? 0)} $${sym}${v.winnerTakes?.usd != null ? ` (~${money(v.winnerTakes.usd)})` : ""}. next war ↓`;
      const next = did === "settle" ? `${SITE}/a?op=next&g=${v.id}&ref=${me}` : snipe;
      // have the card ready before X looks at the link (it caches a miss)
      await Promise.race([
        fetch("/api/war", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "prewarm", url: next }) }).catch(() => null),
        new Promise((r) => setTimeout(r, 6_000)),
      ]);
      // phones tap the Phantom link (opens the wallet itself); the card and desktop use ours
      const x = xCompose(`${text}\n📱 ${phantomLink(next)}`, next, v.thread ?? null, q.get("quote") === "1");
      if (isMobileBrowser()) {
        // the X app's own scheme opens the app; if we're still here a moment later, the web composer instead
        let left = false;
        const away = () => { if (document.visibilityState === "hidden") left = true; };
        document.addEventListener("visibilitychange", away);
        setBack(x.app);
        window.location.href = x.app;
        setTimeout(() => { document.removeEventListener("visibilitychange", away); if (!left) window.location.assign(x.web); }, 1200);
      } else {
        setTimeout(() => setBack(x.web), 1500); // fallback only, if the jump back to X didn't happen
        window.location.assign(x.web);
      }
    } catch (e) {
      if (e instanceof WarSendError) {
        confirmed = e.confirmed;
        transactionCount = e.total;
        attempted = e.submitted;
      }
      setCompletedTransactions(confirmed);
      setSubmitted(attempted);
      setErr(`${humanError(e)}${confirmed ? ` ${confirmed} of ${transactionCount} transactions already landed.` : ""}${attempted && confirmed < transactionCount ? " A submitted transaction may still land." : ""}${attempted ? " Open the war to review the result." : ""}`);
      setStage("error");
      started.current = attempted;
    }
  }

  const s = 46, cx = 64, cy = 74;
  const art = [bullSvg, snekSvg, bearSvg][team](cx, cy, s) + crownSvg(cx, cy - s * 1.25, s * 0.85);
  let message = SAY[stage];
  if (handoff) message = "Open it in your wallet";
  else if (stage === "error") message = completedTransactions ? sending && completedTransactions === sending.total ? "Your move landed." : "Some transactions landed." : submitted ? "Check your submitted move." : "That didn't go through.";
  else if (stage === "sending" && sending && sending.total > 1) message = `Sending ${Math.min(sending.done + 1, sending.total)} of ${sending.total}…`;
  return (
    <div className="war-action">
      <span className="war-creature" aria-hidden="true" dangerouslySetInnerHTML={{ __html: `<svg width="128" height="128" viewBox="0 0 128 128">${art}</svg>` }} />
      <p className="war-action-stage" aria-live="polite">{message}</p>
      {stake && stage !== "error" && (() => {
        const sym = stake.asset.symbol;
        const pick = publicKey ? stake.payoffs?.[team] : undefined;
        const p = pick ?? stake.payoff;
        const usd = (a: { units: number; usd: number | null }) => (a.usd !== null ? money(a.usd) : `${compact(a.units)} $${sym}`);
        return (
          <div className="war-action-stake">
            <small>{spend ? spend.games > 1 ? `$${sym} · ${spend.games} wars` : `war #${targetId} · $${sym}` : stake.id < 0 ? `new war · $${sym}` : `war #${stake.id} · $${sym} · pot ${usd(stake.pot)}`}</small>
            {spend ? <strong>total: {spend.raw ? exactUnits(spend.raw, stake.asset.decimals) : spend.units} ${sym}{spend.usd !== null ? ` (~${money(spend.usd)})` : ""} · {spend.count} paid bid{spend.count === 1 ? "" : "s"}, sent in order</strong> : p && <strong>next bid: {usd(stake.minNext)} to win {usd(p.win)} ({p.multiple.toFixed(1)}×) if nobody tops it</strong>}
            {spend && spend.count > spend.plays && <small>{spend.plays} play{spend.plays === 1 ? "" : "s"}; every fork includes two paid opening bids to start its clock.</small>}
          </div>
        );
      })()}
      {handoff && (
        <div className="war-actions war-action-wallets">
          {walletBrowserLinks().map((l, i) => <a key={l.name} className={i === 0 ? "btn war-go" : "btn small"} href={l.href}>Open in {l.name}</a>)}
        </div>
      )}
      {back && <a className="btn war-go" href={back}>Post on X</a>}
      {stage === "error" && (
        <>
          <p className="war-action-err">{err}</p>
          <div className="war-actions">
            {publicKey && !submitted && <button className="btn" onClick={() => { started.current = true; void run(); }}>Try again</button>}
            <a className="btn small" href={webLink(submitted ? targetId : undefined)}>Open the war</a>
          </div>
        </>
      )}
    </div>
  );
}
