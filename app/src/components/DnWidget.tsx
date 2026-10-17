// Yield, where the trade is: the third option on every market's ticket (Long · Short · Yield). If a delta-neutral vault is built on
// this market it shows its dopamine numbers and the Park/Unpark slip; if not, the option is disabled with a one-line reason.
// A WSOL market (SOL) can't carry a vault, so it opens the vault on its oracle pool instead: the SOL/USDC LP, which sits on the USDC market.
import { Link } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { usePoll } from "../hooks";
import { useUnderlying } from "../hooks/underlying";
import { vaultsForMarket, vaultsForPool } from "../lib/dn";
import { HedgeBadge, LopsidedNote, VaultNums, VaultStats, loadRow, pct0, vaultNumbers, type Row } from "../pages/Yield";
import { Flex, useRefWallet, vaultShare } from "./Flex";
import { VaultTicket } from "./VaultTicket";

export type MarketVault = { row: Row | null; loading: boolean; error: string | null; refresh: () => void };

/**
 * The market's vault (the first the chain lists for it, else the first on its oracle pool), polled. `oraclePool` is null until the market
 * itself has loaded; the answer stays "loading" until then, and a result for another market (the switcher) is never shown.
 */
export function useMarketVault(market: PublicKey | null, oraclePool: PublicKey | null): MarketVault {
  const k = `${market?.toBase58()}/${oraclePool?.toBase58()}`;
  const r = usePoll<{ k: string; row: Row | null }>(async () => {
    if (!market || !oraclePool) return { k, row: null };
    let vs = await vaultsForMarket(market);
    if (!vs.length) vs = await vaultsForPool(oraclePool);
    return { k, row: vs.length ? await loadRow(vs[0]) : null };
  }, [k]);
  const cur = oraclePool && r.data?.k === k ? r.data : null;
  return { row: cur?.row ?? null, loading: !cur && !r.error, error: cur ? null : r.error, refresh: r.refresh };
}

/** Why Yield can't be picked on this market, in a few words and in full; null while the lookup runs or when there's a vault. */
export function yieldBlocker(m: MarketVault, quote: string, ticker: string): { short: string; full: string } | null {
  if (m.row) return null;
  if (m.loading) return null;
  if (m.error) return { short: "vaults offline", full: `Couldn't look for a $${ticker} vault: ${m.error}. Retrying.` };
  if (quote !== "SOL")
    return { short: "SOL pairs only", full: `Vaults pair a coin against SOL and hedge it with its DOWN. This market is priced in ${quote}, so there's no SOL leg to hedge.` };
  return { short: "no vault yet", full: `No yield vault for $${ticker} yet. A vault LPs ${ticker}/SOL on Raydium and hedges the ${ticker} half with this market's DOWN.` };
}

/** The ticket's Yield button copy: the projected APY when the pool rate is known. */
export function yieldApy(row: Row): number | null {
  const { compounded, sustained } = vaultNumbers(row);
  return compounded ?? sustained;
}

/** The coin the vault LPs against SOL: this market's own ticker when the vault sits on it, otherwise the vault's own coin (SOL's vault holds USDC). */
export function useVaultCoin(vault: MarketVault, market: PublicKey, ticker: string) {
  const r = vault.row;
  const own = !r || r.v.market.equals(market);
  const under = useUnderlying(own ? undefined : r?.underlying);
  return { own, coin: own ? ticker : (under?.symbol ?? "…") };
}

export function YieldPane({ vault, market, ticker, onDone }: { vault: MarketVault; market: PublicKey; ticker: string; onDone: () => void }) {
  const refWallet = useRefWallet();
  const { own, coin } = useVaultCoin(vault, market, ticker);
  const r = vault.row;
  if (!r) {
    return (
      <div className="ticket-body dnw">
        <div className="dnw-skel" aria-busy="true" aria-label="Looking for a vault">
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
        </div>
      </div>
    );
  }
  const apy = yieldApy(r);
  const home = `/m/${r.v.market.toBase58()}`;
  return (
    <div className="ticket-body dnw">
      <div className="dnw-head">
        <span className="pair">
          ${coin} <small>/ SOL{own ? "" : " LP"} · parked {(Number(r.x.nav) / 1e9).toFixed(3)} SOL</small>
        </span>
        <span className="dnw-head-right">
          <HedgeBadge r={r} /> <Flex target={vaultShare(r.v.key, coin, refWallet, apy !== null ? pct0(apy) : null)} />
        </span>
      </div>
      {!own && (
        <p className="note">
          ${ticker} can't be a vault's coin, so this is the {coin}/SOL LP: same Raydium pool, built on the <Link to={home}>{coin}/SOL market</Link>.
        </p>
      )}
      <VaultNums r={r} />
      <LopsidedNote r={r} ticker={coin} />
      <VaultTicket view={r} ticker={coin} onDone={() => (vault.refresh(), onDone())} className="in-panel" />
      <p className="note">
        Half your SOL becomes {coin}, both halves go into the Raydium pool, and the {coin} half is shorted with{" "}
        {own ? "this market's" : <Link to={`${home}?side=1`}>the {coin}/SOL market's</Link>} DOWN. Price goes anywhere, you keep the fees.
      </p>
      <details className="fine">
        <summary>vault details</summary>
        <VaultStats r={r} ticker={coin} />
      </details>
    </div>
  );
}
