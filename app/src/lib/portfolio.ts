// One wallet's book: every UP/DOWN balance across every market, plus SOL, loose change (r-fstacc) and $100XBRO.
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { conn, listMarketKeys, loadMarketView, type MarketView } from "./chain.js";
import { fetchViews } from "./views.js";
import { MEME_MINT, REDEEM_FEE, RFSTACC } from "../config.js";
import { legacyPositions, type LegacyPosition } from "./legacy.js";

export type Position = { key: string; v: MarketView; side: 0 | 1; amt: bigint };
export type Book = { owner: PublicKey; markets: MarketView[]; positions: Position[]; legacy: LegacyPosition[]; legacyError: string | null; activeError: string | null; sol: bigint; quote: bigint; meme: bigint };
export const MEME_DECIMALS = 6; // pump.fun mints

const amountOf = (d: Uint8Array | undefined) =>
  d && d.byteLength >= 72 ? new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(64, true) : 0n;

export async function loadPortfolio(owner: PublicKey): Promise<Book> {
  // the market views come from the shared server snapshot (one edge-cached load for every tab); only the owner's accounts are read live
  const [active, legacy] = await Promise.allSettled([fetchViews().catch(async () => {
    const keys = await listMarketKeys();
    return (await Promise.all(keys.map((k) => loadMarketView(k).catch(() => null)))).filter((v): v is MarketView => !!v);
  }), legacyPositions(conn, owner)]);
  const markets = active.status === "fulfilled" ? active.value : [];
  const activeError = active.status === "rejected" ? String(active.reason?.message ?? active.reason) : null;
  const addrs = [owner, getAssociatedTokenAddressSync(RFSTACC, owner), getAssociatedTokenAddressSync(MEME_MINT, owner, false, TOKEN_2022_PROGRAM_ID)]; // $100XBRO is a Token-2022 mint
  for (const v of markets) {
    addrs.push(
      getAssociatedTokenAddressSync(v.keys.bullMint, owner, false, TOKEN_2022_PROGRAM_ID),
      getAssociatedTokenAddressSync(v.keys.bearMint, owner, false, TOKEN_2022_PROGRAM_ID),
    );
  }
  const infos: Awaited<ReturnType<typeof conn.getMultipleAccountsInfo>> = [];
  for (let i = 0; i < addrs.length; i += 100) infos.push(...(await conn.getMultipleAccountsInfo(addrs.slice(i, i + 100))));
  const positions: Position[] = [];
  markets.forEach((v, i) => {
    for (const side of [0, 1] as const) {
      const amt = amountOf(infos[3 + i * 2 + side]?.data);
      if (amt > 0n) positions.push({ key: `${v.acct.key.toBase58()}:${side}`, v, side, amt });
    }
  });
  return {
    owner, markets, positions, activeError,
    legacy: legacy.status === "fulfilled" ? legacy.value : [],
    legacyError: legacy.status === "rejected" ? "Existing holdings could not be loaded. Refresh to check them." : null,
    sol: BigInt(infos[0]?.lamports ?? 0), quote: amountOf(infos[1]?.data), meme: amountOf(infos[2]?.data),
  };
}

/** What a position is worth in r-fstacc at the curve and at the pot (after the 4% cash-out fee). */
export function positionValue(p: Position) {
  const s = p.v.side[p.side];
  const units = Number(p.amt) / 10 ** s.decimals;
  const curve = s.atFloor ? 0 : Math.min(units * s.curvePrice, Number(s.reserve) / 1e9);
  const pot = units * s.nav * (1 - REDEEM_FEE);
  return { units, curve, pot, best: Math.max(curve, pot), via: (curve >= pot ? "curve" : "pot") as "curve" | "pot" };
}
