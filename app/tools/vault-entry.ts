import { PublicKey } from "@solana/web3.js";
import { conn } from "../src/lib/chain";
import { listVaults, loadVault } from "../src/lib/dn";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
const user = "331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth";
for (const vt of await listVaults()) {
  const view = await loadVault(vt, null).catch(() => null); if (!view) continue;
  const bal = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(view.v.shareMint, new PublicKey(user))).catch(() => null);
  const held = Number(bal?.value.amount ?? 0) / 1e9;
  const r = await fetch(`https://100x.broker/api/dnfeed?v=${vt.key.toBase58()}`); const ev = (await r.json()).events ?? [];
  let L = 0, S = 0; for (const e of ev) if (e.kind === "deposit" && e.actor === user && e.shares) { L += Number(e.lamports) / 1e9; S += Number(e.shares) / 1e9; }
  const entry = S > 0 ? L / S : null;
  const sp = view.x.sharePrice;
  console.log(`${view.underlying?.symbol ?? vt.key.toBase58().slice(0, 6)}`.padEnd(8), `share price ${sp.toFixed(4)}`, `vault yield ${((sp - 1) * 100).toFixed(1)}%`, entry ? `| your avg entry ${entry.toFixed(4)} → ${((sp / entry - 1) * 100).toFixed(2)}%` : "| no deposits from you", `| you hold ${held.toFixed(3)} shares`);
}
