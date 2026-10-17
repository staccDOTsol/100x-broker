// @lastbidwins' mention desk, run by Vercel cron every minute. People play by posting at the bot; it answers each command with
// a one-tap action link (lastbidwins.fun/a?…) that opens their wallet, does the move, and brings them back to X.
//   "@lastbidwins war $BONK" | "war <mint>" | "war sol"   -> open a new war on that token
//   "@lastbidwins bid [min|+10%|2x|60k]"   -> bid in the war this thread is about (else the gold run); team comes from the wallet
//   "@lastbidwins next" | "claim" (every war) | "settle" | "pot" | "wars" | "divs" | "me <wallet>" | "help"
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { xPost } from "./_lib/xpost.js";
import { prewarm, lastUrl } from "./_lib/prewarm.js";
import { gameOfThread, readJson, readLatest, writeJson, writeVersioned } from "./_lib/warthread.js";
import { readView, FEATURED, amountText, bagSummary, payoffText, holdersView } from "./war.js";
import { PublicKey } from "@solana/web3.js";
import { phantomLink } from "../src/lib/war.js";

/** Every answer ends with the move twice: a Phantom link (tap on a phone) and the lastbidwins link (desktop + the card). */
const both = (url: string) => {
  const card = `${url}${url.includes("?") ? "&" : "?"}t=${Math.floor(Date.now() / 60_000)}`; // a new URL per minute: X re-reads the card
  return `📱 ${phantomLink(url)}\n💻 ${card}`;
};

const SITE = "https://lastbidwins.fun";
const ME = "2102453936699449344"; // @lastbidwins
type Mention = { id: string; text: string; author_id: string; conversation_id?: string; entities?: { urls?: { expanded_url?: string }[] } };

async function mentionsSince(since: string | null): Promise<Mention[]> {
  const u = new URL(`https://api.x.com/2/users/${ME}/mentions`);
  u.searchParams.set("max_results", "20");
  u.searchParams.set("tweet.fields", "conversation_id,author_id,entities");
  if (since) u.searchParams.set("since_id", since);
  const r = await fetch(u, { headers: { authorization: `Bearer ${process.env.X_BEARER_TOKEN}` } });
  const j = (await r.json()) as { data?: Mention[]; title?: string };
  if (!r.ok) throw new Error(`mentions ${r.status} ${j.title ?? ""}`);
  return (j.data ?? []).reverse(); // oldest first
}

async function resolveMint(q: string): Promise<{ mint: string | null; label: string } | null> {
  const s = q.replace(/^\$/, "");
  if (/^sol$/i.test(s)) return { mint: null, label: "SOL" };
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return { mint: s, label: `${s.slice(0, 4)}…` };
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) return null;
  const r = await fetch(`https://public-api.birdeye.so/defi/v3/search?chain=solana&keyword=${encodeURIComponent(s)}&target=token&sort_by=volume_24h_usd&sort_type=desc&offset=0&limit=10`, { headers: { "X-API-KEY": key, "x-chain": "solana" } });
  const j = (await r.json()) as { data?: { items?: { type: string; result?: { address: string; symbol: string }[] }[] } };
  const hits = j.data?.items?.flatMap((i) => i.result ?? []) ?? [];
  const exact = hits.find((h) => h.symbol?.toLowerCase() === s.toLowerCase()) ?? hits[0];
  return exact ? { mint: exact.address, label: `$${exact.symbol}` } : null;
}

// ---- who is who: an X account's wallet, learned from the ref= its own game links carry (or "me <wallet>") ----
const isWallet = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
async function walletOf(authorId: string): Promise<string | null> {
  return (await readJson<{ wallet: string }>(`war/who/${authorId}.json`))?.wallet ?? null;
}
async function learnWallet(m: Mention) {
  const urls = (m.entities?.urls ?? []).map((u) => u.expanded_url ?? "").filter((u) => /lastbidwins\.fun/.test(u));
  for (const u of urls) {
    const ref = new URL(u).searchParams.get("ref");
    if (ref && isWallet(ref)) return writeJson(`war/who/${m.author_id}.json`, { wallet: ref, at: Date.now(), from: m.id });
  }
}
const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
const units = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n >= 1 ? n.toFixed(2) : n.toPrecision(2));
const usdTxt = (u: number | null) => (u === null ? "" : u >= 1 ? ` (~$${u.toFixed(2)})` : ` (~$${u.toPrecision(2)})`);

