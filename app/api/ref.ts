// GET /api/ref?w=<wallet>  -> what a wallet has earned from its referral link.
// Mechanism: every SOL that enters through a referred wallet goes through the r-fstacc stake pool's DepositSol with the
// referrer's r-fstacc account as the referral fee account; the pool pays it 50% of the 0.1% deposit fee, on-chain, per deposit.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Connection, PublicKey, type ParsedInstruction, type PartiallyDecodedInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { memo } from "./_lib/memo.js";
import { parsedTxs, recentSigs } from "./_lib/txcache.js";

const RFSTACC = new PublicKey("pSYRpDqr847kB2nD5ZhjcPsHLV2ZpUxweXm1MwiSTcc");
const STAKE_POOL_PROGRAM = "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY";
const MAX_SIGS = 600;

type Hit = { sig: string; ts: number; funder: string; lamports: string; fee: string };

/** One wallet's referral ledger: a minute fresh, two stale (matches the edge window). The signature window is incremental and
 *  parsed transactions are cached, so a repeat scan costs one `until` call. */
const ledger = (wallet: PublicKey) => memo(`ref:${wallet.toBase58()}`, 60_000, 120_000, () => scan(wallet));

async function scan(wallet: PublicKey): Promise<{ scanned: number; hits: Hit[] }> {
  const url = process.env.HELIUS_RPC_URL;
  if (!url) throw new Error("HELIUS_RPC_URL not configured");
  const conn = new Connection(url, "confirmed");
  const ata = getAssociatedTokenAddressSync(RFSTACC, wallet);
  const sigs = await recentSigs(conn, ata, MAX_SIGS);
  const hits: Hit[] = [];
  const txs = await parsedTxs(conn, sigs.map((s) => s.signature), { maxSupportedTransactionVersion: 1 });
  txs.forEach((tx, j) => {
    if (!tx?.meta || tx.meta.err) return;
    const ixs: (ParsedInstruction | PartiallyDecodedInstruction)[] = [
      ...tx.transaction.message.instructions,
      ...(tx.meta.innerInstructions ?? []).flatMap((x) => x.instructions),
    ];
    for (const ix of ixs) {
      if (ix.programId.toBase58() !== STAKE_POOL_PROGRAM || !("data" in ix)) continue;
      const data = bs58.decode(ix.data);
      if (data[0] !== 14 || ix.accounts.length < 7) continue; // DepositSol
      const funder = ix.accounts[3];
      const referral = ix.accounts[6];
      if (!referral.equals(ata) || funder.equals(wallet)) continue;
      const lamports = Buffer.from(data).readBigUInt64LE(1);
      // the referral fee is what landed in our account in this tx
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
      const idx = keys.indexOf(ata.toBase58());
      const pre = tx.meta.preTokenBalances?.find((b) => b.accountIndex === idx)?.uiTokenAmount.amount ?? "0";
      const post = tx.meta.postTokenBalances?.find((b) => b.accountIndex === idx)?.uiTokenAmount.amount ?? "0";
      const fee = BigInt(post) - BigInt(pre);
      hits.push({ sig: sigs[j].signature, ts: sigs[j].blockTime ?? 0, funder: funder.toBase58(), lamports: lamports.toString(), fee: (fee > 0n ? fee : 0n).toString() });
    }
  });
  return { scanned: sigs.length, hits };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const wallet = new PublicKey(String(req.query.w));
    const { scanned, hits } = await ledger(wallet);
    const funders = new Set(hits.map((h) => h.funder));
    const deposits = hits.reduce((s, h) => s + BigInt(h.lamports), 0n);
    const earned = hits.reduce((s, h) => s + BigInt(h.fee), 0n);
    res
      .setHeader("cache-control", "public, max-age=0, s-maxage=60, stale-while-revalidate=120")
      .json({ wallet: wallet.toBase58(), scanned, referrals: funders.size, deposits: deposits.toString(), earned: earned.toString(), recent: hits.slice(0, 20) });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "bad request" });
  }
}
