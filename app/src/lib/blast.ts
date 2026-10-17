// Send a batch of already-signed transactions and keep resending each one until it lands, fails, or its blockhash runs out.
// Resending the same signed bytes can never land twice (same signature). The first send of each runs the preflight check, so a
// transaction that can't work fails at once with its reason instead of being retried for a minute.
import type { Connection, VersionedTransaction } from "@solana/web3.js";
import { sendFresh } from "./chain";

export type BlastState = "sending" | "done" | "failed";
export async function blast(
  conn: Connection,
  txs: VersionedTransaction[],
  lastValidBlockHeight: number,
  on: (i: number, s: BlastState, why?: string) => void,
): Promise<{ sigs: (string | null)[]; ok: boolean[] }> {
  const sigs: (string | null)[] = txs.map(() => null);
  const state: BlastState[] = txs.map(() => "sending");
  const set = (i: number, s: BlastState, why?: string) => {
    state[i] = s;
    on(i, s, why);
  };
  await Promise.all(txs.map(async (tx, i) => {
    on(i, "sending");
    try {
      sigs[i] = await sendFresh(() => conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 }));
    } catch (e) {
      set(i, "failed", e instanceof Error ? e.message : String(e));
    }
  }));
  for (let round = 0; round < 120 && state.some((s) => s === "sending"); round++) {
    await new Promise((r) => setTimeout(r, 1500));
    const live = state.map((s, i) => (s === "sending" ? i : -1)).filter((i) => i >= 0);
    const st = (await conn.getSignatureStatuses(live.map((i) => sigs[i]!)).catch(() => ({ value: [] as null[] }))).value;
    live.forEach((i, k) => {
      const v = st[k];
      if (v?.err) set(i, "failed", JSON.stringify(v.err));
      else if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") set(i, "done");
    });
    const still = state.map((s, i) => (s === "sending" ? i : -1)).filter((i) => i >= 0);
    if (!still.length) break;
    // past the blockhash's life nothing more can land; if the height can't be read this round, just keep resending
    const height = await conn.getBlockHeight("confirmed").catch(() => 0);
    if (height > lastValidBlockHeight) {
      for (const i of still) set(i, "failed", "expired before it landed");
      break;
    }
    // not seen yet: push the same bytes again
    await Promise.all(still.map((i) => conn.sendRawTransaction(txs[i].serialize(), { skipPreflight: true, maxRetries: 0 }).catch(() => null)));
  }
  return { sigs, ok: state.map((s) => s === "done") };
}
