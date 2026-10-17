// Serves the SPA shell for /m/:key with per-market Open Graph tags so links unfurl into cards.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { PublicKey } from "@solana/web3.js";
import { readMarketCard, usd } from "./_lib/og.js";
import { META } from "../src/meta.js";
import { readView, FEATURED, amountText, playTarget, payoffText } from "./war.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "100x.broker");
  const origin = `https://${host}`;
  // the static shell itself: "/" on lastbidwins.fun redirects to a /w page, which would bring us right back here
  const shell = await (await fetch(`${origin}/index.html`, { headers: { "x-og-shell": "1" } })).text();
  let title = "100x.broker — up or down";
  let desc = "±100× power-leverage pairs on any token. Pick a side.";
  let image = `${origin}/api/og`;
  // canonical URL: the public path without the rewrite's own params (key/owner/wallet)
  const u = new URL(req.url ?? "/", origin);
  for (const k of ["key", "owner", "wallet", "vault", "meta", "war", "id"]) u.searchParams.delete(k); // keep ref + s: X keys its cache on this URL
  const url = u.toString();
  const ref = typeof req.query.ref === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(req.query.ref) ? req.query.ref : null;
  const via = ref ? ` Shared by ${ref.slice(0, 4)}…${ref.slice(-4)}.` : "";
  try {
    if (req.query.war !== undefined) {
      // /w/:id (and the bare lastbidwins.fun) — a Stars War game; the image URL carries scenario + state so X re-fetches it
      // /a?op=bid&g=<id>… (an action link) unfurls as its game's card too
      const isNew = req.query.war === "new" || req.query.war === "action" && req.query.op === "start";
      const isPlay = req.query.war === "action" && req.query.op === "play";
      const raw = isNew ? "new" : isPlay ? "play" : req.query.war === "action" ? String(req.query.g ?? "featured") : String(req.query.war);
      const t = raw === "play" ? await playTarget(typeof req.query.mint === "string" ? req.query.mint : null) : null;
      const id = t ? t.id : raw === "featured" || raw === "" ? FEATURED : Number(raw);
      const out = id >= 0 ? await readView(id) : null;
      if (isNew) {
        const mint = typeof req.query.mint === "string" ? req.query.mint : "SOL";
        const quote = /^sol$/i.test(mint) ? "SOL" : `${mint.slice(0, 4)}…${mint.slice(-4)}`;
        title = `New ${quote} game — last bid wins`;
        desc = `Create a fresh game and choose its minimum bid in token units, with full decimal precision. Preview the total and rules before signing. The clock starts on bid two.${via}`;
        image = `${origin}/api/og?war=featured&sc=open&v=new-${mint}`;
      } else if (t?.action === "start") {
        // no war on this token yet: the link opens one, and the opener is its creator
        title = `Open the first war on ${t.mint ? `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}` : "SOL"} — last bid wins`;
        desc = `Tap, sign, and you open it with about $1: you hold the first key and take 15% of its pot when it ends. Every later bid pays the keys before it.${via}`;
        image = `${origin}/api/og?war=featured&sc=open&v=new-${t.mint ?? "sol"}`;
      }
      if (out) {
        const v = out.v;
        const sym = v.asset.symbol;
        const sc = typeof req.query.sc === "string" && /^(live|lead|won|divs|open)$/.test(req.query.sc) ? req.query.sc : "live";
        const by = ref ?? (typeof req.query.by === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(req.query.by) ? req.query.by : null);
        const who = by ? `${by.slice(0, 4)}…${by.slice(-4)}` : "";
        title = sc === "lead" && who ? `${who} took the lead in war #${id} — $${sym}`
          : v.phase === "open" ? `war #${id} is open — $${sym} pot, waiting for a challenger`
          : v.phase === "expired" || v.phase === "settled" ? `war #${id} is over — last bid took ${amountText(v.winnerTakes, sym)}`
          : `war #${id} — ${v.minNext.usd !== null && v.payoff.win.usd !== null ? `$${v.minNext.usd.toFixed(2)} to win $${v.payoff.win.usd.toFixed(2)} (${v.payoff.multiple.toFixed(1)}×)` : `pot ${amountText(v.pot, sym)}`}, ${Math.ceil((v.secondsLeft ?? 0) / 60)} min left`;
        desc = `${payoffText(v, sym)[0].toUpperCase()}${payoffText(v, sym).slice(1)}. Every bid mints a key that earns off every bid after it. Last bid when the clock dies takes ${v.pct.winner / 100}% of the pot.${via}`;
        image = `${origin}/api/og?war=${id}&sc=${sc}${by ? `&by=${by}` : ""}&v=${v.tag}`;
      }
    } else if (req.query.meta) {
      // /meta — the curated list; the card is live, so stamp a 5-minute bucket to get past X's image cache
      title = "What's spicy right now — 100x.broker";
      desc = `You long it? Long it. Short? Short it. Don't want to be long or short but think it's gonna be a wild ride? Park it. ${META.filter((p) => p.market).map((p) => `$${p.ticker} ${p.side === "VAULT" ? "vault" : p.side}`).join(" · ")}.${via}`;
      image = `${origin}/api/og?meta=1&s=${Math.floor(Date.now() / 300_000)}`;
    } else if (req.query.vault) {
      // /yield/:vault — a delta-neutral vault
      const vault = new PublicKey(String(req.query.vault)).toBase58();
      title = "99.99% risk-free money — a delta-neutral vault";
      desc = `Park SOL, we LP it against the coin on Raydium and hedge the coin with −100× DOWN. What's left is pool fees. Receipt ${vault.slice(0, 4)}…${vault.slice(-4)} just gets heavier.${via}`;
      image = `${origin}/api/og?v=${vault}${ref ? `&ref=${ref}` : ""}`;
    } else if (req.query.owner) {
      // /p/:wallet — a bag
      const owner = new PublicKey(String(req.query.owner)).toBase58();
      const shortK = `${owner.slice(0, 4)}…${owner.slice(-4)}`;
      title = `${shortK}'s 100× bag`;
      desc = `Every side ${shortK} is on at ±100×, what it's worth at the curve and at the pot. No liquidations. Somebody's paying them.${via}`;
      image = `${origin}/api/og?owner=${owner}`;
    } else {
      const key = new PublicKey(String(req.query.key));
      const m = await readMarketCard(key, false);
      const side = req.query.side === "1" ? 1 : req.query.side === "0" ? 0 : null;
      const [up, dn] = m.sides;
      title = `$${m.ticker} ±100× — up or down`;
      desc = `UP ${usd(up.priceUsd)} (${Number.isFinite(up.leverage) ? up.leverage.toFixed(0) : "∞"}× payout) · DOWN ${usd(dn.priceUsd)} (${Number.isFinite(dn.leverage) ? dn.leverage.toFixed(0) : "∞"}× payout) · oracle ${usd(m.oracleUsd)}. No liquidations. Settles on every transfer.${via}`;
      image = `${origin}/api/og?m=${key.toBase58()}${side !== null && req.query.ref ? `&side=${side}&owner=${req.query.ref}` : ""}`;
    }
  } catch {
    /* unknown market: generic tags */
  }
  const tags = `
<meta property="og:type" content="website" />
<meta property="og:site_name" content="100x.broker" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${esc(url)}" />
<meta property="og:image" content="${esc(image)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(desc)}" />
<meta name="twitter:image" content="${esc(image)}" />`;
  const html = shell.replace(/<title>.*?<\/title>/, `<title>${esc(title)}</title>`).replace("</head>", `${tags}\n</head>`);
  // never cacheable across deploys: a stale shell points at asset hashes that no longer exist
  // war pages are what X's crawler reads: let the edge hold them briefly so a warmed link answers instantly
  const edge = req.query.war !== undefined ? "public, max-age=0, s-maxage=20, stale-while-revalidate=60" : "public, max-age=0, must-revalidate";
  res.setHeader("content-type", "text/html; charset=utf-8").setHeader("cache-control", edge).send(html);
}
