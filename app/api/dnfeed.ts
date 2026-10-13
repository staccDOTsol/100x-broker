// /api/dnfeed?v=<vault> -> one dnvault's story, newest first: born / parked / unparked / keeper rebalances.
// Classified by the dnvault instructions in each tx (tag = first data byte), bounties from the keeper's pre/post balance.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Connection, PublicKey, type ParsedInstruction, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction } from "@solana/web3.js";
import bs58 from "bs58";

const DN_PROGRAM = "2ZbjE44nSh3AmpREg4sdNMViBLAzAEtFKYDn1XdqMzEj";
const VAULT_LEN = 488;
/** Inner programs the keeper is allowed to forward through `act`, by the name the feed calls them. */
const TARGETS: Record<string, string> = {
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium",
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "DBC hedge",
  T8EKHG9mJhwWNAYWisFKvbYynGMvSHP5Fb7kxSDh7cb: "redeem",
  SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY: "stake pool",
};

const conn = () => {
  const u = process.env.HELIUS_RPC_URL;
  if (!u) throw new Error("HELIUS_RPC_URL not configured");
  return new Connection(u, "confirmed");
};

export type DnEv = {
  sig: string;
  ts: number;
  kind: "born" | "deposit" | "withdraw" | "rebalance" | "bound";
  actor?: string; // born: creator · deposit/withdraw: the user
  lamports?: string; // deposit: SOL parked
  shares?: string; // deposit: receipts minted · withdraw: receipts burned
  pct?: number; // withdraw: share of the user's receipts, 0..1
  keeper?: string; // rebalance
  bounty?: string; // rebalance: lamports the keeper walked away with (fee it paid added back)
  acts?: number; // rebalance: forwarded CPIs in the tx
  targets?: string[]; // rebalance: distinct inner programs, by name
};

type Ix = ParsedInstruction | PartiallyDecodedInstruction;
const allIxs = (tx: ParsedTransactionWithMeta): Ix[] => [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
const isOurs = (ix: Ix): ix is PartiallyDecodedInstruction => !("parsed" in ix) && ix.programId.toBase58() === DN_PROGRAM;

export function classify(tx: ParsedTransactionWithMeta, shareMint: string): DnEv | null {
  if (!tx.meta || tx.meta.err) return null;
  const sig = tx.transaction.signatures[0];
  const ts = tx.blockTime ?? 0;
  const ours = allIxs(tx)
    .filter(isOurs)
    .map((ix) => ({ ix, data: Buffer.from(bs58.decode(ix.data)) }))
    .filter((x) => x.data.length > 0);
  if (!ours.length) return null;
  const byTag = (t: number) => ours.filter((x) => x.data[0] === t);
  const u64 = (d: Buffer) => (d.length >= 9 ? d.readBigUInt64LE(1) : 0n);
  const keys = tx.transaction.message.accountKeys;

  const settle = byTag(4)[0];
  if (settle) {
    const keeper = settle.ix.accounts[1]?.toBase58() ?? keys[0].pubkey.toBase58();
    const i = keys.findIndex((k) => k.pubkey.toBase58() === keeper);
    const gained = i >= 0 ? BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]) : 0n;
    const bounty = gained + (i === 0 ? BigInt(tx.meta.fee) : 0n);
    const acts = byTag(3);
    const targets = [...new Set(acts.map((a) => a.ix.accounts[2]?.toBase58() ?? "").map((p) => TARGETS[p] ?? (p ? `${p.slice(0, 4)}…` : "?")))];
    return { sig, ts, kind: "rebalance", keeper, bounty: bounty.toString(), acts: acts.length, targets };
  }
  const dep = byTag(1)[0];
  if (dep) {
    const actor = dep.ix.accounts[0].toBase58();
    const minted = allIxs(tx).find((ix): ix is ParsedInstruction => "parsed" in ix && (ix.parsed?.type === "mintTo" || ix.parsed?.type === "mintToChecked") && ix.parsed?.info?.mint === shareMint);
    const shares = minted ? String(minted.parsed.info.tokenAmount?.amount ?? minted.parsed.info.amount ?? "") : undefined;
    return { sig, ts, kind: "deposit", actor, lamports: u64(dep.data).toString(), ...(shares ? { shares } : {}) };
  }
  const wd = byTag(2)[0];
  if (wd) {
    const actor = wd.ix.accounts[0].toBase58();
    const shares = u64(wd.data);
    const pre = (tx.meta.preTokenBalances ?? []).find((b) => b.mint === shareMint && b.owner === actor);
    const had = pre ? BigInt(pre.uiTokenAmount.amount) : 0n;
    const pct = had > 0n ? Math.min(1, Number(shares) / Number(had)) : undefined;
    return { sig, ts, kind: "withdraw", actor, shares: shares.toString(), ...(pct !== undefined ? { pct } : {}) };
  }
  const born = byTag(0)[0];
  if (born) return { sig, ts, kind: "born", actor: born.ix.accounts[0].toBase58() };
  if (byTag(7).length) return { sig, ts, kind: "bound", actor: keys[0].pubkey.toBase58() };
  return null;
}

export async function vaultFeed(vault: PublicKey, limit = 60): Promise<DnEv[]> {
  const c = conn();
  const [info, sigs] = await Promise.all([c.getAccountInfo(vault), c.getSignaturesForAddress(vault, { limit })]);
  if (!info || info.data.length !== VAULT_LEN || info.owner.toBase58() !== DN_PROGRAM) throw new Error("not a vault");
  const shareMint = new PublicKey(info.data.subarray(136, 168)).toBase58();
  const ok = sigs.filter((s) => !s.err).map((s) => s.signature);
  const txs = await c.getParsedTransactions(ok, { maxSupportedTransactionVersion: 0 });
  return txs
    .map((t) => (t ? classify(t, shareMint) : null))
    .filter((e): e is DnEv => !!e)
    .sort((a, b) => b.ts - a.ts);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const v = String(req.query.v ?? "");
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return res.status(400).json({ error: "bad vault" });
    const events = await vaultFeed(new PublicKey(v));
    res.setHeader("cache-control", "public, max-age=5, s-maxage=8, stale-while-revalidate=60").json({ events, at: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "dnfeed failed" });
  }
}
