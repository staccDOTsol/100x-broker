import { PublicKey } from "@solana/web3.js";
import { conn, toV0 } from "../src/lib/chain";
import { listVaults, loadVault, withdrawIxs, hookExtras } from "../src/lib/dn";
import * as dn from "../src/lib/dn";
import { cu } from "../src/lib/hooked";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
const user = new PublicKey("331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth");
const vaults = await listVaults();
for (const vt of vaults) {
  const key = vt.key;
  const view = await loadVault(vt, null).catch((e) => (console.log("load failed", String(e).slice(0, 80)), null));
  if (!view) continue;
  const share = getAssociatedTokenAddressSync(view.v.shareMint, user);
  const bal = await conn.getTokenAccountBalance(share).catch(() => null);
  const shares = BigInt(bal?.value.amount ?? "0");
  if (shares === 0n) continue;
  const ex = await hookExtras(view.v.downMint, view.v.market, view.m);
  console.log("vault", key.toBase58().slice(0, 8), "market", view.v.market.toBase58().slice(0, 8), "shares", shares.toString(), "hook extras:", ex.length, ex.map(e => e.pubkey.toBase58().slice(0, 6)).join(","));
  const tx = await toV0([cu(600_000), ...(await withdrawIxs(user, view, shares))], user);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  console.log("  sim err:", JSON.stringify(sim.value.err), "cu", sim.value.unitsConsumed);
  for (const l of sim.value.logs ?? []) if (/failed|Error|rror/.test(l)) console.log("   ", l.slice(0, 150));
}
