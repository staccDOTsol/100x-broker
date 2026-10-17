// 100x.broker/launch, self-serve: a pump.fun coin quoted in $100XBRO with your own metadata, the 3% creator fee to you, an
// optional first buy, and optionally a Last Bid Wins war on it.
//   GET  /api/launch                -> { quote: { symbol, usd }, alt }            the form's $ readout
//   POST /api/launch {op:"zap", wallet, amount (raw $100XBRO)} -> { tx }  the SOL -> $100XBRO swap an Orca launch's first buy needs
//   GET  /api/launch?orca=1         -> { slots, quotes, alt }  the Orca launcher's menu (api/_lib/orcaslots.ts); its
//        transactions are built and signed in the browser (src/lib/orcalaunch.ts)
//   POST /api/launch {op:"meta", mint, name, symbol, description, website?, twitter?, telegram?, war, image: dataURL}
//        -> { uri, image, website }  writes coins/<mint>/image.<ext> + meta.json to the lastbidwins Blob store (uri is the
//        short 100x.broker/c/<mint>, rewritten to that meta.json); refused once
//        the mint exists on chain, so a launched coin's metadata can't be swapped out from here
//   POST /api/launch {op:"build", wallet, mint, uri, name, symbol, buy (whole $100XBRO, 0 = none), war}
//        -> { txs: base64[], mintTx, summary }. In order: [SOL -> $100XBRO zap, when the wallet is short], the coin + first buy
//        (`mintTx`, which the mint key signs too), [the war + its opening bid]. One wallet approval signs them all.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount, type TransactionInstruction } from "@solana/web3.js";
import { serverConnection } from "../src/lib/upstream.js";
import { resolvePumpQuote, PUMP_QUOTE, pumpUrl } from "../src/lib/pump.js";
import { COIN_DECIMALS, LAUNCH_ALT, coinLaunchIxs, playUrl } from "../src/lib/coinlaunch.js";
import { tokenBalance, usdPrice, WSOL_MINT, zapIn } from "./_lib/warzap.js";
import { orcaQuotes, orcaSlotsFromTable } from "./_lib/orcaslots.js";

const conn = serverConnection();
const BLOB_API = "https://blob.vercel-storage.com";
const BLOB_PUBLIC = "https://wjvksitfxf9annmd.public.blob.vercel-storage.com";
const metaUri = (mint: string) => `https://100x.broker/c/${mint}`;
const isKey = (s: unknown) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const MAX_IMAGE = 2_500_000;
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

class Bad extends Error {}
const bad = (m: string) => new Bad(m);

// uploads are the only thing here that costs us storage: a few per IP per minute is plenty for someone launching
const hits = new Map<string, { n: number; at: number }>();
function limit(req: VercelRequest, per: number) {
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "?").split(",")[0].trim();
  const now = Date.now();
  const h = hits.get(ip);
  const used = h && now - h.at < 60_000 ? h.n : 0;
  if (used >= per) throw bad("slow down a moment and try again");
  hits.set(ip, { n: used + 1, at: h && now - h.at < 60_000 ? h.at : now });
}

async function put(path: string, body: Buffer | string, type: string) {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) throw new Error("blob store not configured");
  const r = await fetch(`${BLOB_API}/?pathname=${encodeURIComponent(path)}`, {
    method: "PUT", body,
    headers: { authorization: `Bearer ${t}`, "x-api-version": "11", "x-content-type": type, "x-add-random-suffix": "0", "x-allow-overwrite": "1", "x-cache-control-max-age": "60" },
  });
  if (!r.ok) throw new Error(`upload failed (${r.status})`);
  return `${BLOB_PUBLIC}/${path}`;
}

const text = (v: unknown, max: number, what: string, required = false) => {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) throw bad(`${what} is required`);
  if (s.length > max) throw bad(`${what} is too long (max ${max})`);
  return s;
};
const link = (v: unknown, what: string) => {
  const s = text(v, 200, what);
  if (!s) return "";
  const u = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const p = new URL(u);
    if (p.protocol !== "https:" && p.protocol !== "http:") throw 0;
    return p.toString();
  } catch {
    throw bad(`${what} isn't a valid link`);
  }
};
const handle = (v: unknown, base: string, what: string) => {
  const s = text(v, 200, what);
  if (!s) return "";
  if (/^@?[A-Za-z0-9_]{1,32}$/.test(s)) return `${base}${s.replace(/^@/, "")}`;
  return link(s, what);
};

