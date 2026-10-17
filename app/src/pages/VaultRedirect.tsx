// /yield/:vault, retired: the vault's yield option lives on its market's page. Old links (shares, tweets, bookmarks) land there.
import { useMemo } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { usePoll } from "../hooks";
import { findVault } from "../lib/dn";

export default function VaultRedirect() {
  const { vault = "" } = useParams();
  const { search } = useLocation();
  const key = useMemo(() => {
    try {
      return new PublicKey(vault);
    } catch {
      return null;
    }
  }, [vault]);
  const found = usePoll(() => (key ? findVault(key) : Promise.resolve(null)), [vault], 5_000);
  // not an address, not a vault, or the lookup failed: the board is the honest place to land
  if (!key || (!found.loading && !found.data)) return <Navigate to={{ pathname: "/", search }} replace />;
  if (found.data) {
    const q = new URLSearchParams(search);
    q.set("side", "yield");
    return <Navigate to={{ pathname: `/m/${found.data.market.toBase58()}`, search: q.toString() }} replace />;
  }
  return <span className="skeleton" style={{ height: 120 }} aria-busy="true" />;
}
