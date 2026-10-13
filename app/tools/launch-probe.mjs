import { Connection, PublicKey } from "@solana/web3.js";
import { inflateSync } from "node:zlib";
const conn = new Connection("https://100x.broker/api/rpc", "confirmed");
const PROG = new PublicKey("moontUzsdepotRGe5xsfip7vLPTJnVuafqdUWexVnPM");
const LAUNCH = new PublicKey("6wot8WTk5WGoUQrSbFaTzMasUutYBfQDG3pNan3LG9sU");
// anchor IDL account
const [base] = PublicKey.findProgramAddressSync([], PROG);
const idlAddr = await PublicKey.createWithSeed(base, "anchor:idl", PROG);
const idlAcc = await conn.getAccountInfo(idlAddr);
if (idlAcc) {
  const data = idlAcc.data; // 8 disc + 32 authority + 4 len + zlib
  const len = data.readUInt32LE(40);
  const idl = JSON.parse(inflateSync(data.subarray(44, 44 + len)).toString());
  const ix = idl.instructions.map(i => ({ name: i.name, disc: i.discriminator, accounts: i.accounts.map(a => a.name + (a.signer ? "*" : "") + (a.writable ? "!" : "")), args: i.args.map(a => a.name + ":" + JSON.stringify(a.type)) }));
  console.log("IDL", idl.metadata?.name, idl.metadata?.version);
  const fund = idl.instructions.find(i => i.name === "fund");
  console.log("FUND", JSON.stringify({ disc: fund.discriminator, accounts: fund.accounts.map(a => ({ n: a.name, pda: a.pda, addr: a.address })) }));
  console.log("QUOTE/launch type fields:");
  const launchT = idl.types?.find(t => /launch$/i.test(t.name)); if (launchT) console.log("Launch fields:", launchT.type.fields.map(f => f.name + ":" + JSON.stringify(f.type)).join(" | "));
} else console.log("no anchor IDL at", idlAddr.toBase58());
// recent txs touching the launch
const sigs = await conn.getSignaturesForAddress(LAUNCH, { limit: 4 });
for (const s of sigs.slice(0, 2)) {
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) continue;
  const msg = tx.transaction.message;
  const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses }).staticAccountKeys.map(k => k.toBase58());
  const all = [...keys, ...(tx.meta?.loadedAddresses?.writable ?? []).map(k=>k.toBase58()), ...(tx.meta?.loadedAddresses?.readonly ?? []).map(k=>k.toBase58())];
  console.log("\nTX", s.signature.slice(0, 20), new Date((s.blockTime ?? 0) * 1000).toISOString(), "err", !!tx.meta?.err);
  for (const ix of msg.compiledInstructions) {
    const pid = all[ix.programIdIndex];
    const data = Buffer.from(ix.data);
    if (pid !== PROG.toBase58()) { console.log(" ix prog", pid.slice(0, 10)); continue; }
    console.log(" MOONT ix disc", [...data.subarray(0, 8)], "amount", data.length >= 16 ? data.readBigUInt64LE(8).toString() : "-");
    console.log("  accounts:", JSON.stringify(ix.accountKeyIndexes.map(i => all[i])));
  }
  console.log(" logs:", (tx.meta?.logMessages ?? []).filter(l => /Instruction:|Program moont/.test(l)).slice(0, 8));
}
