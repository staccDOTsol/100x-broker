import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { explorer } from "../lib/chain";

/**
 * Two shapes share one stack: tx narration (pending → ok/err, pip + title + body) and hype (`big`: a display-size headline
 * like "3.2× on $BONK" over a mono subline — what the live tape throws at you when someone apes or lands a win).
 */
export type Toast = {
  id: number;
  s: "pending" | "ok" | "err";
  title: string;
  body?: string;
  sig?: string;
  big?: string;
  tone?: "up" | "down" | "signal";
  ttl?: number;
};
type Api = {
  push: (t: Omit<Toast, "id">) => number;
  update: (id: number, t: Partial<Omit<Toast, "id">>) => void;
  dismiss: (id: number) => void;
};
const Ctx = createContext<Api | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = next.current++;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      if (t.s === "ok") setTimeout(() => dismiss(id), t.ttl ?? (t.big ? 4200 : 7000));
      return id;
    },
    [dismiss],
  );
  const update = useCallback(
    (id: number, t: Partial<Omit<Toast, "id">>) => {
      setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...t } : x)));
      if (t.s === "ok") setTimeout(() => dismiss(id), t.ttl ?? 8000);
    },
    [dismiss],
  );
  const api = useMemo(() => ({ push, update, dismiss }), [push, update, dismiss]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div className={`toast ${t.big ? "hype" : ""} ${t.tone ?? ""}`} data-s={t.s} key={t.id}>
            {!t.big && <span className="pip" aria-hidden />}
            <div>
              {t.big && <div className="big display num">{t.big}</div>}
              <b>{t.title}</b>
              {t.body && <span className="muted">{t.body}</span>}
              {t.sig && (
                <div>
                  <a className="addr" href={explorer(t.sig)} target="_blank" rel="noreferrer">
                    tx ↗
                  </a>
                </div>
              )}
            </div>
            <button className="x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToasts() {
  const c = useContext(Ctx);
  if (!c) throw new Error("ToastProvider missing");
  return c;
}
