import { useSyncExternalStore } from "react";
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { decodeGame, gamePda, WAR_PROGRAM } from "../lib/war";
import { subscribeWarAccounts, type WarAccountUpdate, type WarStreamStatus } from "../lib/war-stream";
import { toWarView, type WarAmount, type WarAsset, type WarClientView } from "../lib/war-view";

export type { WarClientView } from "../lib/war-view";
type LiveState = { data: { games: WarClientView[] } | undefined; ready: boolean; error: string | null; status: WarStreamStatus; revision: number };
type StoreOptions = {
  fetchGames?: () => Promise<WarClientView[]>;
  subscribeAccounts?: (callbacks: { onAccount: (account: WarAccountUpdate) => void; onStatus: (status: WarStreamStatus) => void }) => () => void;
  setReconcileTimer?: (callback: () => void, delay: number) => unknown;
  clearReconcileTimer?: (timer: unknown) => void;
  now?: () => number;
};

const quoteKey = (asset: WarAsset) => asset.mint ?? "SOL";
function mergeAsset(current: WarAsset, incoming: WarAsset): WarAsset {
  return {
    ...incoming,
    symbol: incoming.mint && incoming.symbol === incoming.mint.slice(0, 4) ? current.symbol : incoming.symbol,
    usd: incoming.usd ?? current.usd,
    image: incoming.image ?? current.image,
  };
}
function reprice(game: WarClientView, asset: WarAsset): WarClientView {
  const amount = (a: WarAmount): WarAmount => {
    const units = Number(BigInt(a.raw)) / 10 ** asset.decimals;
    return { raw: a.raw, units, usd: asset.usd === null ? null : units * asset.usd };
  };
  return {
    ...game, asset,
    pot: amount(game.pot), minBid: amount(game.minBid), minNext: amount(game.minNext), lastBid: amount(game.lastBid),
    winnerTakes: amount(game.winnerTakes), referrerTakes: amount(game.referrerTakes),
    payoff: { ...game.payoff, win: amount(game.payoff.win) },
    payoffs: game.payoffs.map((p) => ({ ...p, win: amount(p.win) })),
  };
}
function enrich(current: WarClientView, incoming: WarClientView): WarClientView {
  const merged = reprice(current, mergeAsset(current.asset, incoming.asset));
  if (incoming.me !== undefined) merged.me = incoming.me;
  if (incoming.thread !== undefined) merged.thread = incoming.thread;
  if (incoming.featured !== undefined) merged.featured = incoming.featured;
  return merged;
}

