// Liveness primitives: numbers that flash when they change, sparklines that draw themselves, a race clock, a counter that rolls.
// Everything here is driven by real polled data; nothing is simulated. All motion collapses under prefers-reduced-motion (styles.css).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 'up' | 'down' | '' for ~900 ms after `value` moves. Strings compare by inequality (direction unknown → 'up'). */
export function useFlash(value: number | string | null | undefined, ms = 900): "up" | "down" | "" {
  const prev = useRef(value);
  const [dir, setDir] = useState<"up" | "down" | "">("");
  useEffect(() => {
    const was = prev.current;
    prev.current = value;
    if (was === undefined || was === null || value === undefined || value === null || was === value) return;
    const d = typeof was === "number" && typeof value === "number" ? (value > was ? "up" : "down") : "up";
    setDir(d);
    const t = setTimeout(() => setDir(""), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return dir;
}

/** A value that flashes green/red the moment it changes (exchange-style). `watch` is the raw number to compare; children is the formatted display. */
export function Flash({ watch, children, className = "", as: Tag = "span" }: { watch: number | string | null | undefined; children: ReactNode; className?: string; as?: "span" | "b" | "strong" | "td" }) {
  const dir = useFlash(watch);
  return <Tag className={`${className} ${dir ? `flash-${dir}` : ""}`.trim()}>{children}</Tag>;
}

/** Counts from the last shown value to the new one; jumps straight there under reduced motion. */
export function Rolling({ value, format }: { value: number; format: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef<number | null>(null);
  useEffect(() => {
    const start = from.current ?? value;
    from.current = value;
    if (start === value || reduced()) {
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 800);
      setShown(start + (value - start) * (1 - (1 - k) ** 3));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format(shown)}</>;
}

export type Pt = { ts: number; price: number };

/**
 * A sparkline. Line + soft area, colored by where the last point sits against `base` (default: the first point), a live dot on the
 * end that breathes, and a draw-in whenever the series gains a point. Pure SVG, scales to its box.
 */
export function Sparkline({
  series,
  base: refPrice,
  w = 120,
  h = 30,
  className = "",
  label,
}: {
  series: Pt[];
  base?: number | null;
  w?: number;
  h?: number;
  className?: string;
  label?: string;
}) {
  const id = useMemo(() => `sp${Math.random().toString(36).slice(2, 8)}`, []);
  const pad = 2;
  const pts = series.filter((p) => Number.isFinite(p.price));
  if (pts.length < 2) return <span className={`spark empty ${className}`} aria-hidden style={{ width: w, height: h }} />;
  const base = refPrice ?? pts[0].price;
  const prices = pts.map((p) => p.price).concat(base);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = hi - lo || hi * 1e-6 || 1;
  const t0 = pts[0].ts;
  const t1 = pts[pts.length - 1].ts;
  const x = (ts: number) => pad + ((ts - t0) / Math.max(1, t1 - t0)) * (w - pad * 2);
  const y = (p: number) => h - pad - ((p - lo) / span) * (h - pad * 2);
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ts).toFixed(2)},${y(p.price).toFixed(2)}`).join("");
  const last = pts[pts.length - 1];
  const dir = last.price > base * (1 + 1e-9) ? "up" : last.price < base * (1 - 1e-9) ? "down" : "flat";
  const chg = base > 0 ? last.price / base - 1 : 0;
  return (
    <svg
      key={`${pts.length}:${last.ts}`}
      className={`spark ${dir} ${className}`}
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      preserveAspectRatio="none"
      role="img"
      aria-label={label ?? `${dir === "flat" ? "flat" : `${chg > 0 ? "+" : ""}${(chg * 100).toFixed(2)}%`} over the window`}
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="area" d={`${d}L${x(last.ts).toFixed(2)},${h}L${x(t0).toFixed(2)},${h}Z`} fill={`url(#${id})`} />
      {refPrice !== undefined && refPrice !== null && <line className="base" x1={pad} x2={w - pad} y1={y(base)} y2={y(base)} />}
      <path className="line" d={d} pathLength={1} />
      <circle className="dot" cx={x(last.ts)} cy={y(last.price)} r={2.2} />
      <circle className="halo" cx={x(last.ts)} cy={y(last.price)} r={2.2} />
    </svg>
  );
}

/** Signed percentage chip: +0.42% green, −0.42% red, 0.00% muted. */
export function Delta({ x, dp = 2, className = "" }: { x: number; dp?: number; className?: string }) {
  if (!Number.isFinite(x)) return <span className={`delta flat ${className}`}>—</span>;
  const cls = Math.abs(x) < 10 ** -(dp + 2) ? "flat" : x > 0 ? "up" : "down";
  return (
    <Flash watch={Number(x.toFixed(dp + 2))} className={`delta ${cls} ${className}`}>
      {cls === "up" ? "+" : cls === "down" ? "−" : ""}
      {Math.abs(x * 100).toFixed(dp)}%
    </Flash>
  );
}

/** Seconds, ticking. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** A race clock: H MM SS in display type, each cell ticking as it changes. Goes red inside the last hour. */
export function Countdown({ to, label }: { to: number; label?: string }) {
  const now = useNow();
  const s = Math.max(0, to - now);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const cell = (v: number, unit: string, pad = 2) => (
    <span className="cd-cell" key={unit}>
      <span className="cd-num display num" key={v}>{String(v).padStart(pad, "0")}</span>
      <span className="cd-unit meta">{unit}</span>
    </span>
  );
  return (
    <div className={`countdown ${s <= 3600 ? "hot" : ""} ${s === 0 ? "done" : ""}`} role="timer" aria-live="off" aria-label={`${h}h ${m}m ${x}s left`}>
      {label && <span className="meta cd-label">{label}</span>}
      <div className="cd-row">
        {cell(h, "h", h >= 100 ? 3 : 2)}
        <span className="cd-sep display">:</span>
        {cell(m, "m")}
        <span className="cd-sep display">:</span>
        {cell(x, "s")}
      </div>
    </div>
  );
}
