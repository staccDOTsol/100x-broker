// Memes · Majors · Stonks — one filter for every list of coins/markets on the site. The choice is the `cat` query param (shareable,
// carried across pages by the nav), remembered in localStorage. Counts are computed from the rows the list is about to render.
import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "../lib/url";
import { CATS, CAT_LABEL, CAT_PLURAL, inCat, parseCat, type Cat, type Category } from "../lib/category";

const KEY = "cat";
const remembered = (): Cat | null => {
  try {
    return parseCat(localStorage.getItem(KEY));
  } catch {
    return null;
  }
};
const remember = (c: Cat | null) => {
  try {
    if (c) localStorage.setItem(KEY, c);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
};

/** The active category (`null` = All) and its setter. URL first; a remembered choice is written into the URL on first render
 *  so the address bar always says what the page shows. */
export function useCat(): [Cat | null, (c: Cat | null) => void] {
  const q = useQuery();
  const raw = q.get(KEY);
  const cat = parseCat(raw);
  useEffect(() => {
    if (raw !== null) return;
    const r = remembered();
    if (r) q.set({ [KEY]: r });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);
  const set = (c: Cat | null) => {
    remember(c);
    q.set({ [KEY]: c });
  };
  return [cat, set];
}

/** `path` with the active category carried along (nav links, empty-state CTAs). */
export const withCat = (path: string, cat: Cat | null) => (cat ? `${path}${path.includes("?") ? "&" : "?"}cat=${cat}` : path);

/** The category a link should carry, read without touching the URL: this page's `cat` if any, else the remembered one. */
export const carriedCat = (search: string): Cat | null => parseCat(new URLSearchParams(search).get(KEY)) ?? remembered();

/** Rows filtered by the active category plus live counts per chip, for any list whose rows know their category. */
export function useCatRows<T>(rows: T[], catOf: (r: T) => Category) {
  const [cat, setCat] = useCat();
  const counts = useMemo(() => {
    const n: Record<Cat, number> = { meme: 0, major: 0, stonk: 0 };
    for (const r of rows) {
      const c = catOf(r);
      if (c === "meme" || c === "major" || c === "stonk") n[c]++;
    }
    return { all: rows.length, ...n };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  const filtered = useMemo(() => (cat ? rows.filter((r) => inCat(catOf(r), cat)) : rows), [rows, cat]); // eslint-disable-line react-hooks/exhaustive-deps
  return { cat, setCat, counts, filtered };
}

export type Counts = { all: number } & Record<Cat, number>;

/** Four compact chips — All · Memes · Majors · Stonks — with the live count behind each. Drop it in a list's header line. */
export function CatFilter({ cat, onChange, counts, label = "Asset category" }: { cat: Cat | null; onChange: (c: Cat | null) => void; counts: Counts; label?: string }) {
  return (
    <span className="catf" role="group" aria-label={label}>
      <button type="button" className="chip" aria-pressed={cat === null} onClick={() => onChange(null)}>
        All <span className="num">{counts.all}</span>
      </button>
      {CATS.map((c) => (
        <button key={c} type="button" className="chip" aria-pressed={cat === c} onClick={() => onChange(c)}>
          {CAT_LABEL[c]} <span className="num">{counts[c]}</span>
        </button>
      ))}
    </span>
  );
}

/** One line when a filter leaves a list empty: `No stonks live · list one →` (or your own door: `pick one →` to the board). */
export function CatEmpty({ cat, what = "live", to, cta = "list one →", className = "" }: { cat: Cat; what?: string; to?: string; cta?: string; className?: string }) {
  return (
    <p className={`meta cat-empty ${className}`.trim()}>
      No {CAT_PLURAL[cat]} {what} ·{" "}
      <Link to={to ?? `/new?cat=${cat}`} className="runners-cta">
        {cta}
      </Link>
    </p>
  );
}

export default CatFilter;
