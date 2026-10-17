import { VersionedTransaction, type SendOptions, type SignatureStatus } from "@solana/web3.js";
import bs58 from "bs58";
import { WAR_WS_ENDPOINTS, type WarStreamSocket } from "./war-stream";

export class WarConfirmationUncertain extends Error {
  constructor(readonly sig: string, cause?: unknown) {
    super(`not seen on chain in time: ${sig}. It may still land; refresh before retrying.`, { cause });
    this.name = "WarConfirmationUncertain";
  }
}

type Dependencies = {
  sendRawTransaction: (raw: Uint8Array, options: SendOptions) => Promise<string>;
  getSignatureStatuses: (signatures: string[]) => Promise<{ value: (Pick<SignatureStatus, "err" | "confirmationStatus"> | null)[] }>;
  makeFailure: (signature: string, error: unknown) => Error;
  createSocket?: (url: string) => WarStreamSocket;
  endpoints?: readonly string[];
  timeoutMs?: number;
  subscriptionGraceMs?: number;
  pollMs?: number;
};

/** Keep signature sockets warm between ordered sends, without sharing their notifications. */
export function createWarConfirmationSocketPool(
  createSocket: (url: string) => WarStreamSocket,
  idleMs = 10_000,
) {
  type Entry = {
    socket: WarStreamSocket;
    leases: Set<Lease>;
    requests: Map<number, { lease: Lease; id: number }>;
    subscriptions: Map<number, Lease>;
    nextId: number;
    timer?: ReturnType<typeof setTimeout>;
    dispose: () => void;
  };
  const entries = new Map<string, Entry>();
  class Lease extends EventTarget {
    closed = false;
    constructor(readonly entry: Entry) { super(); }
    get readyState() { return this.closed ? 3 : this.entry.socket.readyState; }
    send(data: string) {
      if (this.closed) throw new Error("signature socket lease is closed");
      const message = JSON.parse(data);
      const id = ++this.entry.nextId;
      if (message.method === "signatureSubscribe") this.entry.requests.set(id, { lease: this, id: message.id });
      if (message.method === "signatureUnsubscribe") this.entry.subscriptions.delete(message.params?.[0]);
      this.entry.socket.send(JSON.stringify({ ...message, id }));
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.entry.leases.delete(this);
      for (const [subscription, lease] of this.entry.subscriptions) {
        if (lease !== this) continue;
        this.entry.subscriptions.delete(subscription);
        unsubscribe(this.entry, subscription);
      }
      if (!this.entry.leases.size) this.entry.timer = setTimeout(this.entry.dispose, idleMs);
    }
  }
  function unsubscribe(entry: Entry, subscription: number) {
    if (entry.socket.readyState !== 1) return;
    try { entry.socket.send(JSON.stringify({ jsonrpc: "2.0", id: ++entry.nextId, method: "signatureUnsubscribe", params: [subscription] })); } catch { /* Disconnect cleanup is best effort. */ }
  }
  return {
    acquire(url: string): WarStreamSocket {
      let entry = entries.get(url);
      if (entry && entry.socket.readyState > 1) { entry.dispose(); entry = undefined; }
      if (!entry) {
        const socket = createSocket(url);
        let disposed = false;
        entry = { socket, leases: new Set(), requests: new Map(), subscriptions: new Map(), nextId: 0, dispose: () => {} };
        const current = entry;
        const onOpen = () => { for (const lease of [...current.leases]) if (!lease.closed) lease.dispatchEvent(new Event("open")); };
        const onFailure = () => current.dispose();
        const onMessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") return;
          try {
            const message = JSON.parse(event.data);
            const request = current.requests.get(message.id);
            if (request) {
              current.requests.delete(message.id);
              if (typeof message.result === "number") {
                if (request.lease.closed) { unsubscribe(current, message.result); return; }
                current.subscriptions.set(message.result, request.lease);
              }
              if (!request.lease.closed) request.lease.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ ...message, id: request.id }) }));
              return;
            }
            const lease = current.subscriptions.get(message.params?.subscription);
            if (lease && !lease.closed) lease.dispatchEvent(new MessageEvent("message", { data: event.data }));
          } catch { /* Ignore malformed or unrelated JSON-RPC messages. */ }
        };
        current.dispose = () => {
          if (disposed) return;
          disposed = true;
          clearTimeout(current.timer);
          if (entries.get(url) === current) entries.delete(url);
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("message", onMessage);
          socket.removeEventListener("error", onFailure);
          socket.removeEventListener("close", onFailure);
          for (const lease of [...current.leases]) { lease.dispatchEvent(new Event("close")); lease.close(); }
          clearTimeout(current.timer);
          current.requests.clear(); current.subscriptions.clear();
          try { socket.close(); } catch { /* Already disconnected. */ }
        };
        socket.addEventListener("open", onOpen);
        socket.addEventListener("message", onMessage);
        socket.addEventListener("error", onFailure);
        socket.addEventListener("close", onFailure);
        entries.set(url, current);
      }
      clearTimeout(entry.timer);
      const lease = new Lease(entry);
      entry.leases.add(lease);
      return lease;
    },
    close() { for (const entry of [...entries.values()]) entry.dispose(); },
  };
}

