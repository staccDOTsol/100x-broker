// Every wallet's up/down P&L across every market, all time. Realized from the feed (buys/sells/cash-outs), unrealized from
// current holdings at the better of curve and pot. Units r-fstacc → USD via the market card's navUsd/nav. Run: bun tools/pnl-all.ts
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { allMarkets, marketCtx, classify, botAddresses, type Ev } from "../api/_lib/feed.js";
import { basisFor, positionPnl } from "../api/_lib/pnl.js";
import { readMarketCard } from "../api/_lib/og.js";
import { Connection } from "@solana/web3.js";
const c = new Connection(process.env.HISTORY_RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function parsedBatch(sigs: string[]) {
  if (process.env.SEQ) {
    const out: (ParsedTransactionWithMeta | null)[] = [];
    for (const sig of sigs) {
      for (let attempt = 0; ; attempt++) {
        try { out.push(await c.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 })); break; }
        catch (e) { if (attempt > 8) throw e; await sleep(2000 * (attempt + 1)); }
      }
      await sleep(Number(process.env.SEQ_MS ?? 280));
    }
    return out;
  }
  for (let attempt = 0; ; attempt++) {
    try { return await c.getParsedTransactions(sigs, { maxSupportedTransactionVersion: 0 }); }
    catch (e) { if (attempt > 6) throw e; await sleep(1500 * (attempt + 1)); }
  }
}
const HOUSE = "331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth";
const pk = (d: Uint8Array, o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();
const markets = await allMarkets();
const bots = await botAddresses();
let rate: number | null = null;
type Row = { cost: number; realized: number; unrealized: number; positions: number; open: number };
const wallets = new Map<string, Row>();
const row = (w: string) => wallets.get(w) ?? (wallets.set(w, { cost: 0, realized: 0, unrealized: 0, positions: 0, open: 0 }), wallets.get(w)!);
let totalTx = 0, totalEv = 0;
for (const m of markets) {
  const ctx = await marketCtx(m);
  const card = await readMarketCard(m, false);
  const sigs: string[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await c.getSignaturesForAddress(m, { limit: 1000, before });
    for (const s of page) if (!s.err) sigs.push(s.signature);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  const txs: (ParsedTransactionWithMeta | null)[] = [];
  for (let i = 0; i < sigs.length; i += 10) { txs.push(...(await parsedBatch(sigs.slice(i, i + 10)))); if (!process.env.SEQ) await sleep(250); }
  const evs = txs.map((t) => (t ? classify(t, ctx) : null)).filter((e): e is Ev => !!e);
  totalTx += sigs.length; totalEv += evs.length;
  const actors = new Set(evs.filter((e) => e.kind === "buy" || e.kind === "sell" || e.kind === "redeem").map((e) => e.actor));
  for (const side of [0, 1] as const) {
    const s: any = card.sides[side];
    if (rate === null && s.navUsd && s.circulating > 0n && s.vaultRaw > 0n) rate = s.navUsd / (Number(s.vaultRaw) / 1e9 / (Number(s.circulating) / 10 ** s.decimals)); // USD per r-fstacc
    const largest = await c.getTokenLargestAccounts(new PublicKey(ctx.mints[side]));
    const accts = largest.value.filter((a) => a.address.toBase58() !== ctx.baseVaults[side] && a.address.toBase58() !== ctx.escrows[side] && BigInt(a.amount) > 0n);
    const infos = await c.getMultipleAccountsInfo(accts.map((a) => a.address));
    const held = new Map<string, number>();
    accts.forEach((a, i) => { const o = infos[i] ? pk(infos[i]!.data, 32) : a.address.toBase58(); held.set(o, (held.get(o) ?? 0) + Number(a.amount) / 10 ** s.decimals); });
    for (const actor of actors) {
      if (bots.has(actor)) continue;
      const b = basisFor(evs, actor, ctx.key, side);
      if (!b) continue;
      const tokens = held.get(actor) ?? 0;
      const curve = s.priceUsd === null ? 0 : tokens * s.priceUsd;
      const pot = s.navUsd === null ? 0 : tokens * s.navUsd * 0.96;
      const valueUsd = Math.max(curve, pot);
      const r = rate ?? 0;
      const p = positionPnl(b, tokens, valueUsd / (r || 1), Date.now() / 1000); // value back to r-fstacc for the lib
      if (!p) continue;
      const w = row(actor);
      w.cost += p.cost * r; w.realized += p.realized * r; w.unrealized += p.unrealized * r; w.positions++; if (tokens > 0) w.open++;
    }
  }
  console.error(`${ctx.ticker}: ${sigs.length} txs, ${evs.length} events, ${actors.size} traders`);
}
const rows = [...wallets.entries()].map(([owner, r]) => ({ owner, ...r, net: r.realized + r.unrealized })).sort((a, b) => b.net - a.net);
const sum = (xs: typeof rows, k: keyof Row | "net") => xs.reduce((s, x) => s + (x[k] as number), 0);
const fmt = (x: number) => (x < 0 ? "-" : "") + "$" + Math.abs(x).toFixed(2);
console.log(`\nrate: 1 r-fstacc = ${fmt(rate ?? 0)} · ${totalTx} txs · ${totalEv} events · ${rows.length} wallets (bots excluded)\n`);
console.log("wallet                                        cost      realized   unrealized   net        pos/open");
for (const x of rows) console.log(`${x.owner}${x.owner === HOUSE ? "*" : " "} ${fmt(x.cost).padStart(9)} ${fmt(x.realized).padStart(10)} ${fmt(x.unrealized).padStart(10)} ${fmt(x.net).padStart(10)}   ${x.positions}/${x.open}`);
for (const [label, xs] of [["ALL", rows], ["EXCL HOUSE", rows.filter((x) => x.owner !== HOUSE)]] as const) {
  const winners = xs.filter((x) => x.net > 0);
  console.log(`\n${label}: wallets ${xs.length} · cost ${fmt(sum(xs, "cost"))} · realized ${fmt(sum(xs, "realized"))} · unrealized ${fmt(sum(xs, "unrealized"))} · net ${fmt(sum(xs, "net"))} · avg net/wallet ${fmt(sum(xs, "net") / (xs.length || 1))}`);
  console.log(`  winners ${winners.length} · total gains ${fmt(sum(winners, "net"))} · realized gains ${fmt(xs.filter((x) => x.realized > 0).reduce((s, x) => s + x.realized, 0))} · 20% of realized gains ${fmt(0.2 * xs.filter((x) => x.realized > 0).reduce((s, x) => s + x.realized, 0))}`);
}
