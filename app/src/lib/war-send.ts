import type { VersionedTransaction } from "@solana/web3.js";

export type WarTransactionSigner = {
  signAllTransactions?: (txs: VersionedTransaction[]) => Promise<VersionedTransaction[]>;
  signTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
};

export type WarSendProgress = { confirmed: number; total: number; submitted: boolean };

/** A failed submission may still land after a timeout; keep its progress with the error. */
export class WarSendError extends Error {
  readonly confirmed: number;
  readonly total: number;
  readonly submitted: boolean;

  constructor(message: string, progress: WarSendProgress, cause: unknown) {
    super(message, { cause });
    this.name = "WarSendError";
    this.confirmed = progress.confirmed;
    this.total = progress.total;
    this.submitted = progress.submitted;
  }
}

/** Sign the whole ordered batch once, then await each submission before sending the next. */
export async function signAndSendWarTransactions(
  txs: readonly VersionedTransaction[],
  wallet: WarTransactionSigner,
  send: (raw: Uint8Array) => Promise<unknown>,
  onProgress?: (progress: WarSendProgress) => void,
): Promise<void> {
  const progress: WarSendProgress = { confirmed: 0, total: txs.length, submitted: false };
  const report = () => onProgress?.({ ...progress });
  try {
    if (!txs.length) throw new Error("no transactions were built for that move");
    if (txs.length > 1 && !wallet.signAllTransactions) throw new Error("this move needs a wallet that supports signing all transactions at once");
    if (!wallet.signAllTransactions && !wallet.signTransaction) throw new Error("this wallet can't sign transactions");

    const signed = wallet.signAllTransactions
      ? await wallet.signAllTransactions([...txs])
      : [await wallet.signTransaction!(txs[0])];
    if (signed.length !== txs.length) throw new Error("the wallet didn't sign every transaction");
    report();
    for (const tx of signed) {
      const raw = tx.serialize();
      // Record the attempt before calling the sender, including when it throws or times out.
      progress.submitted = true;
      report();
      await send(raw);
      progress.confirmed += 1;
      report();
    }
  } catch (cause) {
    throw new WarSendError(cause instanceof Error ? cause.message : String(cause), progress, cause);
  }
}
