// URL as state: every choice a user makes lands in the address bar (replace, not push),
// and share links snapshot the whole thing.
import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import type { PublicKey } from "@solana/web3.js";
import { shareUrl } from "./ref";

export function useQuery() {
  const [sp, setSp] = useSearchParams();
  const set = useCallback(
    (patch: Record<string, string | number | null | undefined>) =>
      setSp(
        (q) => {
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === undefined || v === "") q.delete(k);
            else q.set(k, String(v));
          }
          return q;
        },
        { replace: true },
      ),
    [setSp],
  );
  return { sp, get: (k: string) => sp.get(k), set };
}

/** The page exactly as it is now (path + query + hash), with the connected wallet as referrer. */
export function currentShare(wallet: PublicKey | null) {
  return shareUrl(window.location.pathname + window.location.search + window.location.hash, wallet);
}

export function setHash(h: string) {
  history.replaceState(null, "", h ? `#${h}` : window.location.pathname + window.location.search);
}
