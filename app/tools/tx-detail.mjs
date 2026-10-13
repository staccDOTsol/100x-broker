import { Connection, PublicKey } from "@solana/web3.js";
const c = new Connection("https://100x.broker/api/rpc", "confirmed");
const W = new PublicKey("331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth");
const sigs = (await c.getSignaturesForAddress(W, { limit: 4 })).map(s => s.signature);
for (const sig of sigs) {
  const tx = await c.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  const progs = [...new Set(tx.transaction.message.compiledInstructions.map(ix => keys.get(ix.programIdIndex).toBase58().slice(0, 8)))];
  const idx = keys.staticAccountKeys.findIndex(k => k.equals(W));
  const dSol = (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / 1e9;
  console.log(sig.slice(0, 12), "progs", progs.join(","), "SOL delta", dSol.toFixed(4), "ixs", tx.transaction.message.compiledInstructions.length);
}
