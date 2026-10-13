// Share cards (1200x630 PNG) rendered server-side with satori + resvg, in the site's own type.
// Three cards: market, position (one side of one market for a wallet), portfolio (all positions of a wallet).
import { readFileSync } from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { getAsset } from "./das.js";
import { memo } from "./memo.js";
import { MARKET_ORACLE_KIND, VENUE_LABEL, type Venue, pumpSwapPoolOf, slotMints, slotSpotTick, venueOfKind } from "../../src/lib/venues.js";

const PROGRAM_ID = new PublicKey(process.env.VITE_PROGRAM_ID ?? "T8EKHG9mJhwWNAYWisFKvbYynGMvSHP5Fb7kxSDh7cb");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const WSOL = "So11111111111111111111111111111111111111112";
const STABLES = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
const POOL = new PublicKey("SzoSoRxsrL9sbFcwpbjbH5bRrzuvFtuytZTeuqZCfQ6");
const LEVERAGE = 100;
const MARKET_LEN = 1008;

const conn = () => {
  const u = process.env.HELIUS_RPC_URL;
  if (!u) throw new Error("HELIUS_RPC_URL not configured");
  return new Connection(u, "confirmed");
};

// ---------- palette (dark theme tokens, hex for satori) ----------
const C = {
  paper: "#171412",
  paper2: "#1f1b18",
  rule: "#3a332d",
  ink: "#ece6da",
  ink2: "#bdb4a6",
  ink3: "#8a8073",
  up: "#5fcf8f",
  down: "#f0825d",
  signal: "#f2c14e",
};

// ---------- fonts ----------
type Font = { name: string; data: Buffer; weight: 400 | 600 | 700; style: "normal" };
let fonts: Font[] | null = null;
function loadFonts(): Font[] {
  if (fonts) return fonts;
  const dir = path.join(process.cwd(), "api", "_fonts");
  const tryLoad = (file: string, name: string, weight: Font["weight"]): Font | null => {
    try {
      const data = readFileSync(path.join(dir, file));
      return data.length > 1000 ? { name, data, weight, style: "normal" } : null;
    } catch {
      return null;
    }
  };
  fonts = [
    tryLoad("IBMPlexSansCondensed-Bold.ttf", "Display", 700),
    tryLoad("IBMPlexMono-SemiBold.ttf", "Mono", 600),
    tryLoad("IBMPlexSans-Regular.ttf", "Sans", 400),
    tryLoad("IBMPlexSans-SemiBold.ttf", "Sans", 600),
  ].filter((f): f is Font => !!f);
  if (!fonts.some((f) => f.name === "Sans")) {
    // fall back to mono for body text if Plex Sans didn't ship
    const mono = fonts.find((f) => f.name === "Mono");
    if (mono) fonts.push({ ...mono, name: "Sans", weight: 400 }, { ...mono, name: "Sans", weight: 600 });
  }
  return fonts;
}

// ---------- formatting ----------
const SUB = "₀₁₂₃₄₅₆₇₈₉";
/** Prices: 6 decimals above $1, 6 significant digits below (subscript zero-count for the tiny ones). */
export function usd(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return "—";
  if (x >= 1000) return `$${x.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (x >= 1) return `$${x.toFixed(6)}`;
  if (x === 0) return "$0";
  const [mant, exp] = x.toExponential(5).split("e");
  const zeros = -Number(exp) - 1;
  const digits = mant.replace(".", "");
  if (zeros < 4) return `$${x.toFixed(zeros + 6)}`;
  return `$0.0${[...String(zeros)].map((d) => SUB[Number(d)]).join("")}${digits}`;
}
/** Money amounts (vaults, holdings): 2 decimals. */
export const money = (x: number | null) => (x === null || !Number.isFinite(x) ? "—" : x >= 1 ? `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : usd(x));
const lev = (x: number) => (Number.isNaN(x) ? "—" : !Number.isFinite(x) || x >= 10_000 ? ">10,000×" : `${x >= 1000 ? Math.round(x).toLocaleString() : x.toFixed(x < 10 ? 1 : 0)}×`);
const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

// ---------- chain reads ----------
const u64 = (d: Buffer, o: number) => d.readBigUInt64LE(o);
const i64 = (d: Buffer, o: number) => d.readBigInt64LE(o);
const u128 = (d: Buffer, o: number) => u64(d, o) + (u64(d, o + 8) << 64n);
const pk = (d: Buffer, o: number) => new PublicKey(d.subarray(o, o + 32));

