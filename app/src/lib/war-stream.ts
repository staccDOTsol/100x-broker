// Solana pushes changed game accounts directly to the browser. HTTP supplies the
// initial snapshot; this transport never polls or rebuilds that snapshot.
export const WAR_WS_ENDPOINTS = [
  // PublicNode's WebSocket host differs from its solana-rpc HTTP host.
  // This endpoint accepts browser Origins; Solana's shared RPC may reject them.
  "wss://solana.publicnode.com",
  "wss://api.mainnet-beta.solana.com",
] as const;

export type WarStreamStatus = "connecting" | "live" | "reconnecting" | "offline";
export type WarAccountUpdate = { pubkey: string; data: string; slot: number };
export type WarStreamSocket = Pick<WebSocket, "readyState" | "send" | "close" | "addEventListener" | "removeEventListener">;
type Runtime = {
  createSocket?: (url: string) => WarStreamSocket;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  random?: () => number;
};
type Options = {
  program: string;
  onAccount: (account: WarAccountUpdate) => void;
  onStatus?: (status: WarStreamStatus) => void;
  endpoints?: readonly string[];
};

// Base58 of the deployed Anchor Game discriminator. Filtering by discriminator
// also accepts accounts with trailing padding, unlike a fixed dataSize filter.
const GAME_DISCRIMINATOR = "5aNQXizG8jB";
const SUBSCRIBE_TIMEOUT_MS = 12_000;
const STABLE_CONNECTION_MS = 30_000;

/** Subscribe once per page/store and dispose when its last consumer leaves. */
export function subscribeWarAccounts(options: Options, runtime: Runtime = {}): () => void {
  const endpoints = options.endpoints ?? WAR_WS_ENDPOINTS;
  if (!endpoints.length) throw new Error("A WebSocket endpoint is required for live games");
  const createSocket = runtime.createSocket ?? ((url: string) => new WebSocket(url));
  const setTimer = runtime.setTimer ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const clearTimer = runtime.clearTimer ?? ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  const random = runtime.random ?? Math.random;
  const seen = new Map<string, { slot: number; data: Set<string> }>();
  let stopped = false;
  let endpointIndex = 0;
  let failures = 0;
  let requestId = 0;
  let status: WarStreamStatus | undefined;
  let retryTimer: unknown;
  let releaseConnection: (() => void) | undefined;

  function report(next: WarStreamStatus) {
    if (!stopped && status !== next) {
      status = next;
      options.onStatus?.(next);
    }
  }

  function connect() {
    if (stopped) return;
    retryTimer = undefined;
    report(failures ? "reconnecting" : "connecting");
    let socket: WarStreamSocket;
    try {
      socket = createSocket(endpoints[endpointIndex]);
    } catch {
      retry();
      return;
    }
    const subscribeId = ++requestId;
    let subscription: number | undefined;
    let released = false;
    let timeout: unknown;
    let stableTimer: unknown;

    function release() {
      if (released) return;
      released = true;
      if (timeout !== undefined) clearTimer(timeout);
      if (stableTimer !== undefined) clearTimer(stableTimer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onFailure);
      socket.removeEventListener("close", onFailure);
      try {
        if (subscription !== undefined && socket.readyState === 1) {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "programUnsubscribe", params: [subscription] }));
        }
        socket.close();
      } catch { /* A disconnected socket has already released its subscription. */ }
    }

    function onFailure() {
      if (released || stopped) return;
      release();
      releaseConnection = undefined;
      retry();
    }

    function onOpen() {
      if (released || stopped) return;
      try {
        socket.send(JSON.stringify({
          jsonrpc: "2.0", id: subscribeId, method: "programSubscribe",
          params: [options.program, {
            encoding: "base64", commitment: "confirmed",
            filters: [{ memcmp: { offset: 0, bytes: GAME_DISCRIMINATOR } }],
          }],
        }));
      } catch {
        onFailure();
      }
    }

    function onMessage(event: MessageEvent) {
      if (released || stopped || typeof event.data !== "string") return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== "object") return;
      if (message.id === subscribeId) {
        // Some providers accept the socket but reject program subscriptions.
        // An error must fail over rather than leave an apparently live feed.
        if (message.error || !Number.isSafeInteger(message.result) || message.result < 0) {
          onFailure();
          return;
        }
        if (subscription !== undefined) return;
        subscription = message.result;
        if (timeout !== undefined) clearTimer(timeout);
        timeout = undefined;
        stableTimer = setTimer(() => { failures = 0; }, STABLE_CONNECTION_MS);
        report("live");
        return;
      }
      const params = message.params;
      if (subscription === undefined || message.method !== "programNotification" || params?.subscription !== subscription) return;
      const slot = params.result?.context?.slot;
      const value = params.result?.value;
      const data = value?.account?.data;
      if (!Number.isSafeInteger(slot) || slot < 0 || typeof value?.pubkey !== "string" || !value.pubkey ||
          value.account?.owner !== options.program || !Array.isArray(data) || data[1] !== "base64" || typeof data[0] !== "string" || !data[0]) return;
      const previous = seen.get(value.pubkey);
      if (previous && (slot < previous.slot || (slot === previous.slot && previous.data.has(data[0])))) return;
      if (previous && previous.slot === slot) previous.data.add(data[0]);
      else seen.set(value.pubkey, { slot, data: new Set([data[0]]) });
      options.onAccount({ pubkey: value.pubkey, data: data[0], slot });
    }

    releaseConnection = release;
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onFailure);
    socket.addEventListener("close", onFailure);
    timeout = setTimer(onFailure, SUBSCRIBE_TIMEOUT_MS);
  }

  function retry() {
    if (stopped) return;
    failures++;
    endpointIndex = (endpointIndex + 1) % endpoints.length;
    report(failures >= endpoints.length ? "offline" : "reconnecting");
    // Try each endpoint before increasing the delay. A brief successful ACK
    // does not reset backoff, so a repeatedly dropped socket cannot spin.
    const delay = Math.min(30_000, 500 * 2 ** Math.min(6, Math.floor((failures - 1) / endpoints.length)));
    retryTimer = setTimer(connect, Math.round(delay * (0.8 + random() * 0.4)));
  }

  connect();
  return () => {
    if (stopped) return;
    stopped = true;
    if (retryTimer !== undefined) clearTimer(retryTimer);
    releaseConnection?.();
    releaseConnection = undefined;
    seen.clear();
  };
}
