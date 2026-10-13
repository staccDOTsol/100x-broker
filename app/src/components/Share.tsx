// One-tap share for any card: an X intent with the referral baked into the URL, plus the full sheet (image + native share) behind "flex".
import type { MouseEvent } from "react";
import { Flex, useRefWallet } from "./Flex";
import type { ShareTarget } from "./ShareSheet";
import { shareUrl, tweetUrl } from "../lib/ref";

const stop = (e: MouseEvent) => e.stopPropagation();

/** Opens X with `text` + a ref-tagged link to `path`. Lives on a card without stealing its click. */
export function Tweet({ text, path, className = "chip tweet", label = "𝕏" }: { text: string; path: string; className?: string; label?: string }) {
  const wallet = useRefWallet();
  return (
    <a
      className={className}
      href={tweetUrl(text, shareUrl(path, wallet))}
      target="_blank"
      rel="noreferrer noopener"
      onClick={stop}
      onKeyDown={(e) => e.stopPropagation()}
      title="Tweet it. Your referral link rides along."
      aria-label="Share on X"
    >
      {label}
    </a>
  );
}

/** The pair every card gets: tweet + flex (image card, copy link, native share). */
export function CardShare({ text, path, target, className = "card-share" }: { text: string; path: string; target?: ShareTarget; className?: string }) {
  return (
    <span className={className} onClick={stop}>
      <Tweet text={text} path={path} />
      {target && <Flex target={target} label="flex" />}
    </span>
  );
}
