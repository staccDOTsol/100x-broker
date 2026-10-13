// In-process memo with stale-while-revalidate. A module-level Map survives warm invocations on Vercel, so one instance
// answers many requests from one upstream load. Semantics of memo():
//   age < ttlMs            -> the cached value, no work
//   age < ttlMs + staleMs  -> the cached value now; one refresh runs in the background (errors keep the old value)
//   otherwise              -> await fn (concurrent callers share the one in-flight promise); a failed refresh falls back to
//                             whatever value is still held, and throws only when there is nothing at all
// fn receives the previous value so incremental loaders (signature cursors, event buffers) can fold new data into it.
type Entry = { at: number; has: boolean; v: unknown; exp: number; inflight: Promise<unknown> | null };
const store = new Map<string, Entry>();
const MAX_ENTRIES = 2000;

function evict() {
  if (store.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, e] of store) if (!e.inflight && now - e.at > e.exp) store.delete(k);
  if (store.size <= MAX_ENTRIES) return;
  // still crowded: oldest first (Map iteration is insertion order; re-set on write keeps it roughly LRU)
  for (const [k, e] of store) {
    if (store.size <= MAX_ENTRIES * 0.9) break;
    if (!e.inflight) store.delete(k);
  }
}

function start<T>(key: string, e: Entry, fn: (prev: T | undefined) => Promise<T>): Promise<T> {
  const prev = e.has ? (e.v as T) : undefined;
  const p = fn(prev).then(
    (v) => {
      e.v = v;
      e.has = true;
      e.at = Date.now();
      e.inflight = null;
      store.delete(key);
      store.set(key, e); // move to the back: most recently written
      evict();
      return v;
    },
    (err) => {
      e.inflight = null;
      throw err;
    },
  );
  e.inflight = p;
  return p;
}

export async function memo<T>(key: string, ttlMs: number, staleMs: number, fn: (prev: T | undefined) => Promise<T>): Promise<T> {
  const now = Date.now();
  let e = store.get(key);
  if (e?.has && now - e.at < ttlMs) return e.v as T;
  if (e?.has && now - e.at < ttlMs + staleMs) {
    if (!e.inflight) start(key, e, fn).catch(() => {}); // background refresh; the stale value stands if it fails
    return e.v as T;
  }
  if (!e) {
    e = { at: 0, has: false, v: undefined, exp: ttlMs + staleMs, inflight: null };
    store.set(key, e);
  }
  e.exp = ttlMs + staleMs;
  const p = (e.inflight as Promise<T> | null) ?? start(key, e, fn);
  try {
    return await p;
  } catch (err) {
    if (e.has) return e.v as T; // too old to serve silently, but better than an error
    throw err;
  }
}

/** The held value, fresh or stale, without triggering any work. */
export function peek<T>(key: string): T | undefined {
  const e = store.get(key);
  return e?.has ? (e.v as T) : undefined;
}

/** Drop one key (tests, or after a write the cache should not outlive). */
export function forget(key: string) {
  store.delete(key);
}
