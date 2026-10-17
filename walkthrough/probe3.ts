// Capture the signed transactions /swap sends to the fork (sendTransaction bodies) into captured/, for replaying.
import { chromium } from "playwright-core";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";
fs.mkdirSync("captured", { recursive: true });
const kp = Keypair.generate();
await fetch("http://127.0.0.1:8899", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "surfnet_setAccount", params: [kp.publicKey.toBase58(), { lamports: 5e9 }] }) });
fs.writeFileSync("captured/burner.txt", kp.publicKey.toBase58());
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
await ctx.route("**/api/vanity**", (r) => r.abort());
let n = 0;
await ctx.route("**/api/rpc", async (r) => {
  const body = r.request().postData() ?? "";
  if (body.includes('"sendTransaction"')) { fs.writeFileSync(`captured/tx${n++}.json`, body); console.log("captured send", n); }
  await r.continue();
});
await ctx.addInitScript((s) => { if (!localStorage.getItem("burner:v1")) localStorage.setItem("burner:v1", s); }, bs58.encode(kp.secretKey));
const page = await ctx.newPage();
await page.goto("http://localhost:5180/swap", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(3000);
await page.locator("button", { hasText: "A throwaway wallet" }).first().click(); await page.waitForTimeout(2500);
await page.locator("button", { hasText: /start aping/i }).first().click().catch(() => {}); await page.waitForTimeout(2000);
const pay = page.getByLabel("You pay");
await pay.fill("0.1");
for (let i = 0; i < 120 && !(await page.locator("button.swap-go").isEnabled()); i++) {
  await page.waitForTimeout(1000);
  if (i % 30 === 29) { await pay.fill(""); await pay.fill("0.1"); }
}
console.log("enabled:", await page.locator("button.swap-go").isEnabled(), await page.locator(".swap-err").allInnerTexts());
await page.locator("button.swap-go").click();
for (let i = 0; i < 90 && n < 1; i++) await page.waitForTimeout(1000);
await page.waitForTimeout(15000);
console.log("rows:", await page.locator("ol.swap-status li").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-s")} ${e.textContent?.replace(/\s+/g, " ").slice(0, 200)}`)));
await b.close();
