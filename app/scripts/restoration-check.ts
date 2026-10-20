import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { AddressLookupTableAccount, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { COMPOSER_PROGRAM_ID, DN_PROGRAM_ID, LEGACY_DN_PROGRAM_ID, LEGACY_PROGRAM_IDS, PROGRAM_ID } from "../src/config.js";
import { assertInstructionDeployment, assertTransactionDeployment, deploymentStatus } from "../src/lib/deployment.js";
import { legacyPositions } from "../src/lib/legacy.js";
import { twapNow } from "../src/lib/chain.js";

const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const account = (data: Buffer, owner = loader, executable = false) => ({ data, owner, executable, lamports: 1, rentEpoch: 0 });
const absent = { getAccountInfo: async () => null };
assert.equal((await deploymentStatus(absent)).available, false, "undeployed replacement stays unavailable");
assert.equal((await deploymentStatus({ getAccountInfo: async () => { throw Error("must not read closed program"); } }, LEGACY_PROGRAM_IDS[0])).available, false);
const programDataKey = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], loader)[0];
const programData = Buffer.alloc(36);
programData.writeUInt32LE(2); programDataKey.toBuffer().copy(programData, 4);
const missingCode = { getAccountInfo: async (key: PublicKey) => key.equals(PROGRAM_ID) ? account(programData, loader, true) : null };
assert.equal((await deploymentStatus(missingCode)).available, false, "executable shell without ProgramData is closed");
const code = Buffer.alloc(46); code.writeUInt32LE(3);
const deployed = { getAccountInfo: async (key: PublicKey) => key.equals(PROGRAM_ID) ? account(programData, loader, true) : account(code) };
assert.equal((await deploymentStatus(deployed)).available, true);
assert.equal((await deploymentStatus({ getAccountInfo: async () => account(programData, SystemProgram.programId, true) })).available, false, "unexpected program owner is unavailable");
const wrongData = Buffer.from(programData); PublicKey.unique().toBuffer().copy(wrongData, 4);
assert.equal((await deploymentStatus({ getAccountInfo: async () => account(wrongData, loader, true) })).available, false, "ProgramData must match the canonical PDA");

const ix = (programId: PublicKey, keys: PublicKey[] = []) => new TransactionInstruction({ programId, keys: keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })), data: Buffer.alloc(0) });
await assert.rejects(() => assertInstructionDeployment(absent, [ix(TOKEN_2022_PROGRAM_ID, [LEGACY_PROGRAM_IDS[0]])]), /closed program/);
await assert.rejects(() => assertInstructionDeployment(absent, [ix(PROGRAM_ID)]), /not deployed/);
await assert.rejects(() => assertInstructionDeployment(absent, [ix(DN_PROGRAM_ID)]), /not deployed/);
await assert.rejects(() => assertInstructionDeployment(absent, [ix(COMPOSER_PROGRAM_ID)]), /not deployed/);
await assert.rejects(() => assertInstructionDeployment(absent, [ix(new PublicKey("2qiAsxua4dx5SPRD1CDXeNAKDKRepDQ1rags3vAoZ5fN"))]), /closed program/);
await assertInstructionDeployment(deployed, [ix(PROGRAM_ID)]);
await assertInstructionDeployment(absent, [ix(SystemProgram.programId)]);

const table = new AddressLookupTableAccount({ key: PublicKey.unique(), state: {
  deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0,
  addresses: [LEGACY_PROGRAM_IDS[1]],
} });
const tx = new VersionedTransaction(new TransactionMessage({
  payerKey: PublicKey.unique(), recentBlockhash: PublicKey.default.toBase58(),
  instructions: [ix(TOKEN_2022_PROGRAM_ID, [LEGACY_PROGRAM_IDS[1]])],
}).compileToV0Message([table]));
assert.equal(tx.message.addressTableLookups.length, 1);
await assert.rejects(() => assertTransactionDeployment({
  ...absent, getAddressLookupTable: async () => ({ value: table }),
} as unknown as Connection, tx), /closed program/, "closed hooks in lookup tables are blocked before signing");

const owner = PublicKey.unique(), legacyMint = PublicKey.unique(), activeMint = PublicKey.unique(), receiptMint = PublicKey.unique(), oldVault = PublicKey.unique();
const mintData = (program: PublicKey) => {
  const data = Buffer.alloc(234);
  data[44] = 6; data[45] = 1; data[165] = 1;
  data.writeUInt16LE(14, 166); data.writeUInt16LE(64, 168); program.toBuffer().copy(data, 202);
  return account(data, TOKEN_2022_PROGRAM_ID);
};
const token = (mint: PublicKey, amount: bigint, program = TOKEN_2022_PROGRAM_ID) => {
  const data = Buffer.alloc(165); mint.toBuffer().copy(data); owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64); data[108] = 1;
  return { pubkey: PublicKey.unique(), account: account(data, program) };
};
const receipt = Buffer.alloc(82); receipt.writeUInt32LE(1); oldVault.toBuffer().copy(receipt, 4); receipt[44] = 9; receipt[45] = 1;
const vault = Buffer.alloc(488); vault.write("dnvault1"); receiptMint.toBuffer().copy(vault, 136);
const legacyReader = {
  getTokenAccountsByOwner: async (_owner: PublicKey, { programId }: { programId: PublicKey }) => ({
    value: programId.equals(TOKEN_2022_PROGRAM_ID) ? [token(legacyMint, 2n), token(legacyMint, 3n), token(activeMint, 7n)] : [token(receiptMint, 11n, TOKEN_PROGRAM_ID)],
  }),
  getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((key) =>
    key.equals(receiptMint) ? account(receipt, TOKEN_PROGRAM_ID)
    : key.equals(oldVault) ? account(vault, LEGACY_DN_PROGRAM_ID)
    : mintData(key.equals(legacyMint) ? LEGACY_PROGRAM_IDS[0] : PROGRAM_ID)),
} as unknown as Connection;
const holdings = await legacyPositions(legacyReader, owner);
assert.equal(holdings.length, 2);
assert.equal(holdings[0].amount, 5n, "legacy balances include non-ATAs and aggregate by mint");
assert.equal(holdings[0].decimals, 6);
assert.equal(holdings[1].amount, 11n, "old yield receipts remain visible");
assert.equal(holdings[1].programId, LEGACY_DN_PROGRAM_ID.toBase58());

const ring = Buffer.alloc(51 + 100 * 44);
ring.writeUInt16LE(1, 17);
ring.writeUInt32LE(99, 51); ring.writeBigInt64LE(990n, 55);
ring.writeUInt32LE(100, 95); ring.writeBigInt64LE(1000n, 99);
const frozen = twapNow(ring, [], 1, { now: 10000, tick: 999 });
assert.equal(frozen.endTs, 100, "two-observation stale ring never samples spot");
assert.equal(frozen.twapQ32, 10n << 32n);
assert.equal(twapNow(ring, [], 150, { now: 10000, tick: 999 }).endTs, 10000, "long-window behavior is unchanged");
console.log("Restoration checks passed: undeployed/closed code, upgradeable ProgramData, Hooked/DN/Composer guards, lookup-table hooks, legacy holdings, and two-observation mirror.");