const pick = <T,>(xs: T[], seed: string) => xs[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % xs.length];
/** Any mention that isn't a command: answer with the war it's about (or the gold run) and the move, so every post spreads it. */
async function engage(m: Mention): Promise<string | null> {
  const g = (m.conversation_id && (await gameOfThread(m.conversation_id))) || FEATURED;
  const out = await readView(g);
  if (!out) return null;
  const v = out.v;
  const sym = v.asset.symbol;
  const clock = v.phase === "open" ? "clock starts on the next bid" : v.phase === "expired" ? "clock's dead" : `${Math.floor((v.secondsLeft ?? 0) / 60)}:${String((v.secondsLeft ?? 0) % 60).padStart(2, "0")} left`;
  const state = `war #${v.id}: pot ${amountText(v.pot, sym)} · ${clock}`;
  const t = m.text.toLowerCase();
  if (v.phase === "expired" || v.phase === "settled") return `${state}. last bid took it. start the next war and you're its creator ↓\n${both(`${SITE}/a?op=next&g=${v.id}`)}`;
  if (/took the lead|top me|snipe me/.test(t))
    return `${pick(["that's the lead.", "new leader.", "lead's taken."], m.id)} ${state}. ${payoffText(v, sym)}. who tops it? ↓\n${both(`${SITE}/a?op=bid&g=${v.id}`)}`;
  if (/opened war/.test(t)) return `${state}. first challenger starts the clock ↓\n${both(`${SITE}/a?op=bid&g=${v.id}`)}`;
  if (/paid me|dividend/.test(t)) return `keys are paying in war #${v.id}. every bid mints one that earns off each later bid. ${state} ↓\n${both(`${SITE}/a?op=bid&g=${v.id}`)}`;
  const hello = pick(["gm.", "gm gm.", "you rang.", "here.", "the pot's awake."], m.id);
  return `${hello} ${state}. ${payoffText(v, sym)}. tap, sign, you're winning ↓\n${both(`${SITE}/a?op=bid&g=${v.id}`)}`;
}