async function meta(req: VercelRequest, b: Record<string, unknown>) {
  limit(req, 6);
  if (!isKey(b.mint)) throw bad("missing mint");
  const mint = new PublicKey(b.mint as string);
  if (await conn.getAccountInfo(mint)) throw bad("that coin already exists; its metadata is final");
  const name = text(b.name, 32, "name", true);
  const symbol = text(b.symbol, 10, "ticker", true).replace(/^\$/, "").toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw bad("ticker: letters and numbers only, up to 10");
  const war = b.war !== false;
  const about = text(b.description, 600, "description");
  const website = link(b.website, "website") || (war ? playUrl(mint) : "https://100x.broker");
  const twitter = handle(b.twitter, "https://x.com/", "X");
  const telegram = handle(b.telegram, "https://t.me/", "Telegram");
  const m = String(b.image ?? "").match(/^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || !IMAGE_TYPES[m[1]]) throw bad("image: png, jpg, gif or webp");
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > MAX_IMAGE) throw bad("image is over 2.5 MB");
  const k = mint.toBase58();
  const image = await put(`coins/${k}/image.${IMAGE_TYPES[m[1]]}`, bytes, m[1]);
  // every launch says where it came from
  const tag = "Launched on 100x.broker, quoted in $100XBRO.";
  const description = [about, war ? `${tag} Play its war: ${playUrl(k).replace("https://", "")}` : tag].filter(Boolean).join("\n\n");
  const json = {
    name, symbol, description, image, showName: true, createdOn: "https://100x.broker",
    website, external_url: website, ...(twitter && { twitter }), ...(telegram && { telegram }),
    attributes: [{ trait_type: "quote", value: "$100XBRO" }, { trait_type: "launched on", value: "100x.broker" }, ...(war ? [{ trait_type: "game", value: "lastbidwins.fun" }] : [])],
    properties: { files: [{ uri: image, type: m[1] }], category: "image" },
  };
  await put(`coins/${k}/meta.json`, JSON.stringify(json), "application/json");
  // the on-chain uri is the short form (vercel.json rewrites /c/<mint> to the blob): a 32-character name still fits the coin's
  // transaction under 1232 bytes
  return { uri: metaUri(k), image, website, name, symbol };
}

let altCache: { at: number; v: AddressLookupTableAccount } | null = null;
async function launchAlt() {
  if (altCache && Date.now() - altCache.at < 300_000) return altCache.v;
  const v = (await conn.getAddressLookupTable(LAUNCH_ALT)).value;
  if (!v) throw new Error("launch lookup table missing");
  altCache = { at: Date.now(), v };
  return v;
}

async function pack(payer: PublicKey, ixs: TransactionInstruction[], alts: AddressLookupTableAccount[], cu: number, check: boolean) {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }), ...ixs],
  }).compileToV0Message(alts);
  const tx = new VersionedTransaction(msg);
  const bytes = tx.serialize();
  if (bytes.length > 1232) throw new Error(`transaction too large (${bytes.length} bytes)`);
  if (check) {
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) {
      if (JSON.stringify(sim.value.err).includes("AccountNotFound")) throw bad("this wallet has no SOL yet, so it can't pay the fee. Add SOL and try again.");
      const why = (sim.value.logs ?? []).filter((l) => /Error Message|failed|insufficient/i.test(l)).slice(-1)[0] ?? JSON.stringify(sim.value.err);
      throw bad(why.replace(/^Program log: /, ""));
    }
  }
  return Buffer.from(bytes).toString("base64");
}

