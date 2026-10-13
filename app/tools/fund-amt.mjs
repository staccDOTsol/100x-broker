import { Connection } from "@solana/web3.js";
const c = new Connection("https://100x.broker/api/rpc", "confirmed");
const MOONT = "moontUzsdepotRGe5xsfip7vLPTJnVuafqdUWexVnPM";
for (const sig of process.argv.slice(2)) {
  const tx = await c.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  for (const ix of tx.transaction.message.compiledInstructions) {
    if (keys.get(ix.programIdIndex)?.toBase58() !== MOONT) continue;
    const d = Buffer.from(ix.data);
    console.log(sig.slice(0, 12), "fund", Number(d.readBigUInt64LE(8)) / 1e6, "USDC", tx.meta?.err ? "ERR" : "ok");
  }
}