/** Only on-chain execution evidence completes a send. HTTP acceptance and receivedSignature do not. */
export function sendWarRawWithDependencies(raw: Uint8Array, deps: Dependencies): Promise<string> {
  let signature: string;
  try {
    const tx = VersionedTransaction.deserialize(raw);
    if (!tx.signatures.length || tx.signatures.some((sig) => sig.every((byte) => byte === 0))) throw new Error("every transaction signature is required before sending");
    signature = bs58.encode(tx.signatures[0]);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<string>((resolve, reject) => {
    const sockets: { socket: WarStreamSocket; dispose: () => void }[] = [];
    let stopped = false;
    let sent = false;
    let sendError: unknown;
    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let earlyProof: { error: unknown } | undefined;
    const pollMs = deps.pollMs ?? 200;
    const cleanup = () => {
      clearTimeout(overallTimer);
      clearTimeout(graceTimer);
      clearTimeout(pollTimer);
      for (const { dispose } of sockets) dispose();
    };
    const finish = (error?: Error) => {
      if (stopped) return;
      stopped = true;
      cleanup();
      if (error) reject(error);
      else resolve(signature);
    };
    const proof = (error: unknown) => {
      if (!sent) { earlyProof = { error }; return; }
      finish(error === null ? undefined : deps.makeFailure(signature, error));
    };
    const poll = async () => {
      if (stopped) return;
      try {
        const status = (await deps.getSignatureStatuses([signature])).value[0];
        if (stopped) return;
        if (status?.err) { proof(status.err); return; }
        if (status && status.err === null && ["processed", "confirmed", "finalized"].includes(status.confirmationStatus ?? "")) { proof(null); return; }
      } catch { /* A failed status read is not a failed transaction. Keep the socket and next read alive. */ }
      if (!stopped) pollTimer = setTimeout(() => { void poll(); }, pollMs);
    };
    const broadcast = () => {
      if (sent || stopped) return;
      sent = true;
      clearTimeout(graceTimer);
      // Signature observation is installed before the one broadcast. Sequential batches await this promise before the next send.
      try {
        void deps.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3, preflightCommitment: "processed" }).then((ack) => {
          if (ack !== signature) sendError = new Error("RPC returned a different transaction signature");
        }).catch((error) => { sendError = error; });
      } catch (error) { sendError = error; }
      pollTimer = setTimeout(() => { void poll(); }, pollMs);
      if (earlyProof) proof(earlyProof.error);
    };
    overallTimer = setTimeout(() => finish(new WarConfirmationUncertain(signature, sendError)), deps.timeoutMs ?? 45_000);
    // Never hold a paid transaction for a cold WebSocket handshake. If its
    // notification arrives before subscription, the HTTP fallback finds it.
    graceTimer = setTimeout(broadcast, deps.subscriptionGraceMs ?? 0);
    const createSocket = deps.createSocket ?? ((url: string) => new WebSocket(url));
    for (const [index, url] of (deps.endpoints ?? WAR_WS_ENDPOINTS).entries()) {
      if (stopped) break;
      let socket: WarStreamSocket;
      try { socket = createSocket(url); } catch { continue; }
      const requestId = index + 1;
      let subscription: number | undefined;
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onFailure);
        socket.removeEventListener("close", onFailure);
        try {
          if (subscription !== undefined && socket.readyState === 1) socket.send(JSON.stringify({ jsonrpc: "2.0", id: 100 + requestId, method: "signatureUnsubscribe", params: [subscription] }));
          socket.close();
        } catch { /* Closing an already disconnected subscription is best effort. */ }
      };
      const onFailure = () => { dispose(); };
      const onOpen = () => {
        if (disposed || stopped) return;
        try {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "signatureSubscribe", params: [signature, { commitment: "processed", enableReceivedNotification: false }] }));
        } catch { onFailure(); }
      };
      const onMessage = (event: MessageEvent) => {
        if (disposed || stopped || typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data);
          if (message.id === requestId) {
            if (message.error) { onFailure(); return; }
            if (typeof message.result === "number") { subscription = message.result; broadcast(); }
            return;
          }
          if (message.method !== "signatureNotification" || subscription === undefined || message.params?.subscription !== subscription) return;
          const value = message.params?.result?.value;
          // A receipt means the RPC saw bytes, not that the runtime executed them.
          if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, "err")) return;
          if (value.err === null || value.err !== undefined) proof(value.err);
        } catch { /* Ignore unrelated or malformed messages; HTTP remains the fallback. */ }
      };
      sockets.push({ socket, dispose });
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onFailure);
      socket.addEventListener("close", onFailure);
      if (socket.readyState === 1) onOpen();
    }
    // Environments without WebSockets need no connection grace at all.
    if (!sockets.length) broadcast();
  });
}

/** War-only low-latency sends: preserve the other products' existing confirmation policy. */
const signatureSockets = createWarConfirmationSocketPool((url) => new WebSocket(url));
export async function sendWarRaw(raw: Uint8Array): Promise<string> {
  const { conn, TxFailed } = await import("./chain");
  return sendWarRawWithDependencies(raw, {
    sendRawTransaction: (bytes, options) => conn.sendRawTransaction(bytes, options),
    getSignatureStatuses: (signatures) => conn.getSignatureStatuses(signatures),
    makeFailure: (signature, error) => new TxFailed(signature, error),
    createSocket: (url) => signatureSockets.acquire(url),
  });
}
