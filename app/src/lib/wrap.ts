// Wrap/unwrap 100x coins (Token-2022 + the hooked transfer hook) into plain SPL twins that every router can trade.
// Program: SPL Token Wrap as deployed immutably by PSA at 3cwC… (upstream solana-program/token-wrap @ f0ca3d2,
// only declare_id! changed; on-chain sha256 6be8cb3a…c143c). 1:1, fully escrowed; the hook only rebalances the
// market on every transfer, so coins sitting in the escrow change nobody's payout.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  addExtraAccountMetasForExecute,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferHook,
} from "@solana/spl-token";
import { conn, decodeMarket, listMarketKeys, tokenMetadata } from "./chain";

export const WRAP_PROGRAM = new PublicKey("3cwCHXKjSXcfcBRBveKY7Jn6qrF6wPGPt4LQYDcZHQ6w");
const COIN_DECIMALS = 6;

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

export function wrapOf(coin: PublicKey) {
  const wrapped = pda([Buffer.from("mint"), coin.toBuffer(), TOKEN_PROGRAM_ID.toBuffer()], WRAP_PROGRAM);
  const authority = pda([Buffer.from("authority"), wrapped.toBuffer()], WRAP_PROGRAM);
  return {
    coin,
    wrapped,
    backpointer: pda([Buffer.from("backpointer"), wrapped.toBuffer()], WRAP_PROGRAM),
    authority,
    escrow: getAssociatedTokenAddressSync(coin, authority, true, TOKEN_2022_PROGRAM_ID),
  };
}
export type Wrapping = ReturnType<typeof wrapOf>;

export type WrapCoin = { market: PublicKey; side: 0 | 1; symbol: string; name: string; w: Wrapping; live: boolean };

/** Every market's UP and DOWN coin with its SPL twin, twins that exist first. */
export async function listWrapCoins(): Promise<WrapCoin[]> {
  const keys = await listMarketKeys();
  const markets = (await conn.getMultipleAccountsInfo(keys)).flatMap((a, i) => (a ? [decodeMarket(keys[i]!, a.data)] : []));
  const sides = markets.flatMap((m) => [
    { market: m.key, side: 0 as const, mint: m.bullMint },
    { market: m.key, side: 1 as const, mint: m.bearMint },
  ]);
  const ws = sides.map((s) => wrapOf(s.mint));
  const [mints, twins] = await Promise.all([
    conn.getMultipleAccountsInfo(sides.map((s) => s.mint)),
    conn.getMultipleAccountsInfo(ws.map((w) => w.wrapped)),
  ]);
  return sides
    .map((s, i) => {
      const meta = mints[i] ? tokenMetadata(mints[i]!.data) : { name: "", symbol: s.mint.toBase58().slice(0, 4) };
      return { market: s.market, side: s.side, symbol: meta.symbol, name: meta.name, w: ws[i]!, live: !!twins[i] };
    })
    .sort((a, b) => Number(b.live) - Number(a.live) || a.symbol.localeCompare(b.symbol));
}

const ata2022 = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
const ataSpl = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);

export async function wrapBalances(owner: PublicKey, w: Wrapping) {
  const read = async (a: PublicKey) => BigInt((await conn.getTokenAccountBalance(a, "confirmed").catch(() => null))?.value.amount ?? "0");
  const [coin, twin, escrow, supply] = await Promise.all([
    read(ata2022(w.coin, owner)),
    read(ataSpl(w.wrapped, owner)),
    read(w.escrow),
    conn.getTokenSupply(w.wrapped, "confirmed").then((s) => BigInt(s.value.amount)).catch(() => 0n),
  ]);
  return { coin, twin, escrow, supply };
}

