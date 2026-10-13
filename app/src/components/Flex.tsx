// One chip, any card: opens the share sheet for a target. The referral link rides along via shareUrl() in the builders below.
import { useState, type MouseEvent } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { PublicKey } from "@solana/web3.js";
import { ShareSheet, type ShareTarget } from "./ShareSheet";
import { shareUrl } from "../lib/ref";
import { lev } from "../lib/format";
import type { MarketView } from "../lib/chain";

/** X caches cards by URL; a 5-minute bucket makes a re-share pick up the current numbers. */
export const bust = () => `t=${Math.floor(Date.now() / 300_000)}`;

export function Flex({ target, className = "chip flex-chip", label = "flex", title = "Share it. Your referral link rides along." }: { target: ShareTarget; className?: string; label?: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
  };
  return (
    <>
      <button type="button" className={className} onClick={onClick} onKeyDown={(e) => e.stopPropagation()} title={title} aria-haspopup="dialog">
        {label}
      </button>
      {open && <ShareSheet target={target} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The connected wallet, for the referral param. */
export function useRefWallet() {
  return useWallet().publicKey ?? null;
}

/** A market card: the ±100× pitch for one coin, with the OG card as the image. */
export function marketShare(v: MarketView, ticker: string, wallet: PublicKey | null): ShareTarget {
  const key = v.acct.key.toBase58();
  return {
    title: `$${ticker} ±100×`,
    text: `$${ticker} at 100×, up or down. ${lev(v.side[0].leverage)} payout if it pumps, ${lev(v.side[1].leverage)} if it dumps. No liquidations. Somebody's wrong.`,
    url: shareUrl(`/m/${key}`, wallet),
    image: `/api/og?m=${key}&${bust()}`,
    filename: `${ticker}-100x.png`,
  };
}

/** A vault card: the delta-neutral pitch; `apy` is the compounded projection as a label, when known. */
export function vaultShare(vault: PublicKey, ticker: string, wallet: PublicKey | null, apy: string | null): ShareTarget {
  const key = vault.toBase58();
  return {
    title: `$${ticker}/SOL vault · 99.99% risk-free money`,
    text: `Parked SOL in the $${ticker}/SOL vault on 100x.broker: LP the pool, hedge the coin with −100× DOWN, keep the fees.${apy ? ` ${apy} projected.` : ""} The receipt just gets heavier.`,
    url: shareUrl(`/yield/${key}`, wallet),
    image: `/api/og?v=${key}&${bust()}`,
    filename: `${ticker}-vault.png`,
  };
}

/** The site itself: the referral link proper. */
export function siteShare(wallet: PublicKey | null): ShareTarget {
  return {
    title: "100x.broker — up or down",
    text: "±100× on any coin. No liquidations, settles in SOL, pays on every move. Pick a side.",
    url: shareUrl("/", wallet),
    image: `/api/og?${bust()}`,
    filename: "100x.png",
  };
}
