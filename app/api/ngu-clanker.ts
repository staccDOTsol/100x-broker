// /api/ngu-clanker — what the cranker on Fly ("clanker") just did, newest first: crank sweeps (tax burned, NGU swapped
// into Fr28, liquidity added), epoch syncs of the stake pool, and every not-a-presale fill or refund. Also SOL arriving
// at the presale address, the event that wakes it. Read from the two wallets' signatures; each transaction is parsed
// once per warm instance and kept.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { PublicKey, type ParsedInstruction, type ParsedTransactionWithMeta, type PartiallyDecodedInstruction } from "@solana/web3.js";
import { NGU } from "../src/ngu.js";
import { memo } from "./_lib/memo.js";
import { history, retry } from "./_lib/nguHistory.js";

export type ClankerEvent = {
  sig: string;
  t: number;
  slot: number;
  kind: "in" | "fill" | "refund" | "crank" | "epoch";
  who: string | null;
  sol: number | null;
  ngu: number | null;
  burned: number | null;
  pool_ngu: number | null; // NGU into (+) or out of (−) the Orca pool
  pool_quote: number | null; // Fr28 into (+, liquidity) or out of (−, bought) the Orca pool
  for: string | null; // fills and refunds: the incoming transfer they answer (from the "ngu-presale:<sig>" memo)
};
type State = { events: ClankerEvent[]; skip: string[] };

const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const KEEP = 40;
const DUST_SOL = 0.0001; // below this, a transfer in is address-poisoning dust: nothing is filled or sent back

function allIxs(tx: ParsedTransactionWithMeta) {
  const ixs: (ParsedInstruction | PartiallyDecodedInstruction)[] = [...tx.transaction.message.instructions];
  for (const inner of tx.meta?.innerInstructions ?? []) ixs.push(...inner.instructions);
  return ixs.filter((ix): ix is ParsedInstruction => "parsed" in ix);
}
/** A Token-2022 instruction of one of these types on the NGU mint. */
function onMint(ix: ParsedInstruction, types: string[]) {
  return ix.programId.toBase58() === T22 && types.includes(ix.parsed?.type) && ix.parsed.info.mint === NGU.mint;
}

/** Sum of an owner's token balance change for a mint, in UI units. */
function delta(tx: ParsedTransactionWithMeta, owner: string, mint: string) {
  let d = 0;
  for (const b of tx.meta?.postTokenBalances ?? []) {
    if (b.owner !== owner || b.mint !== mint) continue;
    const pre = tx.meta?.preTokenBalances?.find((p) => p.accountIndex === b.accountIndex);
    d += (b.uiTokenAmount.uiAmount ?? 0) - (pre?.uiTokenAmount.uiAmount ?? 0);
  }
  return d;
}

