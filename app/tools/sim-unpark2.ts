import { PublicKey } from "@solana/web3.js";
import { conn, toV0 } from "../src/lib/chain";
import { listVaults, loadVault, withdrawIxs, hookExtras } from "../src/lib/dn";
import { cu } from "../src/lib/hooked";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
const user = new PublicKey("331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (const vt of await listVaults()) {
  const view = await loadVault(vt, null).catch(() => null); if (!view) continue;
  const bal = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(view.v.shareMint, user)).catch(() => null);
  const shares = BigInt(bal?.value.amount ?? "0"); if (shares === 0n) continue;
  const ex = await hookExtras(view.v.downMint, view.v.market, view.m);
  const tx = await toV0([cu(600_000), ...(await withdrawIxs(user, view, shares))], user);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  const down = (sim.value.logs ?? []).filter((l) => /TransferChecked/.test(l)).length;
  console.log("vault", vt.key.toBase58().slice(0, 8), "market", view.v.market.toBase58().slice(0, 8), "extras", ex.length, "sim err:", JSON.stringify(sim.value.err), "transferChecked calls:", down);
  await sleep(1500);
}