async function build(b: Record<string, unknown>) {
  if (!isKey(b.wallet) || !isKey(b.mint)) throw bad("connect a wallet first");
  const wallet = new PublicKey(b.wallet as string);
  const mint = new PublicKey(b.mint as string);
  const uri = String(b.uri ?? "");
  if (uri !== metaUri(mint.toBase58())) throw bad("upload the metadata first");
  const name = text(b.name, 32, "name", true);
  const symbol = text(b.symbol, 10, "ticker", true).replace(/^\$/, "").toUpperCase();
  const war = b.war !== false;
  const buyUnits = Number(b.buy ?? 0);
  if (!Number.isFinite(buyUnits) || buyUnits < 0) throw bad("first buy must be a number");
  const buyQuote = BigInt(Math.floor(buyUnits * 10 ** COIN_DECIMALS));

  const [pq, quoteUsd, solUsd, have, lamports, alt] = await Promise.all([
    resolvePumpQuote(conn), usdPrice(PUMP_QUOTE.toBase58()), usdPrice(WSOL_MINT).catch(() => null),
    buyQuote > 0n ? tokenBalance(conn, wallet, PUMP_QUOTE) : Promise.resolve(0n), conn.getBalance(wallet), launchAlt(),
  ]);
  if (!quoteUsd) throw new Error("no $100XBRO price right now; try again in a moment");
  const built = await coinLaunchIxs(conn, { wallet, mint, name, symbol, uri, buyQuote, war, quoteUsd, pq });

  // short on $100XBRO for the first buy: swap SOL into it first (its own transaction)
  const txs: string[] = [];
  let zap: { lamports: string; via: string } | null = null;
  if (buyQuote > have) {
    const z = await zapIn(conn, wallet, PUMP_QUOTE, buyQuote - have);
    txs.push(await pack(wallet, z.ixs, z.alts, 700_000, true));
    zap = { lamports: z.lamportsIn.toString(), via: z.via };
  }
  // rent for the coin, its curve, the token accounts and the war, plus fees: the house launch cost 0.0151 SOL all in
  const need = 25_000_000n + BigInt(zap?.lamports ?? "0");
  if (BigInt(lamports) < need) {
    const sol = (n: bigint) => (Number(n) / 1e9).toFixed(3);
    throw bad(`this needs about ${sol(need)} SOL${solUsd ? ` (~$${((Number(need) / 1e9) * solUsd).toFixed(2)})` : ""} and the wallet has ${sol(BigInt(lamports))}. Add SOL and try again.`);
  }
  // the coin can't be simulated behind a zap that hasn't landed; the war never can (its mint doesn't exist yet)
  const mintTx = txs.length;
  txs.push(await pack(wallet, built.coin, [alt], 400_000, !zap));
  if (built.war.length) txs.push(await pack(wallet, built.war, [alt], 200_000, false));

  const tokens = Number(built.tokens) / 10 ** COIN_DECIMALS;
  const spend = Number(buyQuote) / 10 ** COIN_DECIMALS;
  return {
    txs, mintTx,
    summary: {
      mint: mint.toBase58(), symbol, pump: pumpUrl(mint), play: war ? playUrl(mint) : null,
      buy: buyQuote > 0n ? { quote: spend, usd: spend * quoteUsd, tokens } : null,
      game: built.game ? { id: built.game.id, opened: built.game.opened, minBid: Number(built.game.minBid) / 10 ** COIN_DECIMALS } : null,
      zap,
    },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("cache-control", "no-store");
  try {
    if (req.method === "GET") {
      // the Orca launcher's menu: fee tiers it can open against, quotes with prices, and the launch lookup table
      if (req.query.orca) {
        const alt = process.env.ORCA_LAUNCH_ALT;
        if (!alt) throw new Error("the Orca launch table isn't configured");
        // the menu is what the table lists: those pools are guaranteed to fit one transaction, and no program scan is needed
        const [slots, quotes] = await Promise.all([orcaSlotsFromTable(conn, alt), orcaQuotes(conn)]);
        res.setHeader("cache-control", "public, max-age=30, s-maxage=60");
        return res.status(200).json({ slots, quotes, alt });
      }
      const usd = await usdPrice(PUMP_QUOTE.toBase58()).catch(() => null);
      return res.status(200).json({ quote: { symbol: "100XBRO", mint: PUMP_QUOTE.toBase58(), usd }, alt: LAUNCH_ALT.toBase58() });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "POST" });
    const b = (typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {}) as Record<string, unknown>;
    if (b.op === "meta") return res.status(200).json(await meta(req, b));
    if (b.op === "build") return res.status(200).json(await build(b));
    // the Orca launcher builds everything in the browser except a SOL -> $100XBRO swap, which needs a route
    if (b.op === "zap") {
      if (!isKey(b.wallet)) throw bad("connect a wallet first");
      const need = BigInt(String(b.amount ?? "0"));
      if (need <= 0n) throw bad("nothing to swap");
      const z = await zapIn(conn, new PublicKey(b.wallet as string), PUMP_QUOTE, need);
      return res.status(200).json({ tx: await pack(new PublicKey(b.wallet as string), z.ixs, z.alts, 700_000, true), lamports: z.lamportsIn.toString(), via: z.via });
    }
    return res.status(400).json({ error: "op must be meta, build or zap" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!(e instanceof Bad)) console.error("[launch]", msg);
    return res.status(e instanceof Bad ? 400 : 500).json({ error: msg });
  }
}