function classify(tx: ParsedTransactionWithMeta, s: { signature: string; slot: number; blockTime?: number | null }): ClankerEvent | null {
  const mint = NGU.mint!, presale = NGU.presaleAddress, crank = NGU.crankWallet;
  const keys = tx.transaction.message.accountKeys;
  const signer = (k: string | null) => !!k && keys.some((a) => a.signer && a.pubkey.toBase58() === k);
  const base: ClankerEvent = { sig: s.signature, t: s.blockTime ?? Math.floor(Date.now() / 1000), slot: s.slot, kind: "epoch", who: null, sol: null, ngu: null, burned: null, pool_ngu: null, pool_quote: null, for: null };
  const ixs = allIxs(tx);
  const memo = ixs.find((ix) => ix.program === "spl-memo" && typeof ix.parsed === "string" && ix.parsed.includes("ngu-presale:"));
  const answers = memo ? (memo.parsed as string).split("ngu-presale:")[1].split(/[\s"\]]/)[0] : null;

  if (presale && signer(presale)) {
    // DepositSol mints the buyer's NGU and the pool's fee share; the buyer's is the larger one
    const buyer = ixs
      .filter((ix) => onMint(ix, ["mintTo", "mintToChecked"]))
      .map((ix) => {
        const i = keys.findIndex((k) => k.pubkey.toBase58() === ix.parsed.info.account);
        return { owner: tx.meta?.postTokenBalances?.find((b) => b.accountIndex === i)?.owner ?? null, amt: Number(ix.parsed.info.amount ?? ix.parsed.info.tokenAmount?.amount ?? 0) / 1e9 };
      })
      .sort((a, b) => b.amt - a.amt)[0];
    if (buyer) {
      const w = keys.findIndex((k) => k.pubkey.toBase58() === presale);
      const spent = w >= 0 && tx.meta ? (tx.meta.preBalances[w] - tx.meta.postBalances[w]) / 1e9 : null;
      return { ...base, kind: "fill", who: buyer.owner, ngu: buyer.amt, sol: spent, for: answers };
    }
    const back = ixs.find((ix) => ix.program === "system" && ix.parsed?.type === "transfer" && ix.parsed.info.source === presale);
    if (back) return { ...base, kind: "refund", who: back.parsed.info.destination, sol: Number(back.parsed.info.lamports) / 1e9, for: answers };
    return base; // the epoch sync it runs before a fill
  }
  if (presale && !signer(crank)) {
    // someone sending SOL to the presale address
    const by = new Map<string, number>();
    for (const ix of ixs) {
      if (ix.program !== "system" || !["transfer", "transferWithSeed"].includes(ix.parsed?.type)) continue;
      if (ix.parsed.info.destination !== presale || ix.parsed.info.source === presale) continue;
      by.set(ix.parsed.info.source, (by.get(ix.parsed.info.source) ?? 0) + Number(ix.parsed.info.lamports));
    }
    const top = [...by].sort((a, b) => b[1] - a[1])[0];
    return top && top[1] / 1e9 >= DUST_SOL ? { ...base, kind: "in", who: top[0], sol: top[1] / 1e9 } : null;
  }
  if (!signer(crank)) return null;
  let burned = 0;
  for (const ix of ixs) {
    if (!onMint(ix, ["burn", "burnChecked"])) continue;
    burned += Number(ix.parsed.info.amount ?? ix.parsed.info.tokenAmount?.amount ?? 0) / 1e9;
  }
  const touchesCrank = keys.some((k) => k.pubkey.toBase58() === NGU.programId);
  if (!touchesCrank) return base;
  const pool = NGU.whirlpool!;
  return { ...base, kind: "crank", burned, pool_ngu: delta(tx, pool, mint), pool_quote: delta(tx, pool, NGU.quoteMint) };
}

async function build(prev: State | undefined): Promise<State> {
  const known = new Map<string, ClankerEvent | null>((prev?.events ?? []).map((e) => [e.sig, e]));
  for (const sig of prev?.skip ?? []) known.set(sig, null);
  const wallets = [NGU.crankWallet, NGU.presaleAddress].filter((w): w is string => !!w);
  const lists = await Promise.all(
    wallets.map((w) => retry(`signatures of ${w}`, () => history.getSignaturesForAddress(new PublicKey(w), { limit: 25 }, "confirmed"))),
  );
  const sigs = [...new Map(lists.flat().filter((s) => !s.err).map((s) => [s.signature, s])).values()].sort((a, b) => b.slot - a.slot).slice(0, KEEP);
  const fresh = sigs.filter((s) => !known.has(s.signature));
  for (let i = 0; i < fresh.length; i += 4) {
    const batch = fresh.slice(i, i + 4);
    const txs = await Promise.all(
      batch.map((s) => retry(s.signature, () => history.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }))),
    );
    txs.forEach((tx, j) => {
      const e = tx.meta && !tx.meta.err ? classify(tx, batch[j]) : null;
      known.set(batch[j].signature, e);
    });
  }
  return {
    events: sigs.map((s) => known.get(s.signature)).filter((e): e is ClankerEvent => !!e),
    skip: sigs.filter((s) => known.get(s.signature) === null).map((s) => s.signature),
  };
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  if (!NGU.mint || !NGU.presaleAddress) return res.status(404).json({ error: "NGU not launched" });
  try {
    const st = await memo<State>("ngu-clanker-v2", 4000, 60_000, build);
    res.setHeader("Cache-Control", "public, s-maxage=4, stale-while-revalidate=30");
    return res.status(200).json({
      now: Math.floor(Date.now() / 1000),
      crank_every_secs: 300,
      presale_every_secs: 15,
      events: st.events,
    });
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