let lastSol: { at: number; v: number } | null = null;
export async function solUsd(): Promise<number | null> {
  if (lastSol && Date.now() - lastSol.at < 20_000) return lastSol.v;
  const tryJup = async () => {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${WSOL}`, { signal: AbortSignal.timeout(4000) });
    const j: any = await r.json();
    const p = Number(j?.[WSOL]?.usdPrice);
    if (!Number.isFinite(p) || p <= 0) throw new Error("jup");
    return p;
  };
  const tryGecko = async () => {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(4000) });
    const p = Number(((await r.json()) as any)?.solana?.usd);
    if (!Number.isFinite(p) || p <= 0) throw new Error("gecko");
    return p;
  };
  try {
    const v = await tryJup().catch(tryGecko);
    lastSol = { at: Date.now(), v };
    return v;
  } catch {
    return lastSol?.v ?? null; // last good price beats a blank leaderboard
  }
}
/** SOL per r-fstacc from the stake pool account: moves by epoch, read at most every 20 s. */
const lstRate = (c: Connection): Promise<number> =>
  memo("og:lstRate", 20_000, 120_000, async () => {
    const d = (await c.getAccountInfo(POOL))!.data;
    return Number(u64(d, 258)) / Number(u64(d, 266));
  });

export type Side = {
  symbol: string;
  decimals: number;
  vaultUsd: number | null;
  priceUsd: number | null; // curve price per token
  navUsd: number | null; // vault value per token
  leverage: number;
  owed: number;
  vaultRaw: bigint;
  circulating: bigint;
  mint: PublicKey;
};
export type MarketCard = {
  key: string;
  ticker: string;
  name: string;
  image: string | null; // data url (png) or null
  oracleUsd: number | null;
  windowMin: number;
  sides: [Side, Side];
  quoteUsd: (raw: bigint) => number | null;
  series: Pt[];
  quoteSymbol: string;
  venue: Venue;
};

export type Pt = { ts: number; price: number };
/** The coin's price over the ring's memory (plus checkpoints): the average tick between consecutive observations.
 *  Kinds 1-4 have no ring: `obs` is then a reserve/pool account and only the checkpoints (plus the live spot) are charted;
 *  pass `live` for that and the decimals explicitly. */
export function seriesFromMarket(d: Buffer, obs: Buffer, opool: Buffer, sinceTs: number, kind = 0, dec?: [number, number], live?: { ts: number; tick: number }): Pt[] {
  const flag = d[489];
  const d0 = dec ? dec[0] : opool[233];
  const d1 = dec ? dec[1] : opool[234];
  const raw: { ts: number; tc: bigint }[] = [];
  if (kind === 0) {
    for (let i = 0; i < 100; i++) {
      const ts = obs.readUInt32LE(51 + i * 44);
      if (ts > 0) raw.push({ ts, tc: obs.readBigInt64LE(51 + i * 44 + 4) });
    }
  }
  for (let i = 0; i < 32; i++) {
    const ts = d.readUInt32LE(496 + i * 16);
    if (ts > 0) raw.push({ ts, tc: d.readBigInt64LE(496 + i * 16 + 8) });
  }
  raw.sort((a, b) => a.ts - b.ts);
  const toPrice = (tick: number) => (flag ? Math.pow(1.0001, tick) * 10 ** (d0 - d1) : Math.pow(1.0001, -tick) * 10 ** (d1 - d0));
  const pts: Pt[] = [];
  for (let i = 1; i < raw.length; i++) {
    const dt = raw[i].ts - raw[i - 1].ts;
    if (dt <= 0) continue;
    const price = toPrice(Number(raw[i].tc - raw[i - 1].tc) / dt);
    if (Number.isFinite(price) && price > 0) pts.push({ ts: raw[i].ts, price });
  }
  if (live && Number.isFinite(live.tick)) {
    const price = toPrice(live.tick);
    if (Number.isFinite(price) && price > 0) pts.push({ ts: live.ts, price });
  }
  const recent = pts.filter((p) => p.ts >= sinceTs);
  return recent.length >= 6 ? recent : pts.slice(-24);
}

/** Sampled TWAP (kinds 1-4): newest checkpoint extended with the live tick to now, averaged back over the window. Mirrors oracle.rs read_sampled with no ring. */
function sampledTwapQ32(ckpts: { ts: number; tc: bigint }[], window: number, now: number, tick: number): bigint | null {
  const valid = ckpts.filter((c) => c.ts > 0).sort((a, b) => b.ts - a.ts);
  const newest = valid[0];
  if (!newest || !Number.isFinite(tick)) return null;
  const end = { ts: now, tc: newest.tc + BigInt(Math.round(tick)) * BigInt(Math.max(0, now - newest.ts)) };
  const target = Math.max(0, end.ts - window);
  let best: typeof end | undefined;
  let oldest = end;
  for (const p of valid) {
    if (p.ts > end.ts) continue;
    if (p.ts <= target && (!best || p.ts > best.ts)) best = p;
    if (p.ts < oldest.ts) oldest = p;
  }
  const start = best ?? oldest;
  if (start.ts === end.ts) return null;
  return ((end.tc - start.tc) << 32n) / BigInt(end.ts - start.ts);
}

/** A little line chart: the window's path plus its change, drawn as inline SVG (satori renders paths). */
export function spark(series: Pt[], label: string, w = 1088, hgt = 72, color = C.ink2): El | null {
  if (series.length < 2) return null;
  const lo = Math.min(...series.map((p) => p.price));
  const hi = Math.max(...series.map((p) => p.price));
  const t0 = series[0].ts;
  const t1 = series[series.length - 1].ts;
  const span = Math.max(1, t1 - t0);
  const pad = 4;
  const x = (p: Pt) => pad + ((p.ts - t0) / span) * (w - pad * 2);
  const y = (p: Pt) => (hi === lo ? hgt / 2 : pad + (1 - (p.price - lo) / (hi - lo)) * (hgt - pad * 2));
  const dPath = series.map((p, i) => `${i === 0 ? "M" : "L"}${x(p).toFixed(1)} ${y(p).toFixed(1)}`).join(" ");
  const chg = series[0].price > 0 ? series[series.length - 1].price / series[0].price - 1 : 0;
  const chgColor = chg >= 0 ? C.up : C.down;
  const hours = Math.max(1, Math.round(span / 3600));
  return col(
    { gap: 4, width: "100%" },
    row({ justifyContent: "space-between" }, meta(`${label} · last ${hours} h`), mono(`${chg >= 0 ? "+" : "−"}${Math.abs(chg * 100).toFixed(2)}%`, 20, chgColor)),
    h(
      "svg",
      { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}` },
      h("path", { d: `M${pad} ${y(series[0]).toFixed(1)} L${w - pad} ${y(series[0]).toFixed(1)}`, fill: "none", stroke: C.paper2, strokeWidth: 2 }),
      h("path", { d: dPath, fill: "none", stroke: color, strokeWidth: 3, strokeLinejoin: "round", strokeLinecap: "round" }),
    ),
  );
}

