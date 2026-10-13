// GET /api/ref?w=<wallet>  -> what a wallet has earned from its referral link.
// Mechanism: every SOL that enters through a referred wallet goes through the r-fstacc stake pool's DepositSol with the
// referrer's r-fstacc account as the referral fee account; the pool pays it 50% of the 0.1% deposit fee, on-chain, per deposit.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Connection, PublicKey, type ParsedInstruction, type PartiallyDecodedInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";

const RFSTACC = new PublicKey("pSYRpDqr847kB2nD5ZhjcPsHLV2ZpUxweXm1MwiSTcc");
const STAKE_POOL_PROGRAM = "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY";
const MAX_SIGS = 600;

type Hit = { sig: string; ts: number; funder: string; lamports: string; fee: string };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const url = process.env.HELIUS_RPC_URL;
    if (!url) throw new Error("HELIUS_RPC_URL not configured");
    const conn = new Connection(url, "confirmed");
    const wallet = new PublicKey(String(req.query.w));
    const ata = getAssociatedTokenAddressSync(RFSTACC, wallet);
    const sigs: { signature: string; blockTime?: number | null }[] = [];
    let before: string | undefined;
    while (sigs.length < MAX_SIGS) {
      const page = await conn.getSignaturesForAddress(ata, { limit: Math.min(1000, MAX_SIGS - sigs.length), before });
      if (!page.length) break;
      sigs.push(...page);
      before = page[page.length - 1].signature;
      if (page.length < 1000) break;
    }
    const hits: Hit[] = [];
    for (let i = 0; i < sigs.length; i += 100) {
      const chunk = sigs.slice(i, i + 100);
      const txs = await conn.getParsedTransactions(chunk.map((s) => s.signature), { maxSupportedTransactionVersion: 1 as unknown as number });
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
          hits.push({ sig: chunk[j].signature, ts: chunk[j].blockTime ?? 0, funder: funder.toBase58(), lamports: lamports.toString(), fee: (fee > 0n ? fee : 0n).toString() });
        }
      });
    }
    const funders = new Set(hits.map((h) => h.funder));
    const deposits = hits.reduce((s, h) => s + BigInt(h.lamports), 0n);
    const earned = hits.reduce((s, h) => s + BigInt(h.fee), 0n);
    res
      .setHeader("cache-control", "public, max-age=0, s-maxage=60, stale-while-revalidate=120")
      .json({ wallet: wallet.toBase58(), scanned: sigs.length, referrals: funders.size, deposits: deposits.toString(), earned: earned.toString(), recent: hits.slice(0, 20) });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "bad request" });
  }
}
