import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection("https://100x.broker/api/rpc", "confirmed");
const PROG = new PublicKey("moontUzsdepotRGe5xsfip7vLPTJnVuafqdUWexVnPM");
const LAUNCH = new PublicKey("6wot8WTk5WGoUQrSbFaTzMasUutYBfQDG3pNan3LG9sU");
const funder = new PublicKey("331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth");
const want = "J9g4pTLry9Mb9bTkyr4yThUidALhR57uoV1evp66GKQP";
for (const seed of ["funding_record", "funding-record", "fundingRecord", "funding", "record"]) {
  for (const order of [[LAUNCH, funder], [funder, LAUNCH]]) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from(seed), ...order.map(k => k.toBuffer())], PROG);
    if (pda.toBase58() === want) console.log("SEEDS:", seed, order === undefined ? "" : (order[0].equals(LAUNCH) ? "launch,funder" : "funder,launch"));
  }
}
const [ea] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PROG); console.log("eventAuthority", ea.toBase58());
const acc = await conn.getParsedAccountInfo(new PublicKey("BgfAes9oQmYS6sa2LefzNwdkAA1mwTq9iDZxVDhaxKDZ"));
console.log("funderQuoteAccount mint:", acc.value?.data?.parsed?.info?.mint);
const vault = await conn.getParsedAccountInfo(new PublicKey("GSMtPgAw6CBt38AXwpGSaxrrcpSYTyNNMQdQkrNgHWhG"));
console.log("launchQuoteVault mint/owner:", vault.value?.data?.parsed?.info?.mint, vault.value?.data?.parsed?.info?.owner);
