// The vault, where the trade is: on every market page, the delta-neutral vault built on this market (if any)
// with its dopamine numbers and the same Park/Unpark slip as /yield. Monitor-shaped (numbers first), the slip below.
import { Link } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { usePoll } from "../hooks";
import { vaultsForMarket } from "../lib/dn";
import { HedgeBadge, VaultNums, loadRow, pct0, vaultNumbers, type Row } from "../pages/Yield";
import { Flex, useRefWallet, vaultShare } from "./Flex";
import { VaultTicket } from "./VaultTicket";

type Props = { market: PublicKey; ticker: string; quote: string; onDone: () => void };

export function DnWidget({ market, ticker, quote, onDone }: Props) {
  const refWallet = useRefWallet();
  const row = usePoll<Row | null>(async () => {
    const vs = await vaultsForMarket(market);
    return vs.length ? loadRow(vs[0]) : null;
  }, [market.toBase58()]);

  if (row.loading && row.data === undefined) {
    return (
      <div className="dnw-skel" aria-busy="true" aria-label="Looking for a vault">
        <span className="skeleton" />
        <span className="skeleton" />
        <span className="skeleton" />
      </div>
    );
  }
  if (row.error && !row.data) {
    return (
      <div className="dnw-empty" role="alert">
        <strong>Couldn't check for a vault.</strong>
        <span className="meta">{row.error}</span>
        <button className="linkish" onClick={() => row.refresh()}>
          try again →
        </button>
      </div>
    );
  }
  const r = row.data ?? null;
  if (!r) {
    return quote === "SOL" ? (
      <div className="dnw-empty">
        <strong>No vault for ${ticker} yet.</strong>
        <span>
          A vault would LP {ticker}/SOL on Raydium and hedge the {ticker} half with this market's DOWN, so what's left is pool fees — no
          direction, no funding, no liquidations.
        </span>
        <span className="meta">
          <Link to="/yield">See the vaults that exist →</Link>
        </span>
      </div>
    ) : (
      <div className="dnw-empty">
        <strong>Nothing to park here.</strong>
        <span>
          Vaults pair a coin against SOL and hedge it with its DOWN. This market is priced in {quote}, so there's no SOL leg to hedge.
        </span>
        <span className="meta">
          <Link to="/yield">See the vaults that exist →</Link>
        </span>
      </div>
    );
  }

  const key = r.v.key.toBase58();
  return (
    <>
      <div className="dnw-head">
        <span className="pair">
          ${ticker} <small>/ SOL · parked {(Number(r.x.nav) / 1e9).toFixed(3)} SOL</small>
        </span>
        <span className="dnw-head-right">
          <HedgeBadge r={r} /> <Link to={`/yield/${key}`} className="meta">details →</Link>{" "}
          <Flex target={vaultShare(r.v.key, ticker, refWallet, (() => { const p = vaultNumbers(r).projected; return p !== null ? pct0(Math.pow(1 + p / 365, 365) - 1) : null; })())} />
        </span>
      </div>
      <VaultNums r={r} />
      <VaultTicket view={r} ticker={ticker} onDone={() => (row.refresh(), onDone())} className="in-panel" />
      <p className="note">
        Half your SOL becomes {ticker}, both halves go into the Raydium pool, and the {ticker} half is shorted with this market's DOWN.
        Price goes anywhere, you keep the fees.
      </p>
    </>
  );
}
