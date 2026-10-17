// AI-driven onboarding walkthrough of 100x.broker, recorded on a local mainnet fork (surfpool) so every click is a
// real transaction against the real programs with fork-only SOL. Burned-in subtitles explain each step; every
// confirmed transaction's signature is put on screen and written to receipts.md.
//
//   surfpool on :8899, app: DEV_RPC_UPSTREAM=http://127.0.0.1:8899 VITE_NETWORK=fork bun run dev (in app/)
//   bun rec.ts [scene,scene,...]   -> raw/*.webm + scenes.json + receipts.md ; then `bun cut.ts`
import fs from "node:fs";
import { chromium, type Locator, type Page } from "playwright-core";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const APP = process.env.APP ?? "http://localhost:5180";
const FORK = process.env.FORK ?? "http://127.0.0.1:8899";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1280, H = 800;

// ---- in-page overlay: subtitle bar, fork badge, visible cursor, click ripple, focus ring --------------------------
const OVERLAY = String.raw`
(() => {
  if (window.__wt) return;
  const css = document.createElement('style');
  css.textContent = ${"`"}
    #wt-root{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,Inter,Segoe UI,sans-serif}
    #wt-cap{position:absolute;left:50%;bottom:44px;transform:translateX(-50%);max-width:980px;width:calc(100% - 64px);background:rgba(10,10,12,.88);color:#f4f4f2;border-radius:14px;padding:14px 20px 16px;box-shadow:0 10px 40px rgba(0,0,0,.35);opacity:0;transition:opacity .25s}
    #wt-cap.on{opacity:1}
    #wt-cap b{display:block;font-size:20px;letter-spacing:-.01em;margin-bottom:4px}
    #wt-cap span{font-size:16px;line-height:1.45;color:#d8d8d2}
    #wt-cap code{font:13px ui-monospace,Menlo,monospace;background:rgba(255,255,255,.1);padding:1px 6px;border-radius:5px;color:#9ff0b8}
    #wt-step{position:absolute;bottom:10px;right:14px;font:600 12px ui-monospace,Menlo,monospace;color:#fff;background:rgba(10,10,12,.78);padding:6px 10px;border-radius:999px}
    #wt-fork{position:absolute;bottom:10px;left:14px;font:600 12px ui-monospace,Menlo,monospace;color:#0c1a13;background:#7cf29a;padding:6px 10px;border-radius:999px}
    #wt-cursor{position:absolute;width:22px;height:22px;margin:-4px 0 0 -4px;transition:left .6s cubic-bezier(.2,.7,.2,1),top .6s cubic-bezier(.2,.7,.2,1)}
    #wt-cursor svg{filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
    .wt-ripple{position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #ffcf3f;animation:wtr .6s ease-out forwards}
    @keyframes wtr{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}
    #wt-ring{position:absolute;border:3px solid #ffcf3f;border-radius:12px;box-shadow:0 0 0 9999px rgba(0,0,0,.18);transition:all .35s;opacity:0}
    #wt-ring.on{opacity:1}
  ${"`"};
  const root = document.createElement('div'); root.id = 'wt-root';
  root.innerHTML = '<div id="wt-ring"></div><div id="wt-fork">LOCAL MAINNET FORK · test SOL · real programs</div><div id="wt-step"></div>' +
    '<div id="wt-cap"><b></b><span></span></div>' +
    '<div id="wt-cursor"><svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 9-7 1.6L7.5 20z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg></div>';
  const mount = () => { (document.body || document.documentElement).appendChild(css); (document.body || document.documentElement).appendChild(root); };
  if (document.body) mount(); else addEventListener('DOMContentLoaded', mount);
  const $ = (s) => root.querySelector(s);
  const st = JSON.parse(sessionStorage.getItem('wt') || '{}');
  window.__wt = {
    say(title, body) { $('#wt-cap b').textContent = title; $('#wt-cap span').innerHTML = body || ''; $('#wt-cap').classList.toggle('on', !!(title || body)); st.t = title; st.b = body; sessionStorage.setItem('wt', JSON.stringify(st)); },
    step(s) { $('#wt-step').textContent = s || ''; st.s = s; sessionStorage.setItem('wt', JSON.stringify(st)); },
    cursor(x, y) { const c = $('#wt-cursor'); c.style.left = x + 'px'; c.style.top = y + 'px'; st.x = x; st.y = y; sessionStorage.setItem('wt', JSON.stringify(st)); },
    ripple(x, y) { const r = document.createElement('div'); r.className = 'wt-ripple'; r.style.left = x + 'px'; r.style.top = y + 'px'; root.appendChild(r); setTimeout(() => r.remove(), 700); },
    ring(r) { const g = $('#wt-ring'); if (!r) return g.classList.remove('on'); Object.assign(g.style, { left: (r.x - 6) + 'px', top: (r.y - 6) + 'px', width: (r.width + 12) + 'px', height: (r.height + 12) + 'px' }); g.classList.add('on'); },
  };
  const restore = () => { if (st.t || st.b) window.__wt.say(st.t, st.b); if (st.s) window.__wt.step(st.s); window.__wt.cursor(st.x ?? ${W / 2}, st.y ?? ${H / 2}); };
  if (document.body) restore(); else addEventListener('DOMContentLoaded', restore);
})();
`;

// ---- recorder ------------------------------------------------------------------------------------------------------
export type Ctx = Awaited<ReturnType<typeof start>>;

export async function start() {
  fs.mkdirSync("raw", { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--hide-scrollbars"] });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    colorScheme: "dark",
    recordVideo: { dir: "raw", size: { width: W, height: H } },
  });
  // production side effects stay off: the vanity mint stockpile, Vercel analytics
  await context.route("**/api/vanity**", (r) => r.abort());
  await context.route(/_vercel\/insights|va\.vercel-scripts\.com/, (r) => r.abort());
  await context.addInitScript(OVERLAY);
  // keep every transaction the site sends to the fork, to replay failures outside the browser
  fs.mkdirSync("captured", { recursive: true });
  let sent = 0;
  const sends: { t: number; sig: string; err: string }[] = [];
  await context.route("**/api/rpc", async (r) => {
    const body = r.request().postData() ?? "";
    if (!body.includes('"sendTransaction"')) return r.continue();
    fs.writeFileSync(`captured/send-${String(sent++).padStart(3, "0")}.json`, body);
    const resp = await r.fetch();
    const j = (await resp.json().catch(() => null)) as { result?: string; error?: { message?: string } } | null;
    sends.push({ t: Date.now(), sig: j?.result ?? "", err: j?.error?.message ?? "" });
    await r.fulfill({ response: resp, json: j });
  });
  const page = await context.newPage();
  const t0 = Date.now();
  const scenes: { id: string; title: string; start: number; end: number }[] = [];
  const receipts: { scene: string; label: string; sig: string; ok: boolean }[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("crash", () => console.log("PAGE CRASHED"));
  page.on("close", () => console.log("page closed"));
  browser.on("disconnected", () => console.log("browser disconnected"));
  return { browser, context, page, t0, scenes, receipts, errors, sends, lastClick: 0, sceneId: "" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Reading time for a caption: ~17 chars/s, at least 2.8 s. */
// FAST=1: dry runs that check the flow, not the pacing
const dwell = (t: string, b = "") => (process.env.FAST ? 250 : Math.max(2800, ((t + b).replace(/<[^>]+>/g, "").length / 17) * 1000));

export async function say(c: Ctx, title: string, body = "", extra = 0) {
  await c.page.evaluate(([t, b]) => (window as any).__wt?.say(t, b), [title, body]);
  await sleep(dwell(title, body) + extra);
}
export async function step(c: Ctx, s: string) {
  await c.page.evaluate((x) => (window as any).__wt?.step(x), s);
}
export async function point(c: Ctx, target: Locator, ring = true) {
  await target.scrollIntoViewIfNeeded().catch(() => {});
  // keep the target above the caption bar (bottom ~190px)
  const pre = await target.boundingBox();
  if (pre && pre.y + Math.min(pre.height, H * 0.5) > H - 190) {
    await c.page.evaluate((dy) => window.scrollBy({ top: dy, behavior: "smooth" }), pre.y + Math.min(pre.height, H * 0.5) - (H - 200));
    await sleep(500);
  }
  const box = await target.boundingBox();
  if (!box) return null;
  await c.page.evaluate(([x, y]) => (window as any).__wt?.cursor(x, y), [box.x + box.width / 2, box.y + box.height / 2]);
  if (ring) await c.page.evaluate((r) => (window as any).__wt?.ring(r), box);
  await sleep(700);
  return box;
}
export async function unring(c: Ctx) {
  await c.page.evaluate(() => (window as any).__wt?.ring(null));
}
/** Toasts already on screen belong to earlier actions: tag them so waitToast only reads what this click causes. */
async function markToasts(c: Ctx) {
  await c.page.evaluate(() => document.querySelectorAll<HTMLElement>(".toast").forEach((e) => (e.dataset.wtOld = "1")));
}
export async function click(c: Ctx, target: Locator) {
  const box = await point(c, target);
  if (box) await c.page.evaluate(([x, y]) => (window as any).__wt?.ripple(x, y), [box.x + box.width / 2, box.y + box.height / 2]);
  await markToasts(c);
  c.lastClick = Date.now();
  await target.click();
  await sleep(400);
  await unring(c);
}
export async function type(c: Ctx, target: Locator, text: string) {
  await click(c, target);
  await target.fill("");
  await target.pressSequentially(text, { delay: 90 });
  await sleep(500);
}

/** Wait for the next transaction toast (not the live tape's hype toasts) that settles after the last click; returns the
 *  signature from its "tx ↗" link. Each toast is consumed once, so a flow with several transactions calls this per tx. */
export async function waitToast(c: Ctx, label: string, timeout = 150_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const done = await c.page.evaluate(() => {
      const el = [...document.querySelectorAll<HTMLElement>(".toast:not(.hype)[data-s]")].find((e) => !e.dataset.wtOld && (e.dataset.s === "ok" || e.dataset.s === "err"));
      if (!el) return null;
      el.dataset.wtOld = "1";
      return { s: el.dataset.s, title: el.querySelector("b")?.textContent ?? "", body: el.querySelector(".muted")?.textContent ?? "", href: el.querySelector<HTMLAnchorElement>("a.addr")?.href ?? "" };
    });
    if (done) {
      const sig = done.href.match(/tx\/([1-9A-HJ-NP-Za-km-z]{64,90})/)?.[1] ?? "";
      c.receipts.push({ scene: c.sceneId, label: label || done.title, sig, ok: done.s === "ok" });
      if (done.s !== "ok") console.log(`toast failed: ${done.title}: ${done.body}`);
      return { ok: done.s === "ok", sig, body: done.body, title: done.title };
    }
    await sleep(500);
  }
  c.receipts.push({ scene: c.sceneId, label, sig: "", ok: false });
  return { ok: false, sig: "", body: "timed out", title: label };
}

export const shortSig = (s: string) => (s ? `${s.slice(0, 6)}…${s.slice(-6)}` : "");
export async function receipt(c: Ctx, label: string, r: { ok: boolean; sig: string; body: string }) {
  if (r.ok) await say(c, `✅ ${label}`, `Confirmed on the fork. Receipt: <code>${shortSig(r.sig)}</code>`);
  else await say(c, `⚠️ ${label} didn't go through`, r.body);
}

