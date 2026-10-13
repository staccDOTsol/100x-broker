import { Connection, PublicKey } from "@solana/web3.js";
const c = new Connection(process.env.RPC ?? "https://100x.broker/api/rpc", "confirmed");
const W = new PublicKey(process.argv[2] ?? "331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth");
const OURS = "T8EKHG9mJhwWNAYWisFKvbYynGMvSHP5Fb7kxSDh7cb", MOONT = "moontUzsdepotRGe5xsfip7vLPTJnVuafqdUWexVnPM", JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const sigs = await c.getSignaturesForAddress(W, { limit: Number(process.env.N ?? 12) });
for (const s of sigs) {
  const tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) continue;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  const progs = tx.transaction.message.compiledInstructions.map((ix) => keys.get(ix.programIdIndex)?.toBase58() ?? "?");
  const tags = [progs.includes(OURS) ? "100x" : "", progs.includes(JUP) ? "JUP" : "", progs.includes(MOONT) ? "FUND" : ""].filter(Boolean).join("+");
  const err = tx.meta?.err ? JSON.stringify(tx.meta.err) : "ok";
  const logs = (tx.meta?.logMessages ?? []).filter((l) => /Error|failed|Instruction: (Fund|Redeem|Swap|Route)/.test(l)).slice(0, 4).map((l) => l.replace(/^Program (log: )?/, "")).join(" | ");
  console.log(new Date((s.blockTime ?? 0) * 1000).toISOString().slice(11, 19), s.signature.slice(0, 16), err.padEnd(4), (tags || "-").padEnd(13), logs.slice(0, 220));
}