async function answer(m: Mention): Promise<string | null> {
  // a command is the first word after the leading @mentions ("@lastbidwins bid 2x"); players' own posts carry our links and
  // are never commands. Everything else still gets an answer: the live war and a tap to take the lead.
  const ours = /lastbidwins\.fun|phantom\.app/i.test(m.text);
  const words = m.text.toLowerCase().replace(/^[\s.]*(@\w+\s*)+/, " ").split(/\s+/).filter(Boolean);
  const cmd = !ours && /^(war|play|bid|next|claim|settle|pot|status|divs|bag|me|wars|games|help|keys|holders)$/.test(words[0] ?? "") ? 0 : -1;
  if (cmd < 0) return engage(m);
  const verb = words[cmd];
  const args = words.slice(cmd + 1);
  const rawArgs = m.text.replace(/^[\s.]*(@\w+\s*)+/, " ").split(/\s+/).filter(Boolean).slice(1);
  if (verb === "help") return `tag me with:\nbid · bid +5% · bid 60k (beat the last bid)\nwar $BONK · war <mint> · war sol (open your own war, 15% of its pot)\npot · wars · keys · divs · claim · next · settle · me <wallet>\n${SITE}/w`;
  if (verb === "wars" || verb === "games") {
    const r = await fetch(`${SITE}/api/war?list=1`);
    const j = (await r.json()) as { games: { id: number; phase: string; secondsLeft: number | null; pot: { units: number; usd: number | null }; asset: { symbol: string } }[] };
    const top = j.games.filter((g) => g.phase !== "expired").slice(0, 3).map((g) => `#${g.id} $${g.asset.symbol} pot${usdTxt(g.pot.usd) || ` ${units(g.pot.units)}`} · ${g.phase === "open" ? "open" : `${Math.ceil((g.secondsLeft ?? 0) / 60)}m`}`);
    return `live wars:\n${top.join("\n")}\nall of them ↓\n${SITE}/w`;
  }
  if (verb === "keys" || verb === "holders") {
    const g = (m.conversation_id && (await gameOfThread(m.conversation_id))) || FEATURED;
    const h = await holdersView(g);
    if (!h || !h.holders) return `no keyholders in war #${g} yet. the first bid mints the first key ↓\n${both(`${SITE}/a?op=bid&g=${g}`)}`;
    const line = (r: (typeof h.top)[number]) => `${short(r.wallet)}${r.leader ? "👑" : ""} ${r.keys}k in ${usdTxt(r.risked.usd).replace(/[()~ ]/g, "") || units(r.risked.units)} earned ${usdTxt(r.earned.usd).replace(/[()~ ]/g, "") || units(r.earned.units)} ${(r.leader ? r.ifEnds : r.multiple).toFixed(2)}×`;
    return `war #${g} keys (${h.holders} holders, avg ${h.avg.multiple.toFixed(2)}× so far):\n${h.top.slice(0, 4).map(line).join("\n")}\n${SITE}/w/${g}`;
  }
  if (verb === "me" && rawArgs[0] && isWallet(rawArgs[0])) {
    await writeJson(`war/who/${m.author_id}.json`, { wallet: rawArgs[0], at: Date.now(), from: m.id });
    return `got it: you're ${short(rawArgs[0])}. "divs" shows your keys and dividends across every war.`;
  }
  if (verb === "divs" || verb === "bag" || verb === "me" || verb === "claim") {
    const w = await walletOf(m.author_id);
    if (!w) {
      if (verb === "claim") return `claim your dividends from every war in one tap ↓\n${both(`${SITE}/a?op=claimall`)}`;
      return `I don't know your wallet yet. bid from one of my links (they carry it), or reply "me <your wallet>".`;
    }
    const b = await bagSummary(new PublicKey(w));
    if (!b.wars) return `${short(w)} has no keys yet. every bid mints one. ↓\n${both(`${SITE}/a?op=bid&g=${FEATURED}`)}`;
    const owed = b.totals.filter((t) => t.owed > 0).map((t) => `${units(t.owed)} $${t.symbol}`).join(" + ");
    const head = `${short(w)}: ${b.keys} key${b.keys === 1 ? "" : "s"} in ${b.wars} war${b.wars === 1 ? "" : "s"}.`;
    if (!owed) return `${head} nothing to claim yet: keys earn off each later bid.`;
    return `${head} claimable: ${owed}${usdTxt(b.usd)}. claim all ↓\n${both(`${SITE}/a?op=claimall`)}`;
  }
  const g = (m.conversation_id && (await gameOfThread(m.conversation_id))) || FEATURED;
  if (verb === "war" || verb === "play") {
    const raw = m.text.replace(/^[\s.]*(@\w+\s*)+/, " ").split(/\s+/).filter(Boolean);
    const target = raw[1];
    if (!target && verb === "play") return `the hottest war right now, one tap ↓\n${both(`${SITE}/a?op=play`)}`;
    if (!target) return `name the token: "war $TICKER", "war <mint>" or "war sol"`;
    const t = await resolveMint(target);
    if (!t) return `couldn't find ${target}. try its mint address`;
    return `${t.label}: one tap joins its hottest war, or opens the first one (about $1 in, and you're its creator: 15% of its pot) ↓\n${both(`${SITE}/a?op=play&mint=${t.mint ?? "sol"}`)}`;
  }
  const out = await readView(g);
  if (!out) return null;
  const v = out.v;
  const sym = v.asset.symbol;
  if (verb === "pot" || verb === "status") {
    const clock = v.phase === "open" ? "clock starts on the next bid" : v.phase === "expired" ? "clock's dead, settle it" : `${Math.ceil((v.secondsLeft ?? 0) / 60)} min left`;
    return `war #${v.id}: pot ${amountText(v.pot, sym)} · ${clock}. ${payoffText(v, sym)}\n${SITE}/w/${v.id}?v=${v.tag}`;
  }
  if (verb === "bid") {
    const amt = args.find((a) => /^(min|\+5%|5pct|\+10%|10pct|2x|\d+(\.\d+)?[kmb]?)$/.test(a)) ?? "min";
    if (v.phase === "expired" || v.phase === "settled") return `war #${v.id} is over. start the next one and you're its creator ↓\n${both(`${SITE}/a?op=next&g=${v.id}`)}`;
    return `${amt === "min" ? payoffText(v, sym) : `${amt} in war #${v.id} (pot ${amountText(v.pot, sym)})`}. tap, sign, done ↓\n${both(`${SITE}/a?op=bid&g=${v.id}&amt=${encodeURIComponent(amt)}`)}`;
  }
  if (verb === "next") return `start the next war after #${v.id}. you're its creator ↓\n${both(`${SITE}/a?op=next&g=${v.id}`)}`;
  if (verb === "settle") return `settle war #${v.id}: the pot goes to the last bid ↓\n${both(`${SITE}/a?op=settle&g=${v.id}`)}`;
  return null;
}

