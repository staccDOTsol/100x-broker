import { getTransferHook, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import { type Connection, PublicKey } from "@solana/web3.js";
import { LEGACY_DN_PROGRAM_IDS, LEGACY_PROGRAM_IDS } from "../config.js";
import { tokenMetadata } from "./chain.js";

export type LegacyPosition = { mint: string; programId: string; symbol: string; decimals: number; amount: bigint };

/** Read the wallet's actual accounts, including non-ATAs. Never price closed-program assets as withdrawable funds. */
async function legacyHookedPositions(connection: Connection, owner: PublicKey): Promise<LegacyPosition[]> {
  const accounts = await connection.getTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID });
  const balances = new Map<string, bigint>();
  for (const row of accounts.value) {
    const account = unpackAccount(row.pubkey, row.account, TOKEN_2022_PROGRAM_ID);
    if (account.amount > 0n) balances.set(account.mint.toBase58(), (balances.get(account.mint.toBase58()) ?? 0n) + account.amount);
  }
  const mints = [...balances.keys()].map((key) => new PublicKey(key));
  const positions: LegacyPosition[] = [];
  for (let offset = 0; offset < mints.length; offset += 100) {
    const batch = mints.slice(offset, offset + 100);
    const infos = await connection.getMultipleAccountsInfo(batch);
    infos.forEach((info, i) => {
      if (!info) throw new Error("An existing holding could not be read. Try refreshing.");
      const mint = unpackMint(batch[i], info, TOKEN_2022_PROGRAM_ID);
      const hook = getTransferHook(mint);
      if (!hook || !LEGACY_PROGRAM_IDS.some((program) => program.equals(hook.programId))) return;
      const meta = tokenMetadata(info.data);
      positions.push({
        mint: batch[i].toBase58(), programId: hook.programId.toBase58(),
        symbol: meta.symbol || meta.name || batch[i].toBase58().slice(0, 8),
        decimals: mint.decimals, amount: balances.get(batch[i].toBase58())!,
      });
    });
  }
  return positions;
}

/** Closed DN receipts are ordinary SPL tokens whose mint authority is their old vault PDA. */
async function legacyYieldPositions(connection: Connection, owner: PublicKey): Promise<LegacyPosition[]> {
  const accounts = await connection.getTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID });
  const balances = new Map<string, bigint>();
  for (const row of accounts.value) {
    const account = unpackAccount(row.pubkey, row.account, TOKEN_PROGRAM_ID);
    if (account.amount > 0n) balances.set(account.mint.toBase58(), (balances.get(account.mint.toBase58()) ?? 0n) + account.amount);
  }
  const keys = [...balances.keys()].map((key) => new PublicKey(key));
  const positions: LegacyPosition[] = [];
  for (let offset = 0; offset < keys.length; offset += 100) {
    const batch = keys.slice(offset, offset + 100);
    const infos = await connection.getMultipleAccountsInfo(batch);
    const mints = infos.map((info, i) => {
      if (!info) throw new Error("An existing receipt could not be read. Try refreshing.");
      return unpackMint(batch[i], info, TOKEN_PROGRAM_ID);
    }).filter((mint) => mint.mintAuthority);
    if (!mints.length) continue;
    const authorities = await connection.getMultipleAccountsInfo(mints.map((mint) => mint.mintAuthority!));
    authorities.forEach((vault, i) => {
      const mint = mints[i];
      if (!vault || !LEGACY_DN_PROGRAM_IDS.some((program) => vault.owner.equals(program)) || vault.data.length !== 488
        || vault.data.subarray(0, 8).toString() !== "dnvault1"
        || !new PublicKey(vault.data.subarray(136, 168)).equals(mint.address)) return;
      positions.push({
        mint: mint.address.toBase58(), programId: vault.owner.toBase58(),
        symbol: "Yield vault receipt", decimals: mint.decimals, amount: balances.get(mint.address.toBase58())!,
      });
    });
  }
  return positions;
}

export async function legacyPositions(connection: Connection, owner: PublicKey): Promise<LegacyPosition[]> {
  return (await Promise.all([legacyHookedPositions(connection, owner), legacyYieldPositions(connection, owner)])).flat();
}
