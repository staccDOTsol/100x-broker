// Transaction v1 (SIMD-0385, live on mainnet since slot 447,120,000): up to 4096 bytes, every account inline (no lookup
// tables), compute limit and priority fee in the header instead of ComputeBudget instructions. Built with @solana/kit;
// instructions come in as web3.js TransactionInstructions so the existing builders are reused as they are.
import { AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction, setTransactionMessageComputeUnitLimit, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, setTransactionMessageLoadedAccountsDataSizeLimit, setTransactionMessagePriorityFeeLamports, type Blockhash } from "@solana/kit";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";

export const V1_MAX_BYTES = 4096;
export const V1_MAX_LOADED_BYTES = 64 * 1024 * 1024;

const role = (k: { isSigner: boolean; isWritable: boolean }) =>
  k.isSigner ? (k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
const toKit = (ix: TransactionInstruction) => ({
  programAddress: address(ix.programId.toBase58()),
  accounts: ix.keys.map((k) => ({ address: address(k.pubkey.toBase58()), role: role(k) })),
  data: new Uint8Array(ix.data),
});

/** An unsigned v1 transaction: `messageBytes` is what every signer signs; `signatures` lists who must, in order. */
export function compileV1(p: { payer: PublicKey; ixs: TransactionInstruction[]; blockhash: string; lastValidBlockHeight: number; computeUnitLimit?: number; priorityFeeLamports?: bigint; loadedAccountsDataSizeLimit?: number }) {
  // kit 7.1 builds and encodes v1 at runtime but its public types still stop at v0
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let m: any = createTransactionMessage({ version: 1 } as any);
  m = setTransactionMessageFeePayer(address(p.payer.toBase58()), m);
  m = setTransactionMessageLifetimeUsingBlockhash({ blockhash: p.blockhash as Blockhash, lastValidBlockHeight: BigInt(p.lastValidBlockHeight) }, m);
  m = appendTransactionMessageInstructions(p.ixs.map(toKit), m);
  if (p.computeUnitLimit) m = setTransactionMessageComputeUnitLimit(p.computeUnitLimit, m);
  if (p.priorityFeeLamports) m = setTransactionMessagePriorityFeeLamports(p.priorityFeeLamports, m);
  // unlike v0 (64 MiB), an unset v1 limit is too small for big programs like pump's: always say how much may load
  m = setTransactionMessageLoadedAccountsDataSizeLimit(p.loadedAccountsDataSizeLimit ?? V1_MAX_LOADED_BYTES, m);
  return compileTransaction(m as any) as unknown as { messageBytes: Uint8Array; signatures: Record<string, Uint8Array | null> };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
export type CompiledV1 = ReturnType<typeof compileV1>;

/** Attach signatures (64 bytes each, keyed by base58 address) and return the wire bytes as base64. */
export function wireV1(tx: CompiledV1, sigs: Record<string, Uint8Array>) {
  const signatures = { ...tx.signatures } as Record<string, Uint8Array | null>;
  for (const [k, s] of Object.entries(sigs)) if (k in signatures) signatures[k] = s;
  return getBase64EncodedWireTransaction({ ...tx, signatures } as never);
}
