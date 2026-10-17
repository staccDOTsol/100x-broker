// Each game's X thread: the @lastbidwins post that opened it. Players' intents reply under it or quote it, so a game's whole
// fight lives in one thread. Stored in the lastbidwins Blob store as war/thread/<gameId>.json (public; post ids are public).
const API = "https://blob.vercel-storage.com";
const token = () => {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) throw new Error("blob store not configured");
  return t;
};
export type Thread = { tweetId: string; at: number; by: string };

const previewCache = new Map<number, { until: number; value: Thread | null }>();
const previewPending = new Map<number, Promise<Thread | null>>();
const PREVIEW_BUDGET_MS = 250;
function rememberThread(gameId: number, value: Thread | null) {
  previewCache.set(gameId, { until: Date.now() + (value ? 60_000 : 5_000), value });
}
async function fetchThread(gameId: number, signal: AbortSignal): Promise<Thread | null> {
  const path = `war/thread/${gameId}.json`;
  const r = await fetch(`${API}/?prefix=${encodeURIComponent(path)}&limit=1`, { headers: { authorization: `Bearer ${token()}`, "x-api-version": "11" }, signal });
  if (!r.ok) throw new Error(`blob ${r.status}`);
  const j = (await r.json()) as { blobs?: { url: string; pathname: string; uploadedAt: string }[] };
  const b = j.blobs?.find((x) => x.pathname === path);
  if (!b) return null;
  const t = await fetch(`${b.url}?v=${Date.parse(b.uploadedAt) || Date.now()}`, { signal });
  if (!t.ok) throw new Error(`blob ${t.status}`);
  return (await t.json()) as Thread;
}

/** Fresh read for announcements; a preview cache miss must not mask an existing thread. */
export async function getThread(gameId: number): Promise<Thread | null> {
  try {
    const t = await fetchThread(gameId, AbortSignal.timeout(5_000));
    rememberThread(gameId, t);
    return t;
  } catch {
    return null;
  }
}

/** Optional UI metadata. Cold Blob lookups share one short budget, and can never hold up live game state for seconds. */
export function getThreadPreview(gameId: number): Promise<Thread | null> {
  const hit = previewCache.get(gameId);
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.value);
  const pending = previewPending.get(gameId);
  if (pending) return pending;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const p = Promise.race([
    fetchThread(gameId, abort.signal).then((t) => { rememberThread(gameId, t); return t; }).catch(() => hit?.value ?? null),
    new Promise<Thread | null>((resolve) => {
      timer = setTimeout(() => { abort.abort(); resolve(hit?.value ?? null); }, PREVIEW_BUDGET_MS);
    }),
  ]).finally(() => { clearTimeout(timer); previewPending.delete(gameId); });
  previewPending.set(gameId, p);
  return p;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${API}/?prefix=${encodeURIComponent(path)}&limit=1`, { headers: { authorization: `Bearer ${token()}`, "x-api-version": "11" }, signal: AbortSignal.timeout(5_000) });
    const j = (await r.json()) as { blobs?: { url: string; pathname: string; uploadedAt: string }[] };
    const b = j.blobs?.find((x) => x.pathname === path);
    if (!b) return null;
    const t = await fetch(`${b.url}?v=${Date.parse(b.uploadedAt) || Date.now()}`, { signal: AbortSignal.timeout(5_000) });
    return t.ok ? ((await t.json()) as T) : null;
  } catch {
    return null;
  }
}
export async function writeJson(path: string, body: unknown) {
  const r = await fetch(`${API}/?pathname=${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token()}`, "x-api-version": "11", "x-content-type": "application/json", "x-add-random-suffix": "0", "x-allow-overwrite": "1", "x-cache-control-max-age": "60" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`blob ${r.status}`);
}
export { readJson };
/** Which game a thread (an @lastbidwins announcement, i.e. a conversation id) belongs to. */
export async function gameOfThread(tweetId: string): Promise<number | null> {
  return (await readJson<{ g: number }>(`war/bythread/${tweetId}.json`))?.g ?? null;
}

export async function setThread(gameId: number, t: Thread) {
  await writeJson(`war/bythread/${t.tweetId}.json`, { g: gameId });
  const r = await fetch(`${API}/?pathname=${encodeURIComponent(`war/thread/${gameId}.json`)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token()}`, "x-api-version": "11", "x-content-type": "application/json", "x-add-random-suffix": "0", "x-allow-overwrite": "1", "x-cache-control-max-age": "60" },
    body: JSON.stringify(t),
  });
  if (!r.ok) throw new Error(`blob ${r.status}`);
  rememberThread(gameId, t);
}

// ---- mutable records (the bot's state): the public blob CDN caches a path for 60 s and ignores query strings, so a record
// that changes is written to a new path every time and read as the newest one in a fresh (uncached) listing ----
export async function readLatest<T>(prefix: string): Promise<T | null> {
  try {
    const r = await fetch(`${API}/?prefix=${encodeURIComponent(prefix)}&limit=50`, { headers: { authorization: `Bearer ${token()}`, "x-api-version": "11" }, signal: AbortSignal.timeout(5_000) });
    const j = (await r.json()) as { blobs?: { url: string; pathname: string; uploadedAt: string }[] };
    const newest = (j.blobs ?? []).sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt) || b.pathname.localeCompare(a.pathname))[0];
    if (!newest) return null;
    const t = await fetch(newest.url, { signal: AbortSignal.timeout(5_000) });
    return t.ok ? ((await t.json()) as T) : null;
  } catch {
    return null;
  }
}
export async function writeVersioned(prefix: string, body: unknown) {
  await writeJson(`${prefix}${Date.now()}.json`, body);
  // keep the five newest; older versions are ours to drop
  try {
    const r = await fetch(`${API}/?prefix=${encodeURIComponent(prefix)}&limit=100`, { headers: { authorization: `Bearer ${token()}`, "x-api-version": "11" } });
    const j = (await r.json()) as { blobs?: { url: string; uploadedAt: string }[] };
    const old = (j.blobs ?? []).sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt)).slice(5).map((b) => b.url);
    if (old.length) await fetch(`${API}/delete`, { method: "POST", headers: { authorization: `Bearer ${token()}`, "x-api-version": "11", "content-type": "application/json" }, body: JSON.stringify({ urls: old }) });
  } catch {
    /* cleanup is best effort */
  }
}
