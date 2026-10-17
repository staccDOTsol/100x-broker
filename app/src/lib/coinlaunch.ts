// Self-serve coin launch (100x.broker/launch): a pump.fun coin quoted in $100XBRO with the 3% creator fee going to the
// launcher, an optional first buy, and optionally a Last Bid Wins war on the coin, opened with a ~$1 bid out of that buy.
// Phantom can't sign transaction v1 yet, so this is v0 against LAUNCH_ALT, and that splits it in two: the coin + first buy
// (1163 bytes) and the war + opening bid (578). All four in one v0 transaction measure 1421 bytes against the 1232 cap even
// with the table, since ~21 accounts are new per launch and program ids can't come from a table. One wallet approval signs
// both. The house launch of $LASTBID went out as one v1 transaction (see v1tx.ts).
import { PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import { getBuyTokenAmountFromSolAmount } from "./pumpsdk.js";
import { PUMP_QUOTE, PUMP_SDK, creatorVaultPda, quoteAtaOf, type PumpQuote } from "./pump.js";
import { LAUNCH_CREATOR_FEE_BPS } from "./hooked.js";
import { autoTeam, bidIxs, createGameIxs, knownMint, type WarGame } from "./war.js";

/** The launch's fixed accounts (pump, its quote config, $100XBRO, the token programs, Stars War's factory), created by the house. */
export const LAUNCH_ALT = new PublicKey("D6SuwPTAqTRNeeLeaytHsvnwwyjrrGU75GRBXvR5n3US");
export const COIN_DECIMALS = 6;
export const playUrl = (mint: PublicKey | string) => `https://lastbidwins.fun/play/${typeof mint === "string" ? mint : mint.toBase58()}`;

/** Tokens a fresh curve gives for `quoteRaw` $100XBRO (fees included). */
export function tokensFor(pq: PumpQuote, quoteRaw: bigint): bigint {
  const { quote, global, feeConfig } = pq;
  return BigInt(getBuyTokenAmountFromSolAmount({
    global, feeConfig, mintSupply: null, bondingCurve: null, amount: new BN(quoteRaw.toString()), quoteMint: PUMP_QUOTE,
    quoteControl: quote.pumpQuote!.curve.quoteControl, creatorFeeBps: new BN(LAUNCH_CREATOR_FEE_BPS), pumpQuote: quote.pumpQuote!.curve,
  }).toString());
}

/** A first buy on a fresh curve: the coins it gets, and pump's price per coin before and right after it (in $100XBRO, fees
 *  included, both 6 decimals so raw and whole ratios match). The curve is constant product, so the buy's average price is the
 *  geometric mean of the two: after = average^2 / before. The Orca pools of a pump launch open at `after`. */
export function firstBuyPrice(pq: PumpQuote, buyQuote: bigint) {
  const spend = (buyQuote * 99n) / 100n;
  const tokens = tokensFor(pq, spend);
  const before = 1_000_000 / Number(tokensFor(pq, 1_000_000n)); // what 1 $100XBRO buys, inverted
  const average = Number(spend) / Number(tokens);
  return { tokens, before, after: (average * average) / before };
}

export type CoinLaunch = {
  wallet: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  /** first buy, raw $100XBRO (0 = none) */
  buyQuote: bigint;
  war: boolean;
  /** $100XBRO's USD price, to size the war's ~$1 minimum bid */
  quoteUsd: number;
  pq: PumpQuote;
};

export async function coinLaunchIxs(conn: Connection, p: CoinLaunch) {
  const { quote } = p.pq;
  const coin: TransactionInstruction[] = [
    await PUMP_SDK.createV2Instruction({
      mint: p.mint, name: p.name.slice(0, 32), symbol: p.symbol.slice(0, 13), uri: p.uri.slice(0, 200), creator: p.wallet, user: p.wallet,
      mayhemMode: false, quoteMint: PUMP_QUOTE, quoteTokenProgram: quote.quoteTokenProgram, creatorFeeBps: new BN(LAUNCH_CREATOR_FEE_BPS), pumpQuote: quote.pumpQuote!.accounts,
    }),
    // the 3% lands in the creator vault's $100XBRO account; make sure it exists before the first buy
    createAssociatedTokenAccountIdempotentInstruction(p.wallet, quoteAtaOf(creatorVaultPda(p.wallet), quote, true), creatorVaultPda(p.wallet), PUMP_QUOTE, quote.quoteTokenProgram),
  ];
  // a fresh curve prices exactly as the SDK says; 1% under the budget keeps the cap (the full budget) from biting
  const tokens = p.buyQuote > 0n ? tokensFor(p.pq, (p.buyQuote * 99n) / 100n) : 0n;
  if (tokens > 0n) {
    coin.push(
      createAssociatedTokenAccountIdempotentInstruction(p.wallet, getAssociatedTokenAddressSync(p.mint, p.wallet, false, TOKEN_2022_PROGRAM_ID), p.wallet, p.mint, TOKEN_2022_PROGRAM_ID),
      await PUMP_SDK.getBuyV2InstructionRaw({ user: p.wallet, mint: p.mint, creator: p.wallet, amount: new BN(tokens.toString()), quoteAmount: new BN(p.buyQuote.toString()), tokenProgram: TOKEN_2022_PROGRAM_ID, quoteMint: PUMP_QUOTE, quoteTokenProgram: quote.quoteTokenProgram }),
    );
  }
  if (!p.war) return { coin, war: [] as TransactionInstruction[], tokens, game: null };

  // the war: same settings as every war (1h round, 60s anti-snipe); minimum bid ~$1 of the coin at its launch price
  knownMint(p.mint, TOKEN_2022_PROGRAM_ID, COIN_DECIMALS);
  const dollar = BigInt(Math.max(1, Math.round(1e6 / p.quoteUsd))); // raw $100XBRO worth ~$1
  const perDollar = tokensFor(p.pq, dollar);
  const mag = 10n ** BigInt(Math.max(0, perDollar.toString().length - 1));
  let minBid = ((perDollar + mag - 1n) / mag) * mag; // rounded up to one significant digit
  if (tokens > 0n && minBid > tokens) minBid = tokens;
  const created = await createGameIxs(conn, p.wallet, { roundSecs: 3600, antiSnipeSecs: 60, antiSnipeExtendSecs: 60, minBid, mint: p.mint });
  const war = [...created.ixs];
  // with a first buy, the launcher opens the war (and holds its first key)
  if (tokens > 0n) war.push(...(await bidIxs(conn, { id: created.id, key: created.game, isToken: true, mint: p.mint } as WarGame, p.wallet, minBid, autoTeam(p.wallet), null)));
  return { coin, war, tokens, game: { id: created.id, key: created.game, minBid, opened: tokens > 0n } };
}
