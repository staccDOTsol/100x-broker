import { Connection, PublicKey } from "@solana/web3.js";
import { getExtraAccountMetas } from "@solana/spl-token";
const c = new Connection("https://100x.broker/api/rpc", "confirmed");
const HOOKED = new PublicKey("T8EKHG9mJhwWNAYWisFKvbYynGMvSHP5Fb7kxSDh7cb");
const { markets } = await (await fetch("https://100x.broker/api/markets")).json();
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
for (const m of markets) {
  const a = m.acct; const key = a.key.$p, bear = new PublicKey(a.bearMint.$p);
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), bear.toBuffer()], HOOKED);
  const info = await c.getAccountInfo(pda);
  if (!info) { console.log(key.slice(0,8), "NO META LIST"); continue; }
  const metas = getExtraAccountMetas(info);
  const names = metas.map(em => em.discriminator === 0 ? new PublicKey(em.addressConfig).toBase58() : `seed-based(disc ${em.discriminator})`);
  const expect = [key, a.oracleObs.$p, a.vaultBull.$p, a.vaultBear.$p, TOKEN, a.oraclePool.$p];
  const tag = names.map((n, i) => n === expect[i] ? ["market","obs","vaultBull","vaultBear","tokenProg","oraclePool"][i] : "?"+n.slice(0,6));
  console.log(key.slice(0, 8), "n=", metas.length, tag.join(","), "| client sends 5 then HOOKED → mismatch at idx5:", metas.length > 5);
}
