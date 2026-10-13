// The 0/20 rule: 0% of your stake, 20% of your realized gain. On every exit that lands as SOL, a fifth of the profit is
// swapped to USDC and committed to the STACCIndex raise on Backable FROM THE USER'S OWN WALLET, in the same transaction.
// The user holds the funding record: they claim the $STACCS at close, or claim the USDC back if the raise misses.
// Nobody at 100x.broker touches it. Program + accounts decoded from live `fund` transactions on the launch.
import { PublicKey, TransactionInstruction, SystemProgram, AddressLookupTableAccount } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { conn } from "./chain.js";
import { withdrawOut, type PoolState } from "./zap.js";
import type { Basis } from "./pnl.js";
import { WSOL } from "../config.js";

export const GAIN_SHARE = 0.2;
export const RAISE_URL = "https://www.backable.biz/raises/6wot8WTk5WGoUQrSbFaTzMasUutYBfQDG3pNan3LG9sU";
export const RAISE_CLOSES = Date.parse("2026-10-18T20:02:08Z");
const LAUNCH_PROGRAM = new PublicKey("moontUzsdepotRGe5xsfip7vLPTJnVuafqdUWexVnPM");
const LAUNCH = new PublicKey("6wot8WTk5WGoUQrSbFaTzMasUutYBfQDG3pNan3LG9sU");
const LAUNCH_QUOTE_VAULT = new PublicKey("GSMtPgAw6CBt38AXwpGSaxrrcpSYTyNNMQdQkrNgHWhG");
const EVENT_AUTHORITY = new PublicKey("Cv3ApcGZMYzAzKF3vuAbWzwbLvicw17ePYMvrSedGLE4");
export const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const FUND_DISC = Buffer.from([218, 188, 111, 221, 152, 113, 174, 7]);
/** No floor: 0% of stake, 20% of gain, however small. The only skip is a share that rounds to nothing. */
export const MIN_SHARE_LAMPORTS = 1n;
const JUP = "https://lite-api.jup.ag/swap/v1";
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const MEMO_TAG = "100x.broker 0/20";
const memoIx = () => new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(MEMO_TAG) });

export const raiseOpen = () => Date.now() < RAISE_CLOSES;

/** Realized gain on this exit, in r-fstacc raw units: proceeds minus the average cost of the tokens going out. */
export function exitGain(b: Basis | undefined, tokensOut: number, proceeds: bigint): bigint {
  if (!b || b.inQ <= 0 || b.tokIn <= 0 || tokensOut <= 0) return 0n;
  const cpt = b.inQ / b.tokIn; // r-fstacc (UI) per token, average cost
  const soldCostUi = Math.min(b.inQ, cpt * (b.tokOut + tokensOut)) - Math.min(b.inQ, cpt * b.tokOut);
  const gain = proceeds - BigInt(Math.round(soldCostUi * 1e9));
  return gain > 0n ? gain : 0n;
}

/** 20% of the gain, as the SOL the stake pool pays out for it. */
export function shareLamports(gain: bigint, pool: PoolState): bigint {
  if (gain <= 0n) return 0n;
  const lst = (gain * BigInt(Math.round(GAIN_SHARE * 10_000))) / 10_000n;
  return withdrawOut(pool, lst);
}

export function fundIx(funder: PublicKey, amount: bigint): TransactionInstruction {
  const [record] = PublicKey.findProgramAddressSync([Buffer.from("funding_record"), LAUNCH.toBuffer(), funder.toBuffer()], LAUNCH_PROGRAM);
  const data = Buffer.alloc(16);
  FUND_DISC.copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  return new TransactionInstruction({
    programId: LAUNCH_PROGRAM,
    keys: [
      { pubkey: LAUNCH, isSigner: false, isWritable: true },
      { pubkey: record, isSigner: false, isWritable: true },
      { pubkey: LAUNCH_QUOTE_VAULT, isSigner: false, isWritable: true },
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: getAssociatedTokenAddressSync(USDC, funder), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: LAUNCH_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });
}

type JupIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
const toIx = (i: JupIx) =>
  new TransactionInstruction({
    programId: new PublicKey(i.programId),
    keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(i.data, "base64"),
  });

/** SOL → USDC through Jupiter, direct routes only so it fits beside the exit in one transaction. */
export async function swapSolToUsdc(user: PublicKey, lamports: bigint) {
  const q = new URLSearchParams({
    inputMint: WSOL.toBase58(), outputMint: USDC.toBase58(), amount: lamports.toString(), slippageBps: "100",
    onlyDirectRoutes: "true", maxAccounts: "24", restrictIntermediateTokens: "true",
  });
  const quote = await (await fetch(`${JUP}/quote?${q}`)).json();
  if (!quote?.outAmount) throw new Error(quote?.error ?? "no SOL→USDC route");
  const r = await fetch(`${JUP}/swap-instructions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: user.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: false, skipUserAccountsRpcCalls: true }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  const ixs = [...(j.setupInstructions ?? []), j.swapInstruction, ...(j.cleanupInstruction ? [j.cleanupInstruction] : [])].map(toIx);
  const tables = (await Promise.all((j.addressLookupTableAddresses ?? []).map((a: string) => conn.getAddressLookupTable(new PublicKey(a)))))
    .map((t) => t.value)
    .filter((t): t is AddressLookupTableAccount => !!t);
  return { ixs, tables, minOut: BigInt(quote.otherAmountThreshold ?? quote.outAmount), out: BigInt(quote.outAmount) };
}

/** Everything the 0/20 step needs, to append after an exit that pays `lamports` of share in SOL. */
export async function backIxs(user: PublicKey, lamports: bigint) {
  const usdcAta = getAssociatedTokenAddressSync(USDC, user);
  const swap = await swapSolToUsdc(user, lamports);
  if (swap.minOut <= 0n) throw new Error("share too small");
  return {
    ixs: [memoIx(), createAssociatedTokenAccountIdempotentInstruction(user, usdcAta, user, USDC), ...swap.ixs, fundIx(user, swap.minOut)],
    tables: swap.tables,
    usdc: swap.minOut,
  };
}
