import { lazy, Suspense, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { usePoll } from "../hooks";
import type { MarketView } from "../lib/chain";
import { fetchDflowStatus } from "../lib/dflow";

const DflowTrade = lazy(() => import("./DflowTrade").then((module) => ({ default: module.DflowTrade })));

/** Production access enables DFlow by default. An explicit selection never silently changes execution providers. */
export function ProviderTrade({ view, children, onDone }: { view: MarketView; children: ReactNode; onDone?: () => void | Promise<void> }) {
  const [query, setQuery] = useSearchParams();
  const status = usePoll(() => fetchDflowStatus(), [], 30_000);
  const selected = query.get("via");
  const dflow = selected === "dflow" || (selected !== "direct" && status.data === true);
  const choose = (via: "dflow" | "direct") => {
    const next = new URLSearchParams(query);
    next.set("via", via);
    setQuery(next, { replace: true });
  };
  return <>
    <section className="panel" aria-label="External trading and charts">
      <div className="panel-row"><strong>Axiom charts & trading</strong></div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        <a className="btn up" href={`https://axiom.trade/meme/${view.acct.poolBull.toBase58()}?chain=sol`} target="_blank" rel="noopener noreferrer">UP on Axiom ↗</a>
        <a className="btn down" href={`https://axiom.trade/meme/${view.acct.poolBear.toBase58()}?chain=sol`} target="_blank" rel="noopener noreferrer">DOWN on Axiom ↗</a>
        <a className="btn ghost small" href="https://axiom.trade/@staccover" target="_blank" rel="noopener noreferrer">Join Axiom · staccover referral ↗</a>
        <a className="btn ghost small" href="https://dflow.net/" target="_blank" rel="noopener noreferrer">DFlow website ↗</a>
      </div>
    </section>
    {(status.data === true || selected === "dflow") ? <div className="tabs" role="group" aria-label="Trading provider">
      <button aria-pressed={dflow} onClick={() => choose("dflow")}>DFlow</button>
      <button aria-pressed={!dflow} onClick={() => choose("direct")}>Direct</button>
    </div> : null}
    {dflow ? <>
      <Suspense fallback={<div className="panel" role="status">Loading DFlow trading…</div>}>
        <DflowTrade key={view.acct.key.toBase58()} view={view} onDone={onDone} />
      </Suspense>
      <details className="panel">
        <summary>Direct trading, redemption and yield</summary>
        {children}
      </details>
    </> : children}
  </>;
}
