// pump.fun side of a launch: a market's companion coins ($TICKERUP / $TICKERDN) created with `create_v2` quoted in $100XBRO,
// creator = the lister's wallet (never a PDA), creator_fee_bps = 300, then a fee-sharing config whose shareholders match the mode
// (mode 0: lister 1000 / Launch PDA 9000; mode 1: Launch PDA 10000). Verified against @pump-fun/pump-sdk 4.0.0.
import { Buffer } from "buffer";
import { Connection, Keypair, PublicKey, TransactionInstruction, type AccountInfo } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { OnlinePumpSdk, PumpSdk, bondingCurvePda, creatorVaultPda, feeSharingConfigPda, getBuyTokenAmountFromSolAmount } from "./pumpsdk.js";
import type { BondingCurve, FeeConfig, Global, ResolvedQuoteMint, SharingConfig } from "./pumpsdk.js";
import BN from "bn.js";
import { MEME_MINT } from "../config.js";
import { LAUNCH_CREATOR_FEE_BPS, LAUNCH_MODE_FULL, LAUNCH_MODE_SHARED, launchPda, registerLaunchIx } from "./hooked.js";

export { bondingCurvePda, creatorVaultPda, feeSharingConfigPda };
export const PUMP_QUOTE = MEME_MINT;
/** pump's fee-sharing split: lister 10%, Launch PDA 90% (of which the program sends 80 to the vault, 10 to the burn pot). */
export const SHARE_LISTER_BPS = 1000;
export const SHARE_LAUNCH_BPS = 9000;
/** Compute budgets: `create_v2` with a Token-2022 pump-coin quote is heavy (SDK: budget ~200k; +buy ~500k). */
export const CU_CREATE = 400_000;
export const CU_CREATE_BUY = 700_000;
export const CU_SHARE = 400_000;
export const pumpUrl = (mint: PublicKey | string) => `https://pump.fun/coin/${typeof mint === "string" ? mint : mint.toBase58()}`;

export const PUMP_SDK = new PumpSdk();
export type PumpQuote = { quote: ResolvedQuoteMint; global: Global; feeConfig: FeeConfig; at: number };
const cache = new Map<string, Promise<PumpQuote>>();
/** $100XBRO as a `create_v2` quote: `source` must be `pumpCoin` with the migrated pool attached (8 remaining accounts). Cached 60 s. */
export function resolvePumpQuote(conn: Connection): Promise<PumpQuote> {
  const k = conn.rpcEndpoint;
  const hit = cache.get(k);
  if (hit) return hit;
  const p = (async () => {
    const sdk = new OnlinePumpSdk(conn);
    const [quote, global, feeConfig] = await Promise.all([sdk.resolveQuoteMint(PUMP_QUOTE), sdk.fetchGlobal(), sdk.fetchFeeConfig()]);
    if (quote.source !== "pumpCoin" || !quote.pumpQuote) throw new Error(`$100XBRO resolved as ${quote.source}, expected a pump coin quote`);
    if (!quote.pumpQuote.accounts.pool) throw new Error("$100XBRO is migrated but its PumpSwap pool did not resolve");
    if (!global.creatorFeeConfigurable || global.maxConfigurableCreatorFeeBps.ltn(LAUNCH_CREATOR_FEE_BPS)) throw new Error(`pump caps creator_fee_bps at ${global.maxConfigurableCreatorFeeBps.toString()}`);
    return { quote, global, feeConfig, at: Date.now() };
  })();
  cache.set(k, p);
  p.then(() => setTimeout(() => cache.delete(k), 60_000), () => cache.delete(k));
  return p;
}

/** `n` fresh mint keypairs from the `1oox…` stockpile (POST /api/vanity); plain keypairs when the endpoint is down, flagged. */
export async function vanityMints(n: number): Promise<{ kp: Keypair; vanity: boolean }[]> {
  try {
    const r = await fetch(`/api/vanity?n=${n}`, { method: "POST" });
    if (!r.ok) throw new Error(`vanity ${r.status}`);
    const j = (await r.json()) as { keys: { pubkey: string; secret: number[]; vanity: boolean }[] };
    const out = j.keys.map((k) => ({ kp: Keypair.fromSecretKey(Uint8Array.from(k.secret)), vanity: !!k.vanity }));
    if (out.length !== n) throw new Error("short");
    return out;
  } catch {
    return Array.from({ length: n }, () => ({ kp: Keypair.generate(), vanity: false }));
  }
}

