// Token icon proxy: DAS image (cdn, then raw IPFS) -> 128px PNG, cached a month at the edge. No hot-linking, no 429s.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import sharp from "sharp";
import { getAsset } from "./_lib/das.js";

async function grab(url: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: "image/*" } });
  if (!r.ok) throw new Error(String(r.status));
  return Buffer.from(await r.arrayBuffer());
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const a = await getAsset(String(req.query.mint ?? ""));
    if (!a.image) return res.status(404).end();
    const raw = a.image.replace(/^https:\/\/cdn\.helius-rpc\.com\/cdn-cgi\/image\/\/?/, "");
    const candidates = [a.image, raw, raw.replace("https://ipfs.io/ipfs/", "https://cloudflare-ipfs.com/ipfs/"), raw.replace("https://ipfs.io/ipfs/", "https://gateway.pinata.cloud/ipfs/")];
    let src: Buffer | null = null;
    for (const u of [...new Set(candidates)]) {
      try {
        src = await grab(u);
        break;
      } catch {
        /* next gateway */
      }
    }
    if (!src) return res.status(502).end();
    const png = await sharp(src, { animated: false, failOn: "none" }).resize(128, 128, { fit: "cover" }).png().toBuffer();
    res.setHeader("content-type", "image/png").setHeader("cache-control", "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800").send(png);
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : "icon failed" });
  }
}
