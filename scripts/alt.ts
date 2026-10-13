// Address lookup table for site/keeper txs. A stranger's SOL->Ape tx is 1234 bytes without one (2 over the limit).
import { Buffer } from "buffer";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  StakeProgram,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveDbcEventAuthority, deriveDbcPoolAuthority } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { DBC, DEV_ATA, type Market, PROGRAM_ID, PUMP, PUMPSWAP, RFSTACC, burnStatePda, burnVaultPda, memeVenue, sideAccounts } from "./lib";
import { type Pool, STAKE_POOL, STAKE_POOL_PROGRAM } from "./stakepool";

export const HOUSE = new PublicKey("331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth");
const WITHDRAW_AUTHORITY = PublicKey.findProgramAddressSync([STAKE_POOL.toBuffer(), Buffer.from("withdraw")], STAKE_POOL_PROGRAM)[0];

/** Accounts every site tx touches regardless of market. */
export function globalAccounts(p: Pool, meme?: PublicKey): PublicKey[] {
  const out = [
    ComputeBudgetProgram.programId, SystemProgram.programId, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    SYSVAR_CLOCK_PUBKEY, SYSVAR_STAKE_HISTORY_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY, StakeProgram.programId,
    DBC, deriveDbcPoolAuthority(), deriveDbcEventAuthority(), RFSTACC,
    PROGRAM_ID, burnVaultPda(), burnStatePda(), DEV_ATA, getAssociatedTokenAddressSync(RFSTACC, HOUSE),
    STAKE_POOL_PROGRAM, STAKE_POOL, WITHDRAW_AUTHORITY, p.reserveStake, p.managerFeeAccount,
  ];
  if (meme) {
    const v = memeVenue(meme);
    out.push(PUMP, PUMPSWAP, meme, v.bondingCurve, v.pool);
  }
  return out;
}

/** Everything a buy/sell/redeem/settle/claim on one market touches. */
export function marketAccounts(m: Market): PublicKey[] {
  const out = [m.key, m.bullMint, m.bearMint, m.oraclePool, m.oracleObs, m.config];
  if (m.venuePool) out.push(m.venuePool); // kind 1: the PumpSwap Pool rides along on every poke/settle/redeem
  for (const side of [0, 1]) {
    const a = sideAccounts(m, side);
    out.push(a.pool, a.baseVault, a.quoteVault, a.escrow, a.vault, a.meta);
  }
  return out;
}

const dedupe = (keys: PublicKey[]) => [...new Map(keys.map((k) => [k.toBase58(), k])).values()];

async function sendIxs(conn: Connection, payer: Keypair, ixs: TransactionInstruction[]) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  tx.sign([payer]);
  const sig = await conn.sendRawTransaction(tx.serialize());
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`alt tx failed ${sig}: ${JSON.stringify(res.value.err)}`);
  return sig;
}

/** Every table we own is created by the keeper; that one key is how every client finds them, no registry. */
export const ALT_AUTHORITY = new PublicKey("EGa3ng1xcuB5X9tkK7czYczhD4PpAYAJF52Vo9F2Cn7");
const ALT_MAX = 256;
const LIVE = 2n ** 64n - 1n; // deactivation_slot of a live table
/** Our live lookup tables, found on chain: the authority sits at byte 22 of the table meta. Stable order (by address). */
export async function listAlts(conn: Connection, authority: PublicKey = ALT_AUTHORITY): Promise<AddressLookupTableAccount[]> {
  const res = await conn.getProgramAccounts(AddressLookupTableProgram.programId, { filters: [{ memcmp: { offset: 22, bytes: authority.toBase58() } }] });
  return res
    .map(({ pubkey, account }) => new AddressLookupTableAccount({ key: pubkey, state: AddressLookupTableAccount.deserialize(account.data) }))
    .filter((t) => BigInt(t.state.deactivationSlot.toString()) === LIVE)
    .sort((a, b) => a.key.toBase58().localeCompare(b.key.toBase58()));
}
const extend = (authority: Keypair, table: PublicKey, addresses: PublicKey[]) =>
  AddressLookupTableProgram.extendLookupTable({ payer: authority.publicKey, authority: authority.publicKey, lookupTable: table, addresses });
/** Make sure every `wanted` address sits in one of our tables: fill whatever has room, open a new table when they are all
 *  full. A v0 message only references the tables that hold addresses it uses, so clients can always pass the whole set. */
export async function ensureAlts(conn: Connection, authority: Keypair, wanted: PublicKey[], log = console.log): Promise<AddressLookupTableAccount[]> {
  const tables = await listAlts(conn, authority.publicKey);
  const have = new Set(tables.flatMap((t) => t.state.addresses.map((k) => k.toBase58())));
  const missing = dedupe(wanted).filter((k) => !have.has(k.toBase58()));
  if (!missing.length) return tables;
  for (const t of tables) {
    let room = ALT_MAX - t.state.addresses.length;
    while (room > 0 && missing.length) {
      const chunk = missing.splice(0, Math.min(20, room));
      room -= chunk.length;
      log(`extending ${t.key.toBase58().slice(0, 6)} with ${chunk.length} accounts`, await sendIxs(conn, authority, [extend(authority, t.key, chunk)]));
    }
  }
  while (missing.length) {
    const slot = await conn.getSlot("finalized");
    const [ix, address] = AddressLookupTableProgram.createLookupTable({ authority: authority.publicKey, payer: authority.publicKey, recentSlot: slot });
    log("creating lookup table", address.toBase58(), await sendIxs(conn, authority, [ix]));
    let room = ALT_MAX;
    while (room > 0 && missing.length) {
      const chunk = missing.splice(0, Math.min(20, room));
      room -= chunk.length;
      log(`extending ${address.toBase58().slice(0, 6)} with ${chunk.length} accounts`, await sendIxs(conn, authority, [extend(authority, address, chunk)]));
    }
  }
  await new Promise((r) => setTimeout(r, 1500)); // a table is usable one slot after its last extension
  return listAlts(conn, authority.publicKey);
}

/** Creates the table if `existing` is null, then appends any of `wanted` it doesn't hold yet. Returns the address. */
export async function ensureAlt(conn: Connection, authority: Keypair, existing: PublicKey | null, wanted: PublicKey[], log = console.log): Promise<PublicKey> {
  let addr = existing;
  if (!addr) {
    const slot = await conn.getSlot("finalized");
    const [ix, address] = AddressLookupTableProgram.createLookupTable({ authority: authority.publicKey, payer: authority.publicKey, recentSlot: slot });
    log("creating lookup table", address.toBase58(), await sendIxs(conn, authority, [ix]));
    addr = address;
  }
  const table = (await conn.getAddressLookupTable(addr)).value;
  const have = new Set((table?.state.addresses ?? []).map((k) => k.toBase58()));
  const missing = dedupe(wanted).filter((k) => !have.has(k.toBase58()));
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const ix = AddressLookupTableProgram.extendLookupTable({ payer: authority.publicKey, authority: authority.publicKey, lookupTable: addr, addresses: chunk });
    log(`extending with ${chunk.length} accounts`, await sendIxs(conn, authority, [ix]));
  }
  return addr;
}