/** Every war with a thread whose clock has died and whose winner hasn't been announced: post the result under its thread. */
async function crownWinners(state: BotState): Promise<number[]> {
  const r = await fetch(`https://blob.vercel-storage.com/?prefix=${encodeURIComponent("war/thread/")}&limit=200`, { headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`, "x-api-version": "11" } });
  const j = (await r.json()) as { blobs?: { pathname: string }[] };
  const ids = (j.blobs ?? []).map((b) => Number(b.pathname.match(/war\/thread\/(\d+)\.json$/)?.[1])).filter((n) => Number.isFinite(n));
  const done: number[] = [];
  for (const id of ids) {
    if (state.crowned!.includes(id)) continue;
    const h = await holdersView(id);
    if (!h || !h.ended || !h.winner) continue;
    const thread = (await readJson<{ tweetId: string }>(`war/thread/${id}.json`))?.tweetId;
    if (!thread) continue;
    const w = h.winner;
    const amt = (a: { units: number; usd: number | null }) => `${units(a.units)} $${h.symbol}${usdTxt(a.usd)}`;
    const text = [
      `war #${id} is over. ${short(w.wallet)} 👑 held the last bid and takes ${amt(h.win)}: ${(Number(h.win.units) / w.risked.units).toFixed(1)}× on a ${amt(w.risked)} bid.`,
      h.referrer ? `${short(h.referrer)} referred that bid: +${amt(h.referrerTakes)}.` : "",
      `keys paid ${h.holders} holders ${amt(h.keysEarned)} along the way.`,
      h.settled ? `next war, you're its creator ↓` : `the pot's still in the war: tap to pay it out and open the next one ↓`,
      both(`${SITE}/a?op=next&g=${id}`),
    ].filter(Boolean).join("\n");
    if (lastUrl(text)) await prewarm(lastUrl(text)!);
    await xPost(text, thread);
    state.crowned!.push(id);
    state.posts = (state.posts ?? 0) + 1;
    await saveState(state);
    done.push(id);
  }
  return done;
}

const DAILY_CAP = 90; // X Basic allows ~100 posts a day; keep headroom for announcements
type BotState = { since: string | null; day?: string; posts?: number; lockUntil?: number; answered?: string[]; crowned?: number[] };
const STATE = "war/bot/v/state-";
const saveState = (s: BotState) => writeVersioned(STATE, s);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  // newest versioned state; the old single-path record is the fallback the first time
  const state = (await readLatest<BotState>(STATE)) ?? (await readJson<BotState>("war/bot/state.json")) ?? { since: null };
  state.answered ??= [];
  state.crowned ??= [];
  const today = new Date().toISOString().slice(0, 10);
  if (state.day !== today) Object.assign(state, { day: today, posts: 0 });
  const done: string[] = [];
  // ?replay=<tweet id>: answer one specific mention now (ops)
  if (typeof req.query.replay === "string" && /^\d+$/.test(req.query.replay)) {
    const r = await fetch(`https://api.x.com/2/tweets/${req.query.replay}?tweet.fields=conversation_id,author_id,entities`, { headers: { authorization: `Bearer ${process.env.X_BEARER_TOKEN}` } });
    const j = (await r.json()) as { data?: Mention };
    if (!j.data) return res.status(404).json({ error: "tweet not found" });
    await learnWallet(j.data).catch(() => null);
    if (state.answered!.includes(j.data.id) && req.query.force !== "1") return res.json({ skipped: "already answered" });
    const text = await answer(j.data);
    if (text && lastUrl(text)) await prewarm(lastUrl(text)!);
    const id = text ? await xPost(text, j.data.id) : null;
    state.answered = [...state.answered!, j.data.id].slice(-300);
    await saveState(state);
    return res.json({ replied: id, text });
  }
  // one run at a time: warming a card can push a run past the next cron tick, and two runs would answer the same mention
  if ((state.lockUntil ?? 0) > Date.now()) return res.json({ skipped: "previous run still going" });
  state.lockUntil = Date.now() + 55_000;
  await saveState(state);
  try {
    const ms = await mentionsSince(state.since);
    // first run: don't answer the backlog, just start from now
    if (!state.since && ms.length) {
      await saveState({ ...state, since: ms[ms.length - 1].id, lockUntil: 0 });
      return res.json({ primed: ms[ms.length - 1].id });
    }
    for (const m of ms.slice(0, 10)) {
      if (m.author_id === ME) continue;
      await learnWallet(m).catch(() => null);
      if ((state.posts ?? 0) >= DAILY_CAP) break; // over today's budget: leave the rest for tomorrow's run
      // never the same mention twice, whatever a stale read says
      if (state.answered!.includes(m.id)) continue;
      // claim the mention before answering it: a crash after this skips one reply rather than doubling one
      state.since = m.id;
      state.answered = [...state.answered!, m.id].slice(-300);
      await saveState(state);
      const text = await answer(m).catch((e) => `couldn't do that: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
      if (text) {
        if (lastUrl(text)) await prewarm(lastUrl(text)!);
        await xPost(text, m.id);
        state.posts = (state.posts ?? 0) + 1;
        await saveState(state);
      }
      done.push(m.id);
    }
    const crowned = (state.posts ?? 0) < DAILY_CAP ? await crownWinners(state).catch((e) => (console.error("[warbot] crown", e), [])) : [];
    state.lockUntil = 0;
    await saveState(state);
    return res.json({ answered: done.length, since: state.since, crowned });
  } catch (e) {
    state.lockUntil = 0;
    await saveState(state).catch(() => null);
    return res.status(500).json({ error: e instanceof Error ? e.message : "bot failed", answered: done.length });
  }
}
