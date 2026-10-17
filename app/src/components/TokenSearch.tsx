// Type-ahead for the list box: anything that isn't an address is searched by name/symbol (/api/search, Birdeye),
// biggest 24h volume first. Pick one and the mint drops into the field. Renders nothing for addresses or short text.
// Memes · Majors · Stonks narrows the hits (each hit comes classified); with Stonks on, the server also asks Jupiter so
// typing TSLA finds TSLAx / TSLAon instead of the copycats.
import { useEffect, useState } from "react";
import { Delta } from "./Pulse";
import { CatFilter, useCatRows } from "./CatFilter";
import { CAT_PLURAL, type Category } from "../lib/category";

type Hit = { mint: string; symbol: string; name: string; logo: string | null; mc: number | null; vol24: number | null; chg24: number | null; verified: boolean; pump: boolean; category: Category };

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const usd = (n: number | null) => (n !== null && n > 0 ? `$${n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: n >= 1e5 ? 1 : 0 })}` : "—");

export function TokenSearch({ text, onPick }: { text: string; onPick: (mint: string) => void }) {
  const q = text.trim();
  const active = q.length >= 2 && !BASE58.test(q);
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const { cat, setCat, counts, filtered } = useCatRows(hits, (h) => h.category);
  // only a stonk search changes what the server looks through (Jupiter merged in); the other cats filter the same hits here
  const server = cat === "stonk" ? "stonk" : null;
  useEffect(() => {
    if (!active) {
      setHits([]);
      return;
    }
    let alive = true;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}${server ? `&cat=${server}` : ""}`);
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
  }, [q, active, server]);
  if (!active) return null;
  return (
    <div className="tsearch" role="listbox" aria-label="Matching coins">
      <span className="meta tsearch-head">
        <CatFilter cat={cat} onChange={setCat} counts={counts} />
      </span>
      {busy && hits.length === 0 && <span className="meta">searching…</span>}
      {!busy && hits.length === 0 && <span className="meta">no coin named “{q}”</span>}
      {!busy && hits.length > 0 && filtered.length === 0 && cat && (
        <span className="meta cat-empty">
          no {CAT_PLURAL[cat]} named “{q}”
        </span>
      )}
      {filtered.map((h, i) => (
        <button key={h.mint} type="button" role="option" aria-selected={i === 0} className={`tsearch-row${i === 0 ? " top" : ""}`} onClick={() => onPick(h.mint)}>
          {h.logo && <img className="tokimg" src={h.logo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = "none")} />}
          <b>${h.symbol}</b>
          <span className="muted tsearch-name">{h.name}</span>
          {h.pump && <span className="runner-pump">pump</span>}
          {(h.category === "stonk" || h.category === "major") && (
            <span className="cat-tag" data-cat={h.category}>
              {h.category}
            </span>
          )}
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
