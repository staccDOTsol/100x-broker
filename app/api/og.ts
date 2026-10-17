// Share cards. /api/og?m=<market>              -> market card
//              /api/og?m=<market>&side=0|1&owner=<wallet> -> position card
//              /api/og?owner=<wallet>          -> portfolio card
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { META } from "../src/meta.js";
import { PublicKey } from "@solana/web3.js";
import { warCard } from "./_lib/og.js";
import { readView, FEATURED } from "./war.js";
import { loadPlayer } from "../src/lib/war.js";
import { serverConnection } from "../src/lib/upstream.js";
import { marketCard, metaCard, portfolioCard, positionCard, readBalance, readMarketCard, readPortfolio, renderPng, seriesFromMarket, siteCard, solUsd, vaultCard } from "./_lib/og.js";
import { conn as dnConn, decodeMarket, decodeVault, valuation } from "./_lib/dnplan.js";
import { getAsset } from "./_lib/das.js";
import { walletFeed } from "./_lib/feed.js";
import { basisFor, positionPnl } from "./_lib/pnl.js";

const CACHE = "public, max-age=30, s-maxage=60, stale-while-revalidate=600";
const key = (s: unknown) => {
  try {
    return s ? new PublicKey(String(s)) : null;
  } catch {
    return null;
  }
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const m = key(req.query.m);
    const owner = key(req.query.owner);
    const side = req.query.side === "1" ? 1 : req.query.side === "0" ? 0 : null;
    let el;
    if (req.query.war !== undefined) {
      // a Stars War card: /api/og?war=<id>|featured&sc=live|lead|won|divs|open&by=<wallet>&v=<state tag>
      const id = req.query.war === "featured" || req.query.war === "" ? FEATURED : Number(req.query.war);
      const out = await readView(id);
      if (!out) return res.status(404).json({ error: "no such game" });
      const by = key(req.query.by)?.toBase58() ?? null;
      let extra = {};
      if (req.query.sc === "divs" && by) {
        const p = await loadPlayer(serverConnection(), out.g, key(by)!);
        const units = Number(p.owed) / 10 ** out.v.asset.decimals;
        extra = { owed: units, owedUsd: out.v.asset.usd === null ? null : units * out.v.asset.usd };
      }
      const v = out.v;
      el = warCard({ ...v, symbol: v.asset.symbol, image: v.asset.image }, String(req.query.sc ?? "live"), by, extra);
      const png = await renderPng(el);
      // the URL carries the state tag, so a given URL's picture never changes: cache it hard
      return res.setHeader("content-type", "image/png").setHeader("cache-control", req.query.v ? "public, max-age=86400, s-maxage=86400, immutable" : CACHE).send(png);
    } else if (m && side !== null && owner) {
      const card = await readMarketCard(m);
      const amount = await readBalance(owner, card.sides[side].mint);
      // the P&L the bag page shows for this row: cost basis from the owner's own buys / sells / cash-outs
      let pnl = null;
      try {
        const s = card.sides[side];
        const units = Number(amount) / 10 ** s.decimals;
        const valueUsd = Math.max(s.priceUsd === null ? 0 : units * s.priceUsd, s.navUsd === null ? 0 : units * s.navUsd * 0.96);
        const perRf = card.quoteUsd(1_000_000_000n);
        if (perRf) {
          const evs = await walletFeed(owner, 60);
          pnl = positionPnl(basisFor(evs, owner.toBase58(), m.toBase58(), side), units, valueUsd / perRf, Math.floor(Date.now() / 1000));
        }
      } catch {
        /* card still renders without the P&L strip */
      }
      el = positionCard(card, side, amount, owner.toBase58(), pnl);
    } else if (m) {
      el = marketCard(await readMarketCard(m));
    } else if (owner) {
      el = portfolioCard(owner.toBase58(), await readPortfolio(owner));
    } else if (key(req.query.v)) {
      const vkey = key(req.query.v)!;
      const c = dnConn();
      const vd = await c.getAccountInfo(vkey);
      if (!vd) return res.status(404).json({ error: "no vault" });
      const vault = decodeVault(vkey, Buffer.from(vd.data));
      const md = Buffer.from((await c.getAccountInfo(vault.market))!.data);
      const bits = decodeMarket(md);
      const [obs, opool] = await c.getMultipleAccountsInfo([new PublicKey(md.subarray(136, 168)), new PublicKey(md.subarray(104, 136))]);
      const series = obs && opool ? seriesFromMarket(md, Buffer.from(obs.data), Buffer.from(opool.data), Math.floor(Date.now() / 1000) - 86400) : [];
      const [x, asset, sol, ray] = await Promise.all([
        valuation(c, vault, bits),
        getAsset(vault.xMint.toBase58()).catch(() => null) as Promise<any>,
        solUsd(),
        fetch(`https://api-v3.raydium.io/pools/info/ids?ids=${vault.pool.toBase58()}`).then((r) => r.json()).catch(() => null) as Promise<any>,
      ]);
      const dayApr: number | null = ray?.data?.[0]?.day?.apr ?? null;
      const lpShare = x.nav > 0n ? Number(x.xVal + x.solPos) / Number(x.nav) : 0;
      const simple = dayApr === null ? null : (dayApr / 100) * lpShare;
      const navSol = Number(x.nav) / 1e9;
      const sharePrice = x.supply > 0n ? Number(x.nav) / Number(x.supply) : 1;
      el = vaultCard({
        ticker: asset?.symbol ?? asset?.content?.metadata?.symbol ?? "coin",
        image: asset?.image ?? asset?.content?.links?.image ?? null,
        navSol, navUsd: sol ? navSol * sol : null, sharePrice, errBps: Number(x.errBps), bandBps: vault.bandBps,
        apyCompounded: simple === null ? null : Math.pow(1 + simple / 365, 365) - 1, aprSimple: simple,
        sinceLaunch: x.supply > 0n ? sharePrice - 1 : null, owner: key(req.query.ref)?.toBase58() ?? null, series,
        coverUp: Math.min(1, x.dStar > 0n ? Number(x.d) / Number(x.dStar) : 0),
        coverDown: Math.min(1, (x.dStar > 0n ? Number(x.d) / Number(x.dStar) : 0) * (x.pot > 0n ? Number(x.potUp) / Number(x.pot) : 0)),
      });
    } else if (req.query.meta) {
      const rows = await Promise.all(
        META.map(async (p) => ({ ticker: p.ticker, headline: p.headline, side: p.side, tag: p.tag, card: p.market ? await readMarketCard(new PublicKey(p.market), false).catch(() => null) : null })),
      );
      el = metaCard(rows);
    } else {
      el = siteCard();
    }
    const png = await renderPng(el);
    res.setHeader("content-type", "image/png").setHeader("cache-control", CACHE).send(png);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "card failed" });
  }
}