function twapQ32(obs: Buffer, ckpts: { ts: number; tc: bigint }[], window: number): bigint | null {
  const idx = obs.readUInt16LE(17);
  const pts: { ts: number; tc: bigint }[] = [];
  for (let i = 0; i < 100; i++) pts.push({ ts: obs.readUInt32LE(51 + i * 44), tc: i64(obs, 51 + i * 44 + 4) });
  const end = pts[idx];
  const target = Math.max(0, end.ts - window);
  let best: typeof end | undefined;
  let oldest = end;
  for (const p of [...pts, ...ckpts]) {
    if (p.ts === 0 || p.ts > end.ts) continue;
    if (p.ts <= target && (!best || p.ts > best.ts)) best = p;
    if (p.ts < oldest.ts) oldest = p;
  }
  const start = best ?? oldest;
  if (start.ts === end.ts) return null;
  return ((end.tc - start.tc) << 32n) / BigInt(end.ts - start.ts);
}

async function tokenImage(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const png = await sharp(Buffer.from(await r.arrayBuffer()), { animated: false, failOn: "none" })
      .resize(160, 160, { fit: "cover" })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

/** One market's card data: 10 s fresh, a minute stale. Shared by /api/og, /api/page (every /m/:key view) and the leaderboards. */
export const readMarketCard = (key: PublicKey, withImage = true): Promise<MarketCard> =>
  memo(`og:card:${key.toBase58()}:${withImage ? 1 : 0}`, 10_000, 60_000, () => loadMarketCard(key, withImage));
async function loadMarketCard(key: PublicKey, withImage: boolean): Promise<MarketCard> {
  const c = conn();
  const mi = await c.getAccountInfo(key);
  if (!mi || mi.data.length !== MARKET_LEN) throw new Error("market not found");
  const d = mi.data;
  const bullMint = pk(d, 8);
  const bearMint = pk(d, 40);
  const oraclePool = pk(d, 104);
  const oracleObs = pk(d, 136);
  const [vB, vR, pB, pR, mB, mR, bvB, bvR, obs, opool] = await c.getMultipleAccountsInfo([
    pk(d, 168), pk(d, 200), pk(d, 232), pk(d, 264), bullMint, bearMint, pk(d, 296), pk(d, 328), oracleObs, oraclePool,
  ]);
  if (!vB || !vR || !pB || !pR || !mB || !mR || !bvB || !bvR || !obs || !opool) throw new Error("market accounts missing");
  const flag = d[489];
  const windowSecs = d.readUInt32LE(480);
  const ckpts = Array.from({ length: 32 }, (_, i) => ({ ts: d.readUInt32LE(496 + i * 16), tc: i64(d, 496 + i * 16 + 8) }));
  const kind = d[MARKET_ORACLE_KIND];
  const venue = venueOfKind(kind);
  const nowTs = Math.floor(Date.now() / 1000);
  // kind 0 reads mints + decimals off the CLMM pool; kinds 1-4 read the mints off the slot accounts and the decimals off the mints
  let d0: number, d1: number, underlying: PublicKey, quoteMint: string;
  let live: { ts: number; tick: number } | undefined;
  if (venue === "clmm") {
    d0 = opool.data[233];
    d1 = opool.data[234];
    underlying = pk(opool.data, flag ? 73 : 105);
    quoteMint = pk(opool.data, flag ? 105 : 73).toBase58();
  } else {
    const { mint0, mint1 } = slotMints(venue, obs.data, opool.data);
    // kind 1 prices against quote vault + the PumpSwap Pool's virtual_quote_reserves, so the Pool comes along
    const [[m0, m1], psPool] = await Promise.all([
      c.getMultipleAccountsInfo([mint0, mint1]),
      venue === "pumpswap" ? pumpSwapPoolOf(c, bullMint, oracleObs, oraclePool, obs.data) : null,
    ]);
    if (!m0 || !m1) throw new Error("oracle mints missing");
    d0 = m0.data[44];
    d1 = m1.data[44];
    underlying = flag ? mint0 : mint1;
    quoteMint = (flag ? mint1 : mint0).toBase58();
    live = { ts: nowTs, tick: slotSpotTick(venue, obs.data, opool.data, psPool?.data) };
  }
  const [sol, rate, asset] = await Promise.all([solUsd(), lstRate(c), getAsset(underlying.toBase58()).catch(() => null)]);
  const quoteUsd = (raw: bigint) => (sol ? (Number(raw) / 1e9) * rate * sol : null);
  const tq = (venue === "clmm" ? twapQ32(obs.data, ckpts, windowSecs) : sampledTwapQ32(ckpts, windowSecs, nowTs, live!.tick)) ?? i64(d, 424);
  const tick = Number(tq) / 2 ** 32;
  const priceInQuote = flag ? Math.pow(1.0001, tick) * 10 ** (d0 - d1) : Math.pow(1.0001, -tick) * 10 ** (d1 - d0);
  const oracleUsd = quoteMint === WSOL ? (sol ? priceInQuote * sol : null) : STABLES.has(quoteMint) ? priceInQuote : null;

  const vaults = [u64(vB.data, 64), u64(vR.data, 64)];
  const mk = (i: 0 | 1, mint: typeof mB, pool: typeof pB, bv: typeof bvB, mintKey: PublicKey): Side => {
    const decimals = mint.data[44];
    const supply = u64(mint.data, 36);
    const circulating = supply - u64(bv.data, 64);
    const sq = Number(u128(pool.data, 280)) / 2 ** 64;
    const price = sq * sq * 10 ** (decimals - 9); // r-fstacc per token
    const nav = circulating > 0n ? Number(vaults[i]) / 1e9 / (Number(circulating) / 10 ** decimals) : 0;
    const other = vaults[1 - i];
    return {
      symbol: `${asset?.symbol ?? "TOKEN"}${i === 0 ? "UP" : "DN"}`,
      decimals,
      vaultUsd: quoteUsd(vaults[i]),
      priceUsd: sol ? price * rate * sol : null,
      navUsd: sol ? nav * rate * sol : null,
      leverage: vaults[i] > 0n ? (LEVERAGE * Number(other)) / Number(vaults[i]) : other > 0n ? Infinity : NaN,
      owed: 1 - Number(u64(d, 432 + 8 * i)) / 2 ** 63,
      vaultRaw: vaults[i],
      circulating,
      mint: mintKey,
    };
  };
  return {
    key: key.toBase58(),
    ticker: asset?.symbol ?? short(underlying.toBase58()),
    name: asset?.name ?? "",
    image: withImage ? await tokenImage(asset?.image ?? null) : null,
    oracleUsd,
    windowMin: Math.round(windowSecs / 60),
    sides: [mk(0, mB, pB, bvB, bullMint), mk(1, mR, pR, bvR, bearMint)],
    quoteUsd,
    series: seriesFromMarket(d, obs.data, opool.data, nowTs - 86400, kind, [d0, d1], live),
    quoteSymbol: quoteMint === WSOL ? "SOL" : STABLES.has(quoteMint) ? "USD" : "quote",
    venue,
  };
}

const ata = (mint: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

export async function readBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const info = await conn().getAccountInfo(ata(mint, owner));
  return info ? u64(info.data, 64) : 0n;
}

export type Position = { market: MarketCard; side: 0 | 1; amount: bigint; valueUsd: number | null; redeemUsd: number | null };
export const readPortfolio = (owner: PublicKey): Promise<Position[]> => memo(`og:portfolio:${owner.toBase58()}`, 10_000, 60_000, () => loadPortfolio(owner));
async function loadPortfolio(owner: PublicKey): Promise<Position[]> {
  const c = conn();
  const markets = await c.getProgramAccounts(PROGRAM_ID, { dataSlice: { offset: 8, length: 64 }, filters: [{ dataSize: MARKET_LEN }] });
  const atas = markets.flatMap((m) => [ata(pk(m.account.data, 0), owner), ata(pk(m.account.data, 32), owner)]);
  const infos = atas.length ? await c.getMultipleAccountsInfo(atas) : [];
  const out: Position[] = [];
  for (let i = 0; i < markets.length; i++) {
    const bal = [infos[2 * i], infos[2 * i + 1]].map((x) => (x ? u64(x.data, 64) : 0n));
    if (bal[0] === 0n && bal[1] === 0n) continue;
    const mc = await readMarketCard(markets[i].pubkey, false);
    for (const side of [0, 1] as const) {
      if (bal[side] === 0n) continue;
      const s = mc.sides[side];
      const units = Number(bal[side]) / 10 ** s.decimals;
      out.push({
        market: mc, side, amount: bal[side],
        valueUsd: s.priceUsd === null ? null : units * s.priceUsd,
        redeemUsd: s.navUsd === null ? null : units * s.navUsd * 0.96,
      });
    }
  }
  return out.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
}

// ---------- satori element helpers ----------
type El = { type: string; props: Record<string, unknown> };
const h = (type: string, props: Record<string, unknown> = {}, ...children: unknown[]): El => {
  const kids = children.filter((c) => c !== null && c !== undefined && c !== false);
  return { type, props: kids.length === 0 ? props : { ...props, children: kids.length === 1 ? kids[0] : kids } };
};
const row = (style: Record<string, unknown>, ...kids: unknown[]) => h("div", { style: { display: "flex", flexDirection: "row", ...style } }, ...kids);
const col = (style: Record<string, unknown>, ...kids: unknown[]) => h("div", { style: { display: "flex", flexDirection: "column", ...style } }, ...kids);
const txt = (s: string, style: Record<string, unknown>) => h("div", { style: { display: "flex", ...style } }, s);
const display = (s: string, size: number, color = C.ink) => txt(s, { fontFamily: "Display", fontSize: size, lineHeight: 0.9, color, textTransform: "uppercase", letterSpacing: -1 });
const mono = (s: string, size: number, color = C.ink) => txt(s, { fontFamily: "Mono", fontSize: size, color });
const meta = (s: string, color = C.ink3) => txt(s, { fontFamily: "Sans", fontWeight: 600, fontSize: 20, letterSpacing: 2, color, textTransform: "uppercase" });

function frame(...kids: unknown[]) {
  return col(
    { width: 1200, height: 630, background: C.paper, color: C.ink, padding: "48px 56px", fontFamily: "Sans", justifyContent: "space-between" },
    ...kids,
    row(
      { justifyContent: "space-between", alignItems: "flex-end", borderTop: `3px solid ${C.ink2}`, paddingTop: 18 },
      row({ alignItems: "baseline", gap: 4 }, display("100x", 40), txt(".broker", { fontFamily: "Display", fontSize: 26, color: C.ink3 })),
      meta("Your next 100× · up or down", C.ink3),
    ),
  );
}

function tug(a: bigint, b: bigint, aUsd: number | null, bUsd: number | null, la: number, lb: number) {
  const tot = Number(a + b) || 1;
  const u = Number(a) / tot;
  return col(
    { gap: 8, width: "100%" },
    row(
      { height: 18, borderRadius: 3, overflow: "hidden", background: C.paper2, width: "100%" },
      h("div", { style: { display: "flex", width: `${Math.max(u * 100, 0.5)}%`, background: C.up } }),
      h("div", { style: { display: "flex", width: 3, background: C.paper } }),
      h("div", { style: { display: "flex", flex: 1, background: C.down } }),
    ),
    row({ justifyContent: "space-between" }, mono(`${money(aUsd)} · ${lev(la)} payout`, 22, C.up), mono(`${lev(lb)} payout · ${money(bUsd)}`, 22, C.down)),
  );
}

function tokenHead(m: MarketCard, size = 120) {
  return row(
    { alignItems: "center", gap: 20 },
    m.image ? h("img", { src: m.image, width: size, height: size, style: { borderRadius: size / 2 } }) : null,
    col({}, display(`$${m.ticker}`, size * 1.1), meta(`±100× · ${VENUE_LABEL[m.venue]} TWAP · ${m.windowMin} min`)),
  );
}

export function marketCard(m: MarketCard): El {
  const [up, dn] = m.sides;
  return frame(
    row(
      { justifyContent: "space-between", alignItems: "flex-start" },
      tokenHead(m, 100),
      col({ alignItems: "flex-end" }, meta("oracle · TWAP"), mono(usd(m.oracleUsd), 44)),
    ),
    spark(m.series, `$${m.ticker}/${m.quoteSymbol}`),
    row(
      { gap: 20 },
      col({ flex: 1, background: C.paper2, borderRadius: 8, padding: "14px 24px", gap: 4 }, meta(up.symbol, C.ink3), display("Up 100×", 56, C.up), mono(`${usd(up.priceUsd)} · ${lev(up.leverage)} payout`, 22, C.ink2)),
      col(
        { flex: 1, background: C.paper2, borderRadius: 8, padding: "14px 24px", gap: 4 },
        meta(dn.symbol, C.ink3),
        display("Down 100×", 56, C.down),
        mono(`${usd(dn.priceUsd)} · ${lev(dn.leverage)} payout`, 22, C.ink2),
      ),
    ),
    tug(up.vaultRaw, dn.vaultRaw, up.vaultUsd, dn.vaultUsd, up.leverage, dn.leverage),
  );
}

import { fmtAge, fmtPct, type Pnl } from "./pnl.js";

/** P&L strip for a position card: the return since entry, big, then the split. USD via the market's quote conversion. */
function pnlRow(m: MarketCard, pnl: Pnl): El {
  const toUsd = (rf: number) => m.quoteUsd(BigInt(Math.round(rf * 1e9)));
  const signed = (rf: number) => {
    const u = toUsd(rf);
    return u === null ? "—" : `${u < 0 ? "−" : "+"}${money(Math.abs(u))}`;
  };
  const color = pnl.ret >= 0 ? C.up : C.down;
  return row(
    { gap: 20, alignItems: "stretch" },
    col({ flex: 1, background: C.paper2, borderRadius: 8, padding: "10px 24px", gap: 2 }, meta(`since entry · ${fmtAge(pnl.days)}`), mono(fmtPct(pnl.ret), 44, color)),
    col({ flex: 1.5, background: C.paper2, borderRadius: 8, padding: "10px 24px", gap: 2 }, meta("realized · unrealized"), mono(`${signed(pnl.realized)} · ${signed(pnl.unrealized)}`, 28, C.ink)),
    col({ flex: 1, background: C.paper2, borderRadius: 8, padding: "10px 24px", gap: 2 }, meta("simple · compounded /yr"), mono(`${fmtPct(pnl.apr)} · ${fmtPct(pnl.apy)}`, 20, C.ink2)),
  );
}

export function positionCard(m: MarketCard, side: 0 | 1, amount: bigint, owner: string | null, pnl: Pnl | null = null): El {
  const s = m.sides[side];
  const units = Number(amount) / 10 ** s.decimals;
  const value = s.priceUsd === null ? null : units * s.priceUsd;
  const redeem = s.navUsd === null ? null : units * s.navUsd * 0.96;
  const color = side === 0 ? C.up : C.down;
  return frame(
    row(
      { justifyContent: "space-between", alignItems: "flex-start" },
      col({ gap: 4 }, meta(owner ? `${short(owner)} is` : "position"), display(`${side === 0 ? "Up" : "Down"} 100×`, pnl ? 96 : 120, color), display(`on $${m.ticker}`, 46)),
      m.image ? h("img", { src: m.image, width: 110, height: 110, style: { borderRadius: 55 } }) : null,
    ),
    spark(m.series, `$${m.ticker}/${m.quoteSymbol}`, 1088, 60, color),
    row(
      { gap: 20, alignItems: "stretch" },
      col({ flex: 1.2, background: C.paper2, borderRadius: 8, padding: pnl ? "12px 24px" : "18px 24px", gap: 4 }, meta("holding"), mono(`${units.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${s.symbol}`, pnl ? 26 : 30), mono(`${money(value)} at curve · ${money(redeem)} redeemable`, pnl ? 20 : 22, C.ink2)),
      col(
        { flex: 1, background: C.paper2, borderRadius: 8, padding: "18px 24px", gap: 4, borderLeft: `6px solid ${color}` },
        meta(`payout if ${m.ticker} ${side === 0 ? "pumps" : "dumps"}`),
        mono(lev(s.leverage), 56, color),
        mono(`100 × ${side === 0 ? "DOWN" : "UP"} vault ÷ ${side === 0 ? "UP" : "DOWN"} vault`, 18, C.ink3),
      ),
    ),
    pnl ? pnlRow(m, pnl) : null,
  );
}

const pctS = (x: number) => `${(x * 100).toFixed(Math.abs(x * 100) >= 100 ? 0 : 1)}%`;
const signedPct = (x: number) => `${x < 0 ? "−" : "+"}${Math.abs(x * 100).toFixed(2)}%`;
const tile = (label: string, body: string, big?: string, color?: string) =>
  col({ flex: 1, background: C.paper2, borderRadius: 8, padding: "18px 24px", gap: 4 }, meta(label), big ? mono(big, 44, color ?? C.ink) : null, txt(body, { fontSize: 20, color: C.ink2 }));

export type VaultCardData = {
  ticker: string; image: string | null; navSol: number; navUsd: number | null; sharePrice: number; errBps: number; bandBps: number;
  apyCompounded: number | null; aprSimple: number | null; sinceLaunch: number | null; owner: string | null; series: Pt[]; coverUp: number; coverDown: number;
};
/** A delta-neutral vault: the pitch, the projected APY, the hedge, the size. */
export function vaultCard(d: VaultCardData): El {
  const hedged = d.errBps <= d.bandBps;
  return frame(
    row(
      { justifyContent: "space-between", alignItems: "flex-start" },
      col(
        { gap: 8 },
        meta(d.owner ? `${short(d.owner)} parked SOL in the` : "99.99% risk-free money*"),
        display(`$${d.ticker}/SOL vault`, 92),
        txt("LP the pool, hedge the coin with its own −100× DOWN, keep the fees. Ethena on Solana, for any coin.", { fontSize: 24, color: C.ink2 }),
      ),
      d.image ? h("img", { src: d.image, width: 110, height: 110, style: { borderRadius: 55 } }) : null,
    ),
    spark(d.series, `$${d.ticker}/SOL · what the vault is hedged against`, 1088, 60),
    row(
      { gap: 20, alignItems: "stretch" },
      tile("APY · projected, compounded", `simple ${d.aprSimple === null ? "—" : pctS(d.aprSimple)} · pool fees × share deployed`, d.apyCompounded === null ? "—" : pctS(d.apyCompounded), C.up),
      col(
        { flex: 1, background: C.paper2, borderRadius: 8, padding: "18px 24px", gap: 4, borderLeft: `6px solid ${hedged ? C.up : C.down}` },
        meta("hedge · covers a pump / a dump"),
        mono(`↑${pctS(d.coverUp)} · ↓${pctS(d.coverDown)}`, 34, d.coverUp >= 0.8 && d.coverDown >= 0.8 ? C.up : C.down),
        txt(`${hedged ? "sized" : "drifting"} · ${d.errBps} bps · tight when the book is balanced`, { fontSize: 20, color: C.ink2 }),
      ),
      tile("parked", `${money(d.navUsd)} · share ${d.sharePrice.toFixed(5)} SOL${d.sinceLaunch === null ? "" : ` · ${signedPct(d.sinceLaunch)} since launch`}`, `${d.navSol.toFixed(3)} SOL`),
    ),
  );
}

/** /meta — the curated spicy list with live numbers: one row per pick, the house's own line on top. */
export type MetaRow = { ticker: string; headline: string; side: "UP" | "DOWN" | "VAULT"; tag: string; card: MarketCard | null };
export function metaCard(rows: MetaRow[]): El {
  const line = (r: MetaRow) => {
    const c = r.card;
    const s = c ? c.sides[r.side === "DOWN" ? 1 : 0] : null;
    const color = r.side === "UP" ? C.up : r.side === "DOWN" ? C.down : C.ink;
    return row(
      { justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: `1px dashed ${C.rule}` },
      row({ gap: 14, alignItems: "baseline" }, display(`$${r.ticker}`, 40), display(r.side === "VAULT" ? "vault" : r.side === "UP" ? "Up 100×" : "Down 100×", 30, color), txt(r.headline, { fontSize: 22, color: C.ink2 })),
      c
        ? row({ gap: 24, alignItems: "baseline" }, mono(`oracle ${usd(c.oracleUsd)}`, 22, C.ink2), s ? mono(`${lev(s.leverage)} payout`, 26, color) : mono(`UP ${lev(c.sides[0].leverage)} · DOWN ${lev(c.sides[1].leverage)}`, 22, C.ink2))
        : mono("coming", 22, C.ink3),
    );
  };
  return frame(
    col(
      { gap: 8 },
      meta("what's spicy right now · 100x.broker/meta"),
      display("Long it. Short it. Or get paid for the ride.", 64),
      txt("Markets the house is actually in. ±100×, no liquidations, settled on a 66-min TWAP, 24/7.", { fontSize: 24, color: C.ink2 }),
    ),
    col({ gap: 0 }, ...rows.slice(0, 5).map(line)),
  );
}

/** The bare link: the elevator pitch. */
export function siteCard(): El {
  return frame(
    col(
      { gap: 10 },
      meta("Long it. Short it. Or think it's gonna be a wild ride and get paid for the ride."),
      display("Your next 100×.", 118),
      row({ gap: 22, alignItems: "baseline" }, display("Up", 118, C.up), display("or", 118, C.ink3), display("down.", 118, C.down)),
    ),
    row(
      { gap: 20, alignItems: "stretch" },
      tile("1 · pick a coin", "any coin with a Raydium pool, listed by anyone in one tx"),
      tile("2 · pick a side", "UP is a long, DOWN is a short. every move, the wrong side pays the right side at 100×"),
      tile("3 · leave whenever", "nobody gets liquidated. 4% in, 4% out, settles in SOL. or park it in a vault and keep the fees"),
    ),
  );
}

export function portfolioCard(owner: string, positions: Position[]): El {
  const total = positions.reduce((a, p) => a + (p.valueUsd ?? 0), 0);
  const rows = positions.slice(0, 5).map((p) =>
    row(
      { justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px dashed ${C.rule}` },
      row({ gap: 14, alignItems: "center" }, display(`$${p.market.ticker}`, 34), display(p.side === 0 ? "Up 100×" : "Down 100×", 30, p.side === 0 ? C.up : C.down)),
      row({ gap: 24 }, mono(`${lev(p.market.sides[p.side].leverage)} payout`, 22, C.ink2), mono(money(p.valueUsd), 26)),
    ),
  );
  return frame(
    row(
      { justifyContent: "space-between", alignItems: "flex-end" },
      col({ gap: 8 }, meta(`${short(owner)} · book`), display(positions.length ? `${positions.length} position${positions.length === 1 ? "" : "s"}` : "No positions", 90)),
      col({ alignItems: "flex-end" }, meta("at curve"), mono(money(total), 56)),
    ),
    col({ gap: 0 }, ...(rows.length ? rows : [txt("Pick a side at 100x.broker", { fontSize: 28, color: C.ink2 })]), positions.length > 5 ? mono(`+${positions.length - 5} more`, 20, C.ink3) : null),
  );
}

export async function renderPng(el: El): Promise<Buffer> {
  const svg = await satori(el as any, { width: 1200, height: 630, fonts: loadFonts() as any });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng());
}
