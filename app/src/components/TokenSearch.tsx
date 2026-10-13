// Type-ahead for the list box: anything that isn't an address is searched by name/symbol (/api/search, Birdeye),
// biggest 24h volume first. Pick one and the mint drops into the field. Renders nothing for addresses or short text.
import { useEffect, useState } from "react";
import { Delta } from "./Pulse";

type Hit = { mint: string; symbol: string; name: string; logo: string | null; mc: number | null; vol24: number | null; chg24: number | null; verified: boolean; pump: boolean };

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const usd = (n: number | null) => (n !== null && n > 0 ? `$${n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: n >= 1e5 ? 1 : 0 })}` : "—");

export function TokenSearch({ text, onPick }: { text: string; onPick: (mint: string) => void }) {
  const q = text.trim();
  const active = q.length >= 2 && !BASE58.test(q);
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!active) {
      setHits([]);
      return;
    }
    let alive = true;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const j = (await r.json()) as { tokens?: Hit[] };
        if (alive) setHits(Array.isArray(j.tokens) ? j.tokens : []);
      } catch {
        if (alive) setHits([]);
      } finally {
        if (alive) setBusy(false);
      }
    }, 280);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, active]);
  if (!active) return null;
  return (
    <div className="tsearch" role="listbox" aria-label="Matching coins">
      {busy && hits.length === 0 && <span className="meta">searching…</span>}
      {!busy && hits.length === 0 && <span className="meta">no coin named “{q}”</span>}
      {hits.map((h, i) => (
        <button key={h.mint} type="button" role="option" aria-selected={i === 0} className={`tsearch-row${i === 0 ? " top" : ""}`} onClick={() => onPick(h.mint)}>
          {h.logo && <img className="tokimg" src={h.logo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = "none")} />}
          <b>${h.symbol}</b>
          <span className="muted tsearch-name">{h.name}</span>
          {h.pump && <span className="runner-pump">pump</span>}
          <span className="num tsearch-nums">
            <Delta x={(h.chg24 ?? 0) / 100} dp={0} />
            <span className="muted">vol {usd(h.vol24)}</span>
            <span className="muted">mc {usd(h.mc)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export default TokenSearch;