/** The lister's $100XBRO ATA (Token-2022). */
export const quoteAtaOf = (owner: PublicKey, q: ResolvedQuoteMint, offCurve = false) => getAssociatedTokenAddressSync(PUMP_QUOTE, owner, offCurve, q.quoteTokenProgram);
const PUMPSWAP = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
/** Where a shared coin's creator fees land before distribution: pump's creator vault for the sharing config (curve trades) and
 *  PumpSwap's coin-creator vault authority for it (post-graduation trades), each with its $100XBRO ATA. */
export function sharedVaults(mint: PublicKey, q: ResolvedQuoteMint) {
  const sc = feeSharingConfigPda(mint);
  const pumpVault = creatorVaultPda(sc);
  const ammVaultAuthority = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), sc.toBuffer()], PUMPSWAP)[0];
  return { sharingConfig: sc, pumpVault, pumpVaultAta: quoteAtaOf(pumpVault, q, true), ammVaultAuthority, ammVaultAta: quoteAtaOf(ammVaultAuthority, q, true) };
}

export type LaunchParams = {
  payer: PublicKey;
  market: PublicKey;
  side: 0 | 1;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  mode: number;
  pq: PumpQuote;
};
/** One side: `create` = create_v2 (creator = the signer) + register_launch; `share` = fee-sharing config + the mode's split.
 *  `sharingIx` is the index of createFeeSharingConfig inside `share` (skip it when that account already exists).
 *  `creator` is the sharing-config PDA, which owns the coin once `share` lands — the first buy uses it. */
export async function launchSideIxs(p: LaunchParams): Promise<{ create: TransactionInstruction[]; share: TransactionInstruction[]; sharingIx: number; creator: PublicKey }> {
  if (p.mode !== LAUNCH_MODE_SHARED && p.mode !== LAUNCH_MODE_FULL) throw new Error(`launch mode ${p.mode}`);
  const { quote } = p.pq;
  const launch = launchPda(p.market, p.side);
  const create = [
    await PUMP_SDK.createV2Instruction({ mint: p.mint, name: p.name.slice(0, 32), symbol: p.symbol.slice(0, 13), uri: p.uri.slice(0, 200), creator: p.payer, user: p.payer, mayhemMode: false, quoteMint: PUMP_QUOTE, quoteTokenProgram: quote.quoteTokenProgram, creatorFeeBps: new BN(LAUNCH_CREATOR_FEE_BPS), pumpQuote: quote.pumpQuote!.accounts }),
    registerLaunchIx(p.payer, p.market, p.side, p.mode, p.mint),
  ];
  const v = sharedVaults(p.mint, quote);
  const newShareholders = p.mode === LAUNCH_MODE_SHARED
    ? [{ address: p.payer, shareBps: SHARE_LISTER_BPS }, { address: launch, shareBps: SHARE_LAUNCH_BPS }]
    : [{ address: launch, shareBps: 10_000 }];
  // update_fee_shares_v2 on a token quote expects these initialised: the lister's $100XBRO ATA (the inner distribute pays the
  // *current* shareholder), the sharing config's pump creator-vault ATA, its PumpSwap coin-creator vault ATA, and the Launch
  // PDA's $100XBRO ATA (where the PDA's share lands). Idempotent; the lister pays the rent.
  const atas = [
    createAssociatedTokenAccountIdempotentInstruction(p.payer, quoteAtaOf(p.payer, quote), p.payer, PUMP_QUOTE, quote.quoteTokenProgram),
    createAssociatedTokenAccountIdempotentInstruction(p.payer, v.pumpVaultAta, v.pumpVault, PUMP_QUOTE, quote.quoteTokenProgram),
    createAssociatedTokenAccountIdempotentInstruction(p.payer, v.ammVaultAta, v.ammVaultAuthority, PUMP_QUOTE, quote.quoteTokenProgram),
    createAssociatedTokenAccountIdempotentInstruction(p.payer, quoteAtaOf(launch, quote, true), launch, PUMP_QUOTE, quote.quoteTokenProgram),
  ];
  const share = [
    ...atas,
    await PUMP_SDK.createFeeSharingConfig({ creator: p.payer, mint: p.mint, pool: null }),
    await PUMP_SDK.updateFeeSharesV2({
      authority: p.payer, mint: p.mint, currentShareholders: [p.payer], newShareholders,
      quoteMint: PUMP_QUOTE, quoteTokenProgram: quote.quoteTokenProgram, bondingCurveComplete: false,
    }),
  ];
  return { create, share, sharingIx: atas.length, creator: feeSharingConfigPda(p.mint) };
}

