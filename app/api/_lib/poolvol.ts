// Pool volume + liquidity from Birdeye, for venues whose own API publishes none (PumpSwap's swap-api has no volume).
// Birdeye `defi/v3/pair/overview/multiple` is not on our plan (401), so this reads `defi/v3/pair/overview/single` per pool,
// five at a time, memoized per pool 2 min fresh / 10 min stale (api/_lib/memo.ts). A pool Birdeye does not know, or a
// failed call, yields { vol24: null, liq: null } so callers keep showing "—". Verified shape (2026-10-13):
//   { data: { address, liquidity: number, volume_24h: number, ... } | {}, success: true }
import type { PoolVol } from "../../src/lib/venues.js";
import { memo } from "./memo.js";

const SINGLE = "https://public-api.birdeye.so/defi/v3/pair/overview/single";
const WIDTH = 5;
export const MAX_IDS = 20;

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x !== "" && Number.isFinite(Number(x)) ? Number(x) : null);

async function one(key: string, id: string): Promise<PoolVol> {
  const r = await fetch(`${SINGLE}?address=${id}`, { headers: { "X-API-KEY": key, "x-chain": "solana", accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`birdeye ${r.status}`);
  const j: any = await r.json();
  const d = j?.data;
  // `data: {}` for an address Birdeye has not indexed
  if (!d || typeof d !== "object" || d.address !== id) return { vol24: null, liq: null };
  return { vol24: num(d.volume_24h), liq: num(d.liquidity) };
}

/** 24h USD volume + USD liquidity per pool address. Missing key -> every id null (never throws). */
export async function poolVolumes(ids: string[]): Promise<Record<string, PoolVol>> {
  const out: Record<string, PoolVol> = {};
  const key = process.env.BIRDEYE_API_KEY;
  const want = [...new Set(ids)].slice(0, MAX_IDS);
  for (const id of want) out[id] = { vol24: null, liq: null };
  if (!key) return out;
  for (let i = 0; i < want.length; i += WIDTH) {
    await Promise.all(
      want.slice(i, i + WIDTH).map(async (id) => {
        try {
          out[id] = await memo<PoolVol>(`poolvol:${id}`, 120_000, 600_000, () => one(key, id));
        } catch {
          /* nothing from Birdeye: the row keeps "—" */
        }
      }),
    );
  }
  return out;
}
