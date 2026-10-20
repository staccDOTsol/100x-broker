import { PublicKey, Transaction, VersionedTransaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { CLOSED_PROGRAM_IDS, COMPOSER_PROGRAM_ID, DN_PROGRAM_ID, PROGRAM_ID } from "../config.js";

const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const LEGACY_UNAVAILABLE = "This position belongs to a closed program. Trading and withdrawals are unavailable. A new deployment cannot unlock its assets.";
export type DeploymentStatus = { programId: string; available: boolean; reason: string | null };
type AccountReader = Pick<Connection, "getAccountInfo">;

/** An upgradeable Program account can remain executable after its ProgramData was closed. Check both. */
export async function deploymentStatus(connection: AccountReader, program = PROGRAM_ID): Promise<DeploymentStatus> {
  const programId = program.toBase58();
  if (CLOSED_PROGRAM_IDS.has(programId)) return { programId, available: false, reason: "The previous program is closed. Trading is unavailable." };
  const account = await connection.getAccountInfo(program);
  if (!account?.executable) return { programId, available: false, reason: "The replacement program is not deployed. Trading is unavailable." };
  const expectedData = PublicKey.findProgramAddressSync([program.toBuffer()], UPGRADEABLE_LOADER)[0];
  if (!account.owner.equals(UPGRADEABLE_LOADER) || account.data.length !== 36 || account.data.readUInt32LE(0) !== 2
    || !new PublicKey(account.data.subarray(4, 36)).equals(expectedData)) {
    return { programId, available: false, reason: "Program state could not be verified. Trading is unavailable." };
  }
  const data = await connection.getAccountInfo(expectedData);
  if (!data || !data.owner.equals(UPGRADEABLE_LOADER) || data.data.length <= 45 || data.data.readUInt32LE(0) !== 3) {
    return { programId, available: false, reason: "Program code is unavailable. Trading is unavailable." };
  }
  return { programId, available: true, reason: null };
}

export async function assertProgramAvailable(connection: AccountReader, program = PROGRAM_ID) {
  const status = await deploymentStatus(connection, program);
  if (!status.available) throw new Error(status.reason!);
}

export function assertNoClosedPrograms(keys: PublicKey[]) {
  if (keys.some((k) => CLOSED_PROGRAM_IDS.has(k.toBase58()))) throw new Error(LEGACY_UNAVAILABLE);
}

export async function assertInstructionDeployment(connection: AccountReader, instructions: TransactionInstruction[]) {
  // Include accounts as well as top-level instructions: transfer hooks are invoked through Token-2022 / DBC.
  const keys = instructions.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]);
  assertNoClosedPrograms(keys);
  for (const program of [PROGRAM_ID, DN_PROGRAM_ID, COMPOSER_PROGRAM_ID]) {
    if (keys.some((k) => k.equals(program))) await assertProgramAvailable(connection, program);
  }
}

/** Last check before a wallet sees any transaction, including unsigned transactions returned by APIs. */
export async function assertTransactionDeployment(connection: Connection, tx: Transaction | VersionedTransaction) {
  let keys: PublicKey[];
  if (tx instanceof Transaction) {
    keys = tx.instructions.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]);
  } else {
    const tables = await Promise.all(tx.message.addressTableLookups.map(async (lookup) => {
      const { value } = await connection.getAddressLookupTable(lookup.accountKey);
      if (!value) throw new Error("Transaction lookup table is unavailable. Refresh before trying again.");
      return value;
    }));
    const accounts = tx.message.getAccountKeys({ addressLookupTableAccounts: tables });
    keys = Array.from({ length: accounts.length }, (_, i) => accounts.get(i)!);
  }
  assertNoClosedPrograms(keys);
  for (const program of [PROGRAM_ID, DN_PROGRAM_ID, COMPOSER_PROGRAM_ID]) {
    if (keys.some((k) => k.equals(program))) await assertProgramAvailable(connection, program);
  }
}
