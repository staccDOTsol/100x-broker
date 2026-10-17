// The heart on a market: tap to pin it to the top of the board (and back). Lives on a card without stealing its click.
import { usePins } from "../lib/pins";
import type { MarketView } from "../lib/chain";

export function PinButton({ v, ticker, className = "" }: { v: Pick<MarketView, "acct" | "underlyingMint">; ticker: string; className?: string }) {
  const pins = usePins();
  const on = pins.isPinned(v);
  return (
    <button
      type="button"
      className={`pin ${on ? "on" : ""} ${className}`.trim()}
      aria-pressed={on}
      aria-label={on ? `Unpin $${ticker}` : `Pin $${ticker}`}
      title={on ? "Pinned to the top of the board. Tap to unpin." : "Pin to the top of the board."}
      onClick={(e) => {
        e.stopPropagation();
        pins.toggle(v);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden focusable="false">
        <path
          d="M12 21s-7.5-4.6-9.6-9.2C.9 8.3 2.7 4.5 6.3 4.5c2.1 0 3.9 1.2 5.7 3.4 1.8-2.2 3.6-3.4 5.7-3.4 3.6 0 5.4 3.8 3.9 7.3C19.5 16.4 12 21 12 21z"
          fill={on ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
