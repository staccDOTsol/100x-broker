// The walkthrough script: one scene per user story, in the order a new user meets them.
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { burnerAddress, click, finish, fundBurner, point, receipt, say, scene, shortSig, start, type, unring, waitToast, type Ctx } from "./rec";

const APP = process.env.APP ?? "http://localhost:5180";
const only = (process.argv[2] ?? "").split(",").filter(Boolean);
const want = (id: string) => !only.length || only.includes(id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for /swap's transaction list to settle; push each row as a receipt. */
async function swapRows(c: Ctx, label: string) {
  const end = Date.now() + 150_000;
  while (Date.now() < end) {
    const busy = await c.page.locator("button.swap-go", { hasText: "Signing" }).count();
    const rows = await c.page.locator("ol.swap-status li").evaluateAll((els) =>
      els.map((e) => ({ s: e.getAttribute("data-s"), label: e.querySelector("span")?.childNodes[0]?.textContent ?? "", err: e.querySelector("small")?.textContent ?? "", sig: (e.querySelector("a") as HTMLAnchorElement | null)?.href.split("/tx/")[1] ?? "" })),
    );
    if (!busy && rows.length && rows.every((r) => ["ok", "failed", "skipped"].includes(r.s ?? ""))) {
      for (const r of rows) c.receipts.push({ scene: c.sceneId, label: `${label}: ${r.label}`, sig: r.sig, ok: r.s === "ok" });
      return rows;
    }
    await sleep(600);
  }
  return [];
}

/** Type an amount into /swap and wait for the quote that typing asked for (the field starts at 0.1, so the button can be
 *  enabled by the page-load quote while ours is still in flight). The router's quote carries the 100× legs from
 *  100x.broker/api/legs; when that call times out the quote comes back with legs.error and the page holds the swap without
 *  re-quoting, so nudge the amount and ask again. */
async function quoteFor(c: Ctx, amount: string, typed = true) {
  const pay = c.page.getByLabel("You pay");
  for (let tries = 0; tries < 5; tries++) {
    const resp = c.page.waitForResponse((r) => r.url().includes("/api/quote/solana"), { timeout: 90_000 }).catch(() => null);
    if (tries === 0 && typed) await type(c, pay, amount);
    else {
      await pay.fill(amount + "0"); // a different string with the same value re-runs the quote
      await sleep(100);
      await pay.fill(amount);
    }
    await resp;
    await sleep(800);
    const held = await c.page.locator(".swap-err", { hasText: "legs unavailable" }).count();
    if (!held && (await c.page.locator("button.swap-go").isEnabled())) return true;
    console.log(`quote not ready (try ${tries + 1}):`, await c.page.locator(".swap-err").allTextContents());
  }
  return false;
}

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Ask the router for the quote once off-camera: its /api/legs call is slow when cold, and a cold one times out on screen. */
async function warmQuote(input: string, output: string, raw: bigint) {
  const q = new URLSearchParams({ inputMint: input, outputMint: output, amount: String(raw), slippageBps: "50", swapMode: "ExactIn" });
  for (let i = 0; i < 3; i++) {
    const j = (await fetch(`https://api.liquidityxyz.fun/api/quote/solana?${q}`, { signal: AbortSignal.timeout(80_000) }).then((r) => r.json()).catch(() => null)) as { legs?: { error?: string } } | null;
    if (j?.legs && !j.legs.error) return;
  }
}

const MARKET = "GwzRwcPYSojZiNc4tC4eoLSLD7htk3akWA7qtG68zyHh"; // $PUMP / SOL
const PUMP_UP = "GM28U8MfmnrphuXzAdZwYHVjpBzGskWFbj4MGnqiksTi"; // its UP coin, which has a live SPL twin

/** Open a page (full load: the burner reconnects from localStorage) and make sure the burner is connected. */
async function open(c: Ctx, path: string, settle = 3500) {
  await c.page.goto(`${APP}${path}`, { waitUntil: "domcontentloaded" });
  await sleep(1500);
  const modal = c.page.locator("button", { hasText: "A throwaway wallet" }).first();
  if (await modal.isVisible().catch(() => false)) {
    await modal.click();
    await sleep(1200);
  } else if (await c.page.locator("button", { hasText: /^try with a burner$/i }).first().isVisible().catch(() => false)) {
    await c.page.locator("button", { hasText: /^try with a burner$/i }).first().click();
    await sleep(1200);
    await c.page.locator("button", { hasText: "A throwaway wallet" }).first().click({ timeout: 3000 }).catch(() => {});
    await sleep(1200);
  }
  await c.page.locator("button", { hasText: /start aping/i }).first().click({ timeout: 1500 }).catch(() => {});
  await c.page.keyboard.press("Escape");
  await sleep(settle);
}

/** Wait for a step list (vault park/unpark, listing) to finish; returns its rows. */
async function stepList(c: Ctx, rows: string, label: string, timeout = 240_000) {
  const end = Date.now() + timeout;
  let last: { s: string; label: string; sig: string; err: string }[] = [];
  while (Date.now() < end) {
    last = await c.page.locator(rows).evaluateAll((els) =>
      els.map((e) => ({
        s: e.getAttribute("data-s") ?? (["done", "failed", "sending", "signing"].find((k) => e.classList.contains(k)) ?? "idle"),
        label: ((el) => { el.querySelectorAll(".sr-only, .glyph, a, .err").forEach((x) => x.remove()); return el.textContent ?? ""; })(e.cloneNode(true) as Element).replace(/\s+/g, " ").trim().slice(0, 80),
        sig: (e.querySelector("a") as HTMLAnchorElement | null)?.href.split("/tx/")[1]?.split("?")[0] ?? "",
        err: e.querySelector(".err")?.textContent ?? "",
      })),
    );
    if (last.length && (last.every((r) => r.s === "done") || last.some((r) => r.s === "failed"))) break;
    await sleep(700);
  }
  // rows without a tx link (the listing's) take the signatures the fork returned since the click, in order
  const sigs = c.sends.filter((x) => x.t >= c.lastClick && x.sig).map((x) => x.sig);
  if (last.every((r) => !r.sig) && sigs.length >= last.filter((r) => r.s === "done").length) last.forEach((r, i) => r.s === "done" && (r.sig = sigs[i] ?? ""));
  for (const r of last) c.receipts.push({ scene: c.sceneId, label: `${label}: ${r.label}`, sig: r.sig, ok: r.s === "done" });
  return last;
}

const c = await start();
const { page } = c;
// The site reads a wallet's balance once when it connects, so fund the burner on the fork first, then hand the
// browser that key: "Try with a burner" reuses a key that's already in localStorage.
const burner = Keypair.generate();
await fundBurner(burner.publicKey.toBase58(), 5);
await c.context.addInitScript((secret) => { if (!localStorage.getItem("burner:v1")) localStorage.setItem("burner:v1", secret); }, bs58.encode(burner.secretKey));

if (want("swap")) await scene(c, "swap", "1 · Swap", async () => {
  await page.goto(`${APP}/swap`, { waitUntil: "domcontentloaded" });
  await sleep(3500);
  await say(c, "Welcome to 100x.broker", "A swap that also buys you a tiny 100× bet on the side. First visit, so the site asks how you want to connect.");
  const burnerCard = page.locator("button", { hasText: "A throwaway wallet" }).first();
  await point(c, burnerCard);
  await say(c, "Option 1: a burner wallet", "A throwaway key that lives only in this browser. No extension, no seed phrase, nothing to lose but what you put in.");
  await click(c, burnerCard);
  await sleep(1500);
  const addr = await burnerAddress(c);
  const lfg = page.locator("button", { hasText: /start aping/i }).first();
  if (await lfg.isVisible().catch(() => false)) {
    await say(c, "Saddle up. You're in.", `A burner, <code>${addr.slice(0, 4)}…${addr.slice(-4)}</code>, living in this browser. The key never leaves it.`);
    await point(c, page.locator("text=/\\d\\.\\d{3} SOL/").first());
    await say(c, "Fund it like a casino chip", "On mainnet you'd send it a few bucks. On this fork it holds 5 test SOL, so every button from here on does a real transaction.");
    await click(c, lfg);
    await sleep(1200);
    await page.keyboard.press("Escape"); // "Start aping" leaves the burner's funding panel open in the header
    await sleep(500);
  } else {
    await say(c, `Burner connected: ${addr.slice(0, 4)}…${addr.slice(-4)}`, "On mainnet you'd send it a few bucks. On this fork it holds 5 test SOL, so every button from here on does a real transaction.");
  }

  const pay = page.getByLabel("You pay");
  await point(c, pay);
  await say(c, "Pick what you pay and what you get", "Here: 0.25 SOL into USDC. The quote comes from the best route on Solana, like any aggregator.");
  await warmQuote(SOL, USDC, 250_000_000n);
  if (!(await quoteFor(c, "0.25"))) throw new Error("the quote never came back with its 100× legs");
  const legs = page.locator(".swap-legs");
  if (await legs.count()) {
    await point(c, legs);
    await say(c, "The twist: 100× legs", "10 bp of every hop buys a stupid 100× bet on that hop's coin, up or down. The house keeps 1 bp. No liquidations: the most a bet can lose is what went into it.");
    await unring(c);
  }
  const fee = page.locator(".swap-fee");
  if (await fee.count()) {
    await point(c, fee);
    await say(c, "Every fee is spelled out", "What the route costs, what goes to the house, what goes into the bets, before you sign anything.");
    await unring(c);
  }
  const go = page.locator("button.swap-go");
  await say(c, "Swap", "One click. The burner signs on its own, so watch the transaction list fill in underneath.");
  await click(c, go);
  // the router's build endpoint rate-limits bursts; the page shows the error and waits for another click
  for (let tries = 0; tries < 6; tries++) {
    const end = Date.now() + 10_000;
    let limited = false;
    while (Date.now() < end && !(await page.locator("ol.swap-status li").count())) {
      if (await page.locator(".swap-err", { hasText: /rate-limited|retry in a moment/i }).count()) { limited = true; break; }
      await sleep(400);
    }
    if (!limited) break;
    console.log(`router rate-limited (try ${tries + 1})`);
    await sleep(20_000);
    await click(c, go);
  }
  const rows = await swapRows(c, "swap 0.25 SOL → USDC");
  const ok = rows.filter((r) => r.s === "ok");
  await point(c, page.locator("ol.swap-status"));
  await say(c, `${ok.length} of ${rows.length} transactions confirmed`, rows.map((r) => `${r.s === "ok" ? "✓" : "✕"} ${r.label}${r.sig ? ` <code>${shortSig(r.sig)}</code>` : ""}`).join("<br>"), 1500);
  await unring(c);
});


if (want("board")) await scene(c, "board", "2 · The board", async () => {
  await open(c, "/");
  await say(c, "The board", "Every market on 100x.broker is a coin, a 66-minute price window, and two pots. UP wins if it pumps, DOWN if it dumps.");
  await point(c, page.locator(".display").first());
  await say(c, "The best payout on the board", "The headline is the biggest multiple right now: what the emptier side pays if it's right. No liquidations, ever: the most you can lose is your stake.");
  await unring(c);
  const tape = page.locator('[aria-label="Live activity"]').first();
  if (await tape.count()) {
    await point(c, tape);
    await say(c, "The live tape", "Every ape, cash-out, payout and burn, as it lands on chain.");
    await unring(c);
  }
  const card = page.locator(`a[href^="/m/${MARKET}"]`).last();
  await point(c, card);
  await say(c, "Every board", "Each card shows the price, how the two pots are split, and what UP and DOWN pay. Let's open $PUMP.");
  await click(c, card);
  await sleep(3000);
});

if (want("market")) await scene(c, "market", "3 · Ape a side", async () => {
  if (!page.url().includes(`/m/${MARKET}`)) await open(c, `/m/${MARKET}`);
  const upLev = (await page.locator("button.side.u b.num").innerText().catch(() => "")).trim();
  const dnLev = (await page.locator("button.side.d b.num").innerText().catch(() => "")).trim();
  await point(c, page.locator(".sides"));
  await say(c, "Two sides, two pots", `Right now UP pays ${upLev} and DOWN pays ${dnLev}. The emptier side pays more, because when the window closes the right side takes the wrong side's pot.`);
  await click(c, page.locator("button.side.u"));
  await click(c, page.getByRole("tab", { name: "Ape" }));
  await click(c, page.locator("section.ticket button.chip", { hasText: "0.05 SOL" }));
  await sleep(2500);
  await point(c, page.locator("section.ticket .quote"));
  await say(c, "Ape UP with 0.05 SOL", "You buy UP tokens off a bonding curve. The ticket shows what you get, the fees, and what a right call pays out.");
  await unring(c);
  await click(c, page.locator("section.ticket button.lfg"));
  await receipt(c, "Aped UP $PUMP", await waitToast(c, "ape UP $PUMP 0.05 SOL"));
  await sleep(2500);

  await click(c, page.getByRole("tab", { name: "Sell" }));
  await click(c, page.locator("section.ticket button.chip", { hasText: "50%" }));
  await sleep(2500);
  await point(c, page.locator("section.ticket .quote"));
  await say(c, "Changed your mind? Sell any time", "Half back out. The ticket sells into the curve or the pot, whichever pays more.");
  await unring(c);
  await click(c, page.locator("section.ticket button.lfg"));
  await receipt(c, "Sold half", await waitToast(c, "sell 50% UP $PUMP"));
});

if (want("bag")) await scene(c, "bag", "4 · Your bag", async () => {
  await open(c, "/me", 6000);
  await say(c, "Your bag", "Everything this wallet holds on 100x.broker: each bet, what it's worth now, and your P&L.");
  const stats = page.locator(".bag-stats");
  if (await stats.count()) {
    await point(c, stats);
    await say(c, "Realized, unrealized, per year", "Profit you've banked, profit on paper, and the annualized rate.");
    await unring(c);
  }
  const pos = page.locator(".pos-foot").first();
  if (await pos.count()) {
    await point(c, pos);
    await say(c, "Exit or cash out from here", "Exit sells the bet back to SOL. Cash out redeems your slice of the pot. Copy link shares the bag, and the referral link credits you for anyone who comes in through it.");
    await unring(c);
  }
});

if (want("wrap")) await scene(c, "wrap", "5 · Wrap to SPL", async () => {
  await open(c, `/wrap/${PUMP_UP}`, 5000);
  await say(c, "Wrap: take your bet anywhere", "100x coins carry a transfer hook, so Jupiter and most venues won't touch them. Wrapping turns them into a plain SPL twin, 1:1, that any router can trade.");
  await point(c, page.locator(".wrapx-card"));
  await say(c, "Fully backed, immutable program", "Your coins sit in the SPL Token Wrap program's escrow; only an unwrap moves them. The card shows the backing live.");
  await unring(c);
  await click(c, page.locator(".wrapx-card button", { hasText: "max" }));
  await click(c, page.locator(".wrapx-card button.big"));
  await receipt(c, "Wrapped PUMPUP to its SPL twin", await waitToast(c, "wrap PUMPUP → SPL twin"));
  await sleep(2000);
  await click(c, page.locator(".wrapx-tabs button", { hasText: "Unwrap" }));
  await click(c, page.locator(".wrapx-card button", { hasText: "max" }));
  await say(c, "And back", "Unwrap returns the exact same coin, still a live 100× bet.");
  await click(c, page.locator(".wrapx-card button.big"));
  await receipt(c, "Unwrapped back to PUMPUP", await waitToast(c, "unwrap twin → PUMPUP"));
});

if (want("yield")) await scene(c, "yield", "6 · Park SOL for yield", async () => {
  await open(c, "/yield", 5000);
  await say(c, "Yield: park SOL, stay hedged", "Each vault splits your SOL: half becomes the coin and goes into its pool, half is shorted with the market's DOWN. Price can go anywhere; you keep the fees.");
  const card = page.locator("section.vault-tile", { hasText: "$PUMP" }).first();
  await point(c, card.locator(".tile-nums"));
  const apy = (await card.locator(".tile-num strong").nth(1).innerText({ timeout: 3000 }).catch(() => "")).trim();
  await say(c, "The $PUMP vault", `Projected ${apy || "APY"} from pool fees, with the coin's price risk hedged by its own DOWN side.`);
  await unring(c);
  await type(c, card.getByPlaceholder("0.0"), "0.2");
  const park = card.locator("button.btn.big", { hasText: /Park & deploy/ });
  await point(c, park);
  await say(c, "Park & deploy", "One click. You get vault receipts right away; the keeper deploys the SOL into the pool and the hedge on its next pass.");
  await click(c, park);
  const rows = await stepList(c, ".vault-cards ol.zap-steps li", "park 0.2 SOL in $PUMP vault");
  await point(c, card.locator("ol.zap-steps"));
  await say(c, rows.every((r) => r.s === "done") ? "Parked" : "Park hit a snag", rows.map((r) => `${r.s === "done" ? "✓" : r.s === "failed" ? "✕" : "·"} ${r.label}${r.sig ? ` <code>${shortSig(r.sig)}</code>` : ""}${r.err ? ` (${r.err.slice(0, 80)})` : ""}`).join("<br>"), 800);
  await unring(c);
  await sleep(3000);
  await click(c, card.getByRole("tab", { name: "Unpark" }).or(card.locator("button", { hasText: /^Unpark$/ })).first());
  await click(c, card.locator("button.chip", { hasText: "100%" }));
  const unpark = card.locator("button.btn.big", { hasText: /Unpark/ });
  await point(c, unpark);
  await say(c, "Unpark any time", "Your receipts come back out and everything is turned back into SOL.");
  await click(c, unpark);
  const back = await stepList(c, ".vault-cards ol.zap-steps li", "unpark 100% of $PUMP vault");
  await point(c, card.locator("ol.zap-steps"));
  await say(c, back.every((r) => r.s === "done") ? "Unparked" : "Unpark hit a snag", back.map((r) => `${r.s === "done" ? "✓" : r.s === "failed" ? "✕" : "·"} ${r.label}${r.sig ? ` <code>${shortSig(r.sig)}</code>` : ""}${r.err ? ` (${r.err.slice(0, 80)})` : ""}`).join("<br>"), 800);
  await unring(c);
});

if (want("swapbag")) await scene(c, "swapbag", "7 · Sell the swap's bets", async () => {
  await open(c, "/bag", 6000);
  await say(c, "The swap bag", "Every swap left two tiny 100× bets in this wallet. This is where they live.");
  await page.locator("ul.sbag-list li").first().waitFor({ timeout: 20_000 }).catch(() => {});
  const fromSwap = page.locator("ul.sbag-list li", { hasText: "USD Coin" }).first();
  const row = (await fromSwap.count()) ? fromSwap : page.locator("ul.sbag-list li").first();
  if (!(await row.count())) return say(c, "No bets to sell", "This wallet's swap bets have already been sold.");
  const bet = `${(await row.locator("span").first().innerText()).trim()} ${(await row.locator(".sbag-name b").innerText()).trim()}`;
  const sell = row.locator("button", { hasText: "Sell" });
  await point(c, page.locator("ul.sbag-list"));
  await say(c, "What they're worth now", "Each bet's value in SOL and its P&L, live. One tap sells it, without the main board's 0/20 cut.");
  await unring(c);
  await click(c, sell);
  await receipt(c, `Sold ${bet}`, await waitToast(c, `sell ${bet} from the swap bag`));
});

if (want("list")) await scene(c, "list", "8 · List any coin", async () => {
  await open(c, "/new", 5000);
  await say(c, "List any coin", "Any coin with a Raydium pool can get its own UP/DOWN market. Pick it, pick an oracle pool and a window, sign once.");
  let name = "$BONK";
  await type(c, page.locator("#ca"), "bonk");
  const hit = page.locator(".tsearch-row").first();
  if (await hit.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false)) {
    await point(c, hit);
    await say(c, "Search by name", "Type a name or ticker, or paste a contract address or pool.");
    await click(c, hit);
  } else {
    const pick = page.locator("button.pick").first();
    name = (await pick.innerText()).split("\n")[0].split(/[−+0-9]/)[0].trim();
    await click(c, pick);
  }
  await sleep(3000);
  const oracle = page.locator('[aria-label="Oracle pool"]');
  await oracle.locator("button:enabled").first().waitFor({ timeout: 30_000 }).catch(() => {});
  await point(c, oracle);
  await say(c, "Pick the oracle pool", "Prices come from the pool's own stored observations, so no single trade can flash-move the market. Only deep, active pools qualify.");
  await unring(c);
  await click(c, oracle.locator("button:enabled").first());
  await click(c, page.locator("button.chip", { hasText: "66 min" }));
  const go = page.locator("form button.lfg, button.lfg[type=submit]").first();
  await point(c, go);
  await say(c, `List ${name}`, "Four transactions, one approval. Whoever lists it pays the rent and earns from its trades.");
  if (!(await go.isEnabled())) return say(c, "Already listed", `${name} has a market, so there's nothing to list.`);
  await click(c, go);
  const rows = await stepList(c, "ol.nm-progress li", `list ${name}`);
  await point(c, page.locator("ol.nm-progress"));
  await say(c, rows.every((r) => r.s === "done") ? `${name} is live` : `Listing stopped`, rows.map((r) => `${r.s === "done" ? "✓" : r.s === "failed" ? "✕" : "·"} ${r.label}${r.sig ? ` <code>${shortSig(r.sig)}</code>` : ""}`).join("<br>"));
  await unring(c);
});

if (want("spicy")) await scene(c, "spicy", "9 · Spicy, arena, leaderboard", async () => {
  await open(c, "/meta", 4000);
  await say(c, "Spicy", "The most lopsided markets right now: where one side pays the most if it's right.");
  await open(c, "/arena", 4000);
  await say(c, "Arena", "Wallets ranked head to head.");
  await open(c, "/winners", 4000);
  await say(c, "Leaderboard and the 24h race", "Biggest P&L, best multiples and top referrers, by day, week, month or all-time. The daily race pays the top three in SOL.");
  await say(c, "That's 100x.broker", "Swap, ape, sell, wrap, park, list. Every transaction in this video landed on a local fork of mainnet, running the real programs.");
});

await finish(c);
