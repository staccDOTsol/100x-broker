// UP/DOWN token image: the underlying's own image, tinted green or red, with a 100x badge. PNG, CDN-cached.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import sharp from "sharp";
import { CACHE, getAsset, sideOf } from "./_lib/das.js";

const SIZE = 512;
const TINT = { up: { r: 72, g: 178, b: 110 }, down: { r: 224, g: 86, b: 54 } };
const WASH = { up: "#1f7a4a", down: "#b7431f" };

function badge(side: "up" | "down", label: string) {
  const arrow = side === "up" ? "▲" : "▼";
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${WASH[side]}" stop-opacity="0"/><stop offset="1" stop-color="${WASH[side]}" stop-opacity="0.92"/></linearGradient></defs>
  <rect x="0" y="${SIZE * 0.55}" width="${SIZE}" height="${SIZE * 0.45}" fill="url(#g)"/>
  <text x="${SIZE / 2}" y="${SIZE * 0.86}" font-family="Arial Narrow, Arial, Helvetica, sans-serif" font-weight="900" font-size="${SIZE * 0.2}" text-anchor="middle" fill="#fbf6ea" letter-spacing="-2">${arrow} 100×</text>
  <text x="${SIZE / 2}" y="${SIZE * 0.96}" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${SIZE * 0.07}" text-anchor="middle" fill="#fbf6ea" opacity="0.9">${label}</text>
</svg>`);
}

function fallback(side: "up" | "down", symbol: string) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" fill="${WASH[side]}"/>
  <text x="${SIZE / 2}" y="${SIZE * 0.5}" font-family="Arial Narrow, Arial, Helvetica, sans-serif" font-weight="900" font-size="${SIZE * 0.22}" text-anchor="middle" fill="#fbf6ea">${symbol}</text>
</svg>`);
}

async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "image/*" } });
    clearTimeout(t);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > 0 && buf.length < 15_000_000 ? buf : null;
  } catch {
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const side = sideOf(req.query.s);
  try {
    const a = await getAsset(String(req.query.mint ?? ""));
    const src = a.image ? await fetchImage(a.image) : null;
    let base: sharp.Sharp;
    if (src) {
      // tint = greyscale luminance recoloured toward the side's hue: "the og, but greener/redder"
      base = sharp(src, { animated: false, failOn: "none" })
        .resize(SIZE, SIZE, { fit: "cover" })
        .flatten({ background: "#1c1a17" })
        .tint(TINT[side]);
    } else {
      base = sharp(fallback(side, a.symbol));
    }
    const png = await base
      .composite([{ input: badge(side, `${a.symbol} · ${side === "up" ? "UP" : "DOWN"}`), gravity: "south" }])
      .png({ compressionLevel: 9 })
      .toBuffer();
    res.setHeader("content-type", "image/png").setHeader("cache-control", CACHE).send(png);
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : "image failed" });
  }
}