export async function scene(c: Ctx, id: string, title: string, fn: () => Promise<void>) {
  c.sceneId = id;
  const startT = (Date.now() - c.t0) / 1000;
  await step(c, title);
  try {
    await fn();
  } catch (e: any) {
    console.log(`scene ${id} error:`, e.message);
    c.errors.push(`${id}: ${e.message}`);
    await say(c, "Skipping ahead", `This step hit an error on the fork: ${String(e.message).slice(0, 140)}`).catch(() => {});
  }
  c.scenes.push({ id, title, start: startT, end: (Date.now() - c.t0) / 1000 });
}

// ---- fork helpers --------------------------------------------------------------------------------------------------
export async function rpc(method: string, params: unknown[]) {
  const r = await fetch(FORK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await r.json()) as any).result;
}
export async function burnerAddress(c: Ctx) {
  const secret = await c.page.evaluate(() => localStorage.getItem("burner:v1"));
  if (!secret) throw new Error("no burner key in localStorage yet");
  return Keypair.fromSecretKey(bs58.decode(secret)).publicKey.toBase58();
}
/** Fork cheatcode: set the burner's SOL balance. Only exists on surfpool; on mainnet you'd send SOL. */
export async function fundBurner(address: string, sol: number) {
  await rpc("surfnet_setAccount", [address, { lamports: Math.round(sol * 1e9) }]);
}

export async function finish(c: Ctx) {
  await say(c, "", "");
  const video = c.page.video();
  const runEnd = (Date.now() - c.t0) / 1000; // the recording's timeline drifts from wall clock; cut.ts rescales by this
  await c.context.close();
  await c.browser.close();
  const path = await video?.path();
  fs.writeFileSync("scenes.json", JSON.stringify({ video: path, runEnd, scenes: c.scenes, errors: c.errors }, null, 2));
  const lines = ["# 100x.broker walkthrough receipts (local mainnet fork)", "", "| scene | action | result | signature |", "|---|---|---|---|"];
  for (const r of c.receipts) lines.push(`| ${r.scene} | ${r.label} | ${r.ok ? "ok" : "failed"} | \`${r.sig}\` |`);
  fs.writeFileSync("receipts.md", lines.join("\n") + "\n");
  console.log(`video ${path}\nscenes ${c.scenes.map((s) => `${s.id} ${s.start.toFixed(1)}-${s.end.toFixed(1)}s`).join(", ")}\nreceipts ${c.receipts.length}, errors ${c.errors.length}`);
  for (const e of c.errors) console.log("  error:", e);
}
