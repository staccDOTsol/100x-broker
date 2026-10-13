// Numbers that behave like a trading floor: they roll to new values, pop when they change, and flash a bolt.
import { useEffect, useRef, useState } from "react";

/** Counts from the last shown value to the new one; jumps straight there under reduced motion. */
export function useRolling(value: number | null, ms = 700) {
  const [shown, setShown] = useState<number | null>(value);
  const from = useRef<number | null>(null);
  useEffect(() => {
    if (value === null) {
      setShown(null);
      return;
    }
    const start = from.current ?? value;
    from.current = value;
    if (start === value || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setShown(start + (value - start) * (1 - (1 - k) ** 3));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

/** Pops (scales) for a beat whenever `key` changes. */
export function usePop(key: unknown) {
  const [pop, setPop] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setPop(true);
    const t = setTimeout(() => setPop(false), 600);
    return () => clearTimeout(t);
  }, [key]);
  return pop;
}

export function Rolling({ value, format, className = "" }: { value: number | null; format: (n: number) => string; className?: string }) {
  const shown = useRolling(value);
  const pop = usePop(value === null ? null : Math.round(value * 1e6));
  return (
    <span className={`num roll ${pop ? "pop" : ""} ${className}`}>
      {shown === null ? "—" : format(shown)}
    </span>
  );
}

/** A lightning bolt that fires whenever `stamp` changes (a keeper landed, NAV moved, anything live). */
export function Bolt({ stamp, title = "live" }: { stamp: unknown; title?: string }) {
  const on = usePop(stamp);
  return (
    <span className={`bolt ${on ? "zap" : ""}`} aria-hidden title={title}>
      ⚡
    </span>
  );
}