/** The transfer-hook accounts a transfer_checked of `amount` needs (the market the hook rebalances, etc.). */
async function hookAccounts(coin: PublicKey, source: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint) {
  const mint = await getMint(conn, coin, "confirmed", TOKEN_2022_PROGRAM_ID);
  const hook = getTransferHook(mint);
  if (!hook || hook.programId.equals(PublicKey.default)) return [];
  const probe = createTransferCheckedInstruction(source, coin, destination, authority, amount, mint.decimals, [], TOKEN_2022_PROGRAM_ID);
  await addExtraAccountMetasForExecute(conn, probe, hook.programId, source, coin, destination, authority, amount, "confirmed");
  return probe.keys.slice(4);
}

const amountData = (tag: number, amount: bigint) => {
  const d = Buffer.alloc(9);
  d[0] = tag;
  d.writeBigUInt64LE(amount, 1);
  return d;
};

/** CreateMint (idempotent) + the escrow ATA; the program wants the mint and backpointer PDAs pre-funded with rent. */
export async function createTwinIxs(payer: PublicKey, w: Wrapping): Promise<TransactionInstruction[]> {
  const [mintAcc, backAcc] = await conn.getMultipleAccountsInfo([w.wrapped, w.backpointer]);
  const gap = async (have: number, size: number) => Math.max(0, (await conn.getMinimumBalanceForRentExemption(size)) - have);
  const ixs: TransactionInstruction[] = [];
  const mintGap = await gap(mintAcc?.lamports ?? 0, 82);
  const backGap = await gap(backAcc?.lamports ?? 0, 32);
  if (mintGap) ixs.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: w.wrapped, lamports: mintGap }));
  if (backGap) ixs.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: w.backpointer, lamports: backGap }));
  ixs.push(
    new TransactionInstruction({
      programId: WRAP_PROGRAM,
      data: Buffer.from([0, 1]),
      keys: [
        { pubkey: w.wrapped, isSigner: false, isWritable: true },
        { pubkey: w.backpointer, isSigner: false, isWritable: true },
        { pubkey: w.coin, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
    }),
    createAssociatedTokenAccountIdempotentInstruction(payer, w.escrow, w.authority, w.coin, TOKEN_2022_PROGRAM_ID),
  );
  return ixs;
}

export async function wrapIxs(owner: PublicKey, w: Wrapping, amount: bigint): Promise<TransactionInstruction[]> {
  const source = ata2022(w.coin, owner);
  const recipient = ataSpl(w.wrapped, owner);
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, recipient, owner, w.wrapped, TOKEN_PROGRAM_ID),
    new TransactionInstruction({
      programId: WRAP_PROGRAM,
      data: amountData(1, amount),
      keys: [
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: w.wrapped, isSigner: false, isWritable: true },
        { pubkey: w.authority, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: w.coin, isSigner: false, isWritable: false },
        { pubkey: w.escrow, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
        ...(await hookAccounts(w.coin, source, w.escrow, owner, amount)),
      ],
    }),
  ];
}

export async function unwrapIxs(owner: PublicKey, w: Wrapping, amount: bigint): Promise<TransactionInstruction[]> {
  const recipient = ata2022(w.coin, owner);
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, recipient, owner, w.coin, TOKEN_2022_PROGRAM_ID),
    new TransactionInstruction({
      programId: WRAP_PROGRAM,
      data: amountData(2, amount),
      keys: [
        { pubkey: w.escrow, isSigner: false, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: w.authority, isSigner: false, isWritable: false },
        { pubkey: w.coin, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ataSpl(w.wrapped, owner), isSigner: false, isWritable: true },
        { pubkey: w.wrapped, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
        ...(await hookAccounts(w.coin, w.escrow, recipient, w.authority, amount)),
      ],
    }),
  ];
}

export const COIN_UNIT = 10 ** COIN_DECIMALS;
export function parseCoinAmount(text: string): bigint {
  const m = text.trim().replace(/,/g, "").match(/^(\d*)(?:\.(\d{0,6}))?$/);
  if (!m || (!m[1] && !m[2])) throw new Error("Enter an amount");
  const raw = BigInt((m[1] || "0") + (m[2] ?? "").padEnd(COIN_DECIMALS, "0"));
  if (raw <= 0n) throw new Error("Amount must be positive");
  return raw;
}