/** The optional first buy, its own transaction after the share leg (buy_v2 is 27 accounts; it does not fit beside create_v2).
 *  Sent after the sharing config exists, so its 3% creator fee is already split. `creator` is the sharing-config PDA. */
export async function firstBuyIxs(p: { payer: PublicKey; mint: PublicKey; creator: PublicKey; buyQuote: bigint; pq: PumpQuote }): Promise<TransactionInstruction[]> {
  const { quote, global, feeConfig } = p.pq;
  // The SDK's quote for a pump-coin pair runs ~60% under what buy_v2 actually charges, so size the
  // token amount from half the budget and let quoteAmount (the full budget) be the slippage cap.
  const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: new BN(((p.buyQuote * 50n) / 100n).toString()), quoteMint: PUMP_QUOTE, quoteControl: quote.pumpQuote!.curve.quoteControl, creatorFeeBps: new BN(LAUNCH_CREATOR_FEE_BPS), pumpQuote: quote.pumpQuote!.curve });
  const userBase = getAssociatedTokenAddressSync(p.mint, p.payer, false, TOKEN_2022_PROGRAM_ID);
  return [
    createAssociatedTokenAccountIdempotentInstruction(p.payer, userBase, p.payer, p.mint, TOKEN_2022_PROGRAM_ID),
    await PUMP_SDK.getBuyV2InstructionRaw({ user: p.payer, mint: p.mint, creator: p.creator, amount, quoteAmount: new BN(p.buyQuote.toString()), tokenProgram: TOKEN_2022_PROGRAM_ID, quoteMint: PUMP_QUOTE, quoteTokenProgram: quote.quoteTokenProgram }),
  ];
}
export const CU_BUY = 400_000;

// ---------- reading a launched coin ----------
export type CurveStats = {
  mint: string;
  curve: string;
  complete: boolean;
  /** $100XBRO per token (both 6 decimals). */
  price: number;
  /** Market cap in $100XBRO (whole tokens). */
  mcap: number;
  /** 0..1 of the curve's real token supply sold. */
  progress: number;
  /** $100XBRO raised so far (whole tokens). */
  raised: number;
  creator: string;
  creatorFeeBps: number;
};
export function curveStats(mint: PublicKey, info: AccountInfo<Buffer>): CurveStats {
  const c: BondingCurve = PUMP_SDK.decodeBondingCurve(info);
  const vt = Number(c.virtualTokenReserves.toString());
  const vq = Number(c.virtualQuoteReserves.toString());
  const price = vt > 0 ? vq / vt : 0;
  const supply = Number(c.tokenTotalSupply.toString()) / 1e6;
  const initialReal = 793_100_000; // pump's initial real token reserves (whole tokens), what the curve sells before completing
  const realLeft = Number(c.realTokenReserves.toString()) / 1e6;
  return {
    mint: mint.toBase58(), curve: bondingCurvePda(mint).toBase58(), complete: c.complete, price, mcap: price * supply,
    progress: c.complete ? 1 : Math.max(0, Math.min(1, 1 - realLeft / initialReal)), raised: Number(c.realQuoteReserves.toString()) / 1e6,
    creator: c.creator.toBase58(), creatorFeeBps: Number(c.creatorFeeBps.toString()),
  };
}
export const decodeSharingConfig = (info: AccountInfo<Buffer>): SharingConfig => PUMP_SDK.decodeSharingConfig(info);
/** Sharing config finalised for this mode: admin revoked, and the shareholder list is the mode's split. */
export function sharesSet(sc: SharingConfig | null, mode: number, lister: PublicKey, launch: PublicKey): boolean {
  if (!sc?.adminRevoked) return false;
  const bps = (a: PublicKey) => sc.shareholders.find((s) => s.address.equals(a))?.shareBps ?? -1;
  if (mode === LAUNCH_MODE_SHARED) return sc.shareholders.length === 2 && bps(lister) === SHARE_LISTER_BPS && bps(launch) === SHARE_LAUNCH_BPS;
  if (mode === LAUNCH_MODE_FULL) return sc.shareholders.length === 1 && bps(launch) === 10_000;
  return false;
}
export { TOKEN_2022_PROGRAM_ID as PUMP_QUOTE_PROGRAM };