/** Shared by the game page and discovery: one snapshot, one native WebSocket. */
export function createWarLiveStore(options: StoreOptions = {}) {
  const fetchGames = options.fetchGames ?? (async () => {
    const response = await fetch("/api/war?list=1&fresh=1", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok || !Array.isArray(body.games)) throw new Error(body.error ?? "couldn't load the games");
    return body.games as WarClientView[];
  });
  const subscribeAccounts = options.subscribeAccounts ?? ((callbacks) => subscribeWarAccounts({ program: WAR_PROGRAM.toBase58(), ...callbacks }));
  const setReconcileTimer = options.setReconcileTimer ?? ((callback, delay) => globalThis.setInterval(callback, delay));
  const clearReconcileTimer = options.clearReconcileTimer ?? ((timer) => globalThis.clearInterval(timer as ReturnType<typeof setInterval>));
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const listeners = new Set<() => void>();
  const games = new Map<number, WarClientView>();
  const versions = new Map<number, number>();
  const slots = new Map<number, number>();
  const assets = new Map<string, WarAsset>();
  let state: LiveState = { data: undefined, ready: false, error: null, status: "connecting", revision: 0 };
  let releaseSocket: (() => void) | undefined;
  let reconcileTimer: unknown;
  let running = false;
  let generation = 0;
  let pending: Promise<void> | undefined;
  let refreshAgain = false;
  let hasConnected = false;

  function emit(patch: Partial<LiveState>, changedGames = false) {
    state = { ...state, ...patch, ...(changedGames ? { data: { games: [...games.values()] }, revision: state.revision + 1 } : {}) };
    for (const listener of listeners) listener();
  }
  function rememberAsset(asset: WarAsset) {
    const key = quoteKey(asset), existing = assets.get(key);
    const next = existing ? mergeAsset(existing, asset) : asset;
    assets.set(key, next);
    return next;
  }
  function write(game: WarClientView) {
    games.set(game.id, game);
    versions.set(game.id, (versions.get(game.id) ?? 0) + 1);
  }

  function onAccount(account: WarAccountUpdate) {
    if (!running || !Number.isSafeInteger(account.slot) || account.slot < 0) return;
    try {
      const bytes = Buffer.from(account.data, "base64");
      if (bytes.length < 297) return;
      const rawId = bytes.readBigUInt64LE(8);
      if (rawId > BigInt(Number.MAX_SAFE_INTEGER)) return;
      const id = Number(rawId), key = new PublicKey(account.pubkey);
      if (!gamePda(id).equals(key) || account.slot < (slots.get(id) ?? -1)) return;
      const game = decodeGame(id, key, bytes);
      const current = games.get(id);
      // A reconnecting endpoint can be behind a detail response or another
      // endpoint, including multiple writes in the same slot.
      if (current && (game.totalBids < current.bids || game.lastBid < BigInt(current.lastBid.raw) || (current.over && !game.over))) return;
      const mint = game.mint?.toBase58() ?? null;
      const known = assets.get(mint ?? "SOL");
      const asset: WarAsset = {
        mint, symbol: known?.symbol ?? (mint ? mint.slice(0, 4) : "SOL"),
        decimals: game.isToken ? game.decimals : 9,
        usd: known?.usd ?? null, image: known?.image ?? null,
      };
      const next: WarClientView = { ...toWarView(game, asset, now()),
        ...(current?.me !== undefined ? { me: current.me } : {}),
        ...(current?.thread !== undefined ? { thread: current.thread } : {}),
        ...(current?.featured !== undefined ? { featured: current.featured } : {}),
      };
      slots.set(id, account.slot);
      write(next);
      emit({ error: null }, true);
    } catch { /* Other account types and malformed provider frames cannot replace a valid game. */ }
  }

  /** Detail responses enrich streamed games without replacing their chain state. */
  function upsert(incoming: WarClientView) {
    if (!Number.isSafeInteger(incoming.id) || incoming.id < 0) return;
    const asset = rememberAsset(incoming.asset), current = games.get(incoming.id);
    if (current && slots.has(incoming.id)) write(enrich(current, { ...incoming, asset }));
    else write(reprice(incoming, asset));
    emit({ error: null }, true);
  }

  function refresh(): void {
    if (!running) return;
    if (pending) { refreshAgain = true; return; }
    const startedGeneration = generation;
    const before = new Map(versions);
    const request = (async () => {
      try {
        const incoming = await fetchGames();
        if (!running || generation !== startedGeneration) return;
        for (const game of incoming) rememberAsset(game.asset);
        for (const game of incoming) {
          const current = games.get(game.id);
          const changedWhileLoading = versions.get(game.id) !== before.get(game.id);
          const older = current && (game.bids < current.bids || BigInt(game.lastBid.raw) < BigInt(current.lastBid.raw) || (current.over && !game.over));
          const next = current && (changedWhileLoading || older) ? enrich(current, game) : { ...current, ...game };
          write(reprice(next, assets.get(quoteKey(next.asset)) ?? next.asset));
        }
        // A newly streamed game may not be present in the snapshot's discovery
        // index yet. Keep it, and enrich it from any matching quote metadata.
        for (const [id, game] of games) {
          const asset = assets.get(quoteKey(game.asset));
          if (asset && asset !== game.asset) games.set(id, reprice(game, { ...asset, decimals: game.asset.decimals }));
        }
        // An empty or stale discovery response must not erase visible games.
        emit({ error: null, ready: true }, true);
      } catch (error) {
        if (running && generation === startedGeneration) emit({ error: error instanceof Error ? error.message : "couldn't load the games" });
      }
    })();
    pending = request;
    void request.finally(() => {
      if (pending !== request) return;
      pending = undefined;
      if (refreshAgain) { refreshAgain = false; refresh(); }
    });
  }

  function start() {
    running = true;
    generation++;
    hasConnected = false;
    releaseSocket = subscribeAccounts({ onAccount, onStatus: (status) => {
      if (!running) return;
      emit({ status });
      if (status === "live") {
        if (hasConnected) refresh();
        hasConnected = true;
      }
    } });
    refresh();
    // Reconcile discovery and metadata, and recover updates missed during a
    // disconnect. Live account changes always arrive through the socket.
    reconcileTimer = setReconcileTimer(refresh, 30_000);
  }
  function stop() {
    running = false;
    generation++;
    releaseSocket?.(); releaseSocket = undefined;
    if (reconcileTimer !== undefined) clearReconcileTimer(reconcileTimer);
    reconcileTimer = undefined;
    pending = undefined;
    refreshAgain = false;
  }
  function subscribe(listener: () => void) {
    listeners.add(listener);
    if (!running) start();
    return () => { listeners.delete(listener); if (!listeners.size) stop(); };
  }
  return { subscribe, getSnapshot: () => state, refresh, upsert };
}

const liveGames = createWarLiveStore();
export function useWarLiveGames() {
  const state = useSyncExternalStore(liveGames.subscribe, liveGames.getSnapshot, liveGames.getSnapshot);
  return { ...state, refresh: liveGames.refresh, upsert: liveGames.upsert };
}
