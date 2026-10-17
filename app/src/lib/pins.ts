// Pinned (hearted) markets, remembered per browser in localStorage. Out of the box PUMP, SOL and every Bitcoin wrapper the
// majors list knows are pinned; an explicit heart or un-heart always wins over that default, and a market listed later for one of
// those coins arrives pinned. The defaults match on the underlying *mint*, never the ticker, so a copycat "SOL" cannot ride in.
import { useMemo, useSyncExternalStore } from "react";
import { MAJORS } from "./category";
import type { MarketView } from "./chain";

const KEY = "pins";
export const PUMP_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** PUMP, SOL, and BTC as every wrapper in `MAJORS` spells it (cbBTC, both WBTCs, tBTC, xBTC, zBTC, LBTC, zenBTC). */
export const DEFAULT_PIN_MINTS: ReadonlySet<string> = new Set([
  PUMP_MINT,
  WSOL_MINT,
  ...Object.entries(MAJORS)
    .filter(([, sym]) => /btc/i.test(sym))
    .map(([mint]) => mint),
]);

/** `on`: hearted by hand. `off`: un-hearted by hand (only matters for a default pin). Both hold market keys (base58). */
type Saved = { on: string[]; off: string[] };
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);

function read(): Saved {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return { on: strings(j?.on), off: strings(j?.off) };
  } catch {
    return { on: [], off: [] }; // private mode, blocked storage, or a hand-edited value: the defaults still work
  }
}

let state: Saved = read();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function write(next: Saved) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* kept for this tab only */
  }
  emit();
}
if (typeof window !== "undefined") {
  // another tab hearted something
  window.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key === null) {
      state = read();
      emit();
    }
  });
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

type Pinnable = Pick<MarketView, "acct" | "underlyingMint">;
const keyOf = (v: Pinnable) => v.acct.key.toBase58();
const pinnedIn = (s: Saved, v: Pinnable) => {
  const k = keyOf(v);
  return s.on.includes(k) || (!s.off.includes(k) && DEFAULT_PIN_MINTS.has(v.underlyingMint));
};

/** Pin state for any list of markets. `isPinned` changes identity whenever a heart flips, so memos keyed on it re-sort. */
export function usePins() {
  const s = useSyncExternalStore(subscribe, () => state);
  return useMemo(
    () => ({
      isPinned: (v: Pinnable) => pinnedIn(s, v),
      toggle: (v: Pinnable) => {
        const k = keyOf(v);
        if (pinnedIn(state, v)) write({ on: state.on.filter((x) => x !== k), off: [...state.off.filter((x) => x !== k), k] });
        else write({ on: [...state.on.filter((x) => x !== k), k], off: state.off.filter((x) => x !== k) });
      },
    }),
    [s],
  );
}
