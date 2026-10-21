import { PublicKey, VersionedTransaction } from "@solana/web3.js";

export const DFLOW_ORDER_URL = "https://quote-api.dflow.net/order";
export const DFLOW_SOL_MINT = "So11111111111111111111111111111111111111112";
const U64_MAX = (1n << 64n) - 1n;

export class DflowError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

type Json = Record<string, unknown>;
export type DflowRequest = {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  userPublicKey?: string;
};
export type DflowHop = {
  venue: string;
  marketKey: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  inputMintDecimals: number;
  outputMintDecimals: number;
};
export type DflowOrder = {
  provider: "DFlow";
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  minOutAmount: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: DflowHop[];
  contextSlot: number;
  executionMode: "sync";
  transaction?: string;
  transactionVersion?: "v0";
  lastValidBlockHeight?: number;
  prioritizationFeeLamports?: number;
};

const object = (x: unknown): x is Json => x !== null && typeof x === "object" && !Array.isArray(x);
function address(x: unknown): x is string {
  if (typeof x !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x)) return false;
  try { return new PublicKey(x).toBase58() === x; } catch { return false; }
}
function integer(x: unknown, positive = true): x is string {
  if (typeof x !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(x)) return false;
  const n = BigInt(x);
  return n <= U64_MAX && (!positive || n > 0n);
}
const uint = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const invalidResponse = () => new DflowError(502, "DFLOW_INVALID_RESPONSE", "DFlow returned an order that could not be verified. Please refresh the quote.");
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

export function parseDflowRequest(value: unknown, buildTransaction: boolean): DflowRequest {
  if (!object(value)) throw new DflowError(400, "INVALID_REQUEST", "Provide a swap request.");
  const { inputMint, outputMint, amount } = value;
  if (!address(inputMint) || !address(outputMint) || inputMint === outputMint) {
    throw new DflowError(400, "INVALID_PAIR", "Choose two different token mints.");
  }
  if (!integer(amount)) throw new DflowError(400, "INVALID_AMOUNT", "Amount must be a positive u64 integer in token base units.");
  const rawSlippage = value.slippageBps ?? "100";
  if ((typeof rawSlippage !== "string" && typeof rawSlippage !== "number") || !/^[0-9]{1,4}$/.test(String(rawSlippage))) {
    throw new DflowError(400, "INVALID_SLIPPAGE", "Slippage must be 1–1000 basis points.");
  }
  const slippageBps = Number(rawSlippage);
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 1000) {
    throw new DflowError(400, "INVALID_SLIPPAGE", "Slippage must be 1–1000 basis points.");
  }
  if (buildTransaction && !address(value.userPublicKey)) {
    throw new DflowError(400, "INVALID_WALLET", "Connect a Solana wallet before trading.");
  }
  return { inputMint, outputMint, amount, slippageBps, ...(buildTransaction ? { userPublicKey: value.userPublicKey as string } : {}) };
}

export function assertDflowPair(request: DflowRequest, activeSideMints: ReadonlySet<string>) {
  const sideMint = request.inputMint === DFLOW_SOL_MINT ? request.outputMint : request.outputMint === DFLOW_SOL_MINT ? request.inputMint : null;
  if (!sideMint || !activeSideMints.has(sideMint)) {
    throw new DflowError(400, "UNSUPPORTED_PAIR", "Choose SOL and an active 100x UP or DOWN token.");
  }
}

function validateWire(raw: unknown, owner: string): string {
  if (typeof raw !== "string" || raw.length > 1644 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) throw invalidResponse();
  try {
    const bytes = Buffer.from(raw, "base64");
    if (bytes.length === 0 || bytes.length > 1232 || bytes.toString("base64") !== raw) throw invalidResponse();
    const tx = VersionedTransaction.deserialize(bytes);
    if (tx.version !== 0 || tx.message.header.numRequiredSignatures !== 1 || tx.signatures.length !== 1 ||
      tx.signatures.some((signature) => signature.some((byte) => byte !== 0)) ||
      !tx.message.staticAccountKeys[0]?.equals(new PublicKey(owner)) ||
      tx.message.header.numReadonlySignedAccounts !== 0 || tx.message.compiledInstructions.length === 0 ||
      !Buffer.from(tx.serialize()).equals(bytes)) throw invalidResponse();
    return raw;
  } catch { throw invalidResponse(); }
}

export function validateDflowOrder(raw: unknown, request: DflowRequest): DflowOrder {
  if (!object(raw) || raw.inputMint !== request.inputMint || raw.outputMint !== request.outputMint ||
    raw.inAmount !== request.amount || !integer(raw.outAmount) || raw.slippageBps !== request.slippageBps ||
    raw.executionMode !== "sync" || !uint(raw.contextSlot) || !Array.isArray(raw.routePlan) || raw.routePlan.length === 0 || raw.routePlan.length > 32) throw invalidResponse();
  const minimum = raw.minOutAmount ?? raw.otherAmountThreshold;
  if (!integer(minimum) || (raw.minOutAmount !== undefined && raw.minOutAmount !== minimum) ||
    (raw.otherAmountThreshold !== undefined && raw.otherAmountThreshold !== minimum) ||
    BigInt(minimum) > BigInt(raw.outAmount) ||
    BigInt(minimum) < BigInt(raw.outAmount) * BigInt(10_000 - request.slippageBps) / 10_000n) throw invalidResponse();
  if (raw.platformFee !== null && raw.platformFee !== undefined &&
    (!object(raw.platformFee) || raw.platformFee.feeBps !== 0 || !integer(raw.platformFee.amount, false) || raw.platformFee.amount !== "0")) throw invalidResponse();
  const routePlan = raw.routePlan.map((hop): DflowHop => {
    if (!object(hop) || typeof hop.venue !== "string" || hop.venue.length === 0 || hop.venue.length > 100 ||
      !address(hop.marketKey) || !address(hop.inputMint) || !address(hop.outputMint) ||
      !integer(hop.inAmount) || !integer(hop.outAmount) || !uint(hop.inputMintDecimals) || hop.inputMintDecimals > 255 ||
      !uint(hop.outputMintDecimals) || hop.outputMintDecimals > 255) throw invalidResponse();
    return { venue: hop.venue, marketKey: hop.marketKey, inputMint: hop.inputMint, outputMint: hop.outputMint,
      inAmount: hop.inAmount, outAmount: hop.outAmount, inputMintDecimals: hop.inputMintDecimals, outputMintDecimals: hop.outputMintDecimals };
  });
  if (!routePlan.some((hop) => hop.inputMint === request.inputMint) || !routePlan.some((hop) => hop.outputMint === request.outputMint)) throw invalidResponse();
  const priceImpact = String(raw.priceImpactPct ?? "");
  if (priceImpact.length > 80 || !/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(priceImpact) || !Number.isFinite(Number(priceImpact))) throw invalidResponse();
  const result: DflowOrder = {
    provider: "DFlow", inputMint: request.inputMint, outputMint: request.outputMint, inAmount: request.amount,
    outAmount: raw.outAmount, otherAmountThreshold: minimum, minOutAmount: minimum, slippageBps: request.slippageBps,
    priceImpactPct: priceImpact, routePlan, contextSlot: raw.contextSlot, executionMode: "sync",
  };
  if (request.userPublicKey) {
    if (raw.transactionVersion !== "v0" || !uint(raw.lastValidBlockHeight) || raw.lastValidBlockHeight === 0 ||
      !uint(raw.prioritizationFeeLamports)) throw invalidResponse();
    result.transaction = validateWire(raw.transaction, request.userPublicKey);
    result.transactionVersion = "v0";
    result.lastValidBlockHeight = raw.lastValidBlockHeight;
    result.prioritizationFeeLamports = raw.prioritizationFeeLamports;
  }
  return result;
}

type Dependencies = {
  apiKey: () => string | undefined;
  developerMode?: boolean;
  activeSideMints: () => Promise<ReadonlySet<string>>;
  /** Test transport injection; the production handler always uses the native fetch. */
  fetch?: typeof fetch;
};
export function createDflowService(dependencies: Dependencies) {
  return {
    configured: () => Boolean(dependencies.developerMode || dependencies.apiKey()?.trim()),
    async order(value: unknown, buildTransaction: boolean): Promise<DflowOrder> {
      const request = parseDflowRequest(value, buildTransaction);
      const apiKey = dependencies.apiKey()?.trim();
      if (!apiKey && !dependencies.developerMode) throw new DflowError(503, "DFLOW_NOT_CONFIGURED", "DFlow trading is awaiting production API access.");
      let sideMints: ReadonlySet<string>;
      try { sideMints = await bounded(dependencies.activeSideMints(), 15_000); }
      catch { throw new DflowError(503, "MARKETS_UNAVAILABLE", "Active markets could not be checked. Please try again."); }
      assertDflowPair(request, sideMints);
      const params = new URLSearchParams({
        inputMint: request.inputMint, outputMint: request.outputMint, amount: request.amount,
        slippageBps: String(request.slippageBps), allowAsyncExec: "false", allowSyncExec: "true",
        wrapAndUnwrapSol: "true", transactionVersion: "v0",
      });
      if (request.userPublicKey) {
        params.set("userPublicKey", request.userPublicKey);
        params.set("dynamicComputeUnitLimit", "true");
      }
      let upstream: Response;
      try {
        const endpoint = dependencies.developerMode ? "https://dev-quote-api.dflow.net/order" : DFLOW_ORDER_URL;
        upstream = await (dependencies.fetch ?? fetch)(`${endpoint}?${params}`, {
          headers: { ...(!dependencies.developerMode && apiKey ? { "x-api-key": apiKey } : {}), accept: "application/json" }, signal: AbortSignal.timeout(20_000), redirect: "error",
        });
      } catch { throw new DflowError(502, "DFLOW_UNAVAILABLE", "DFlow did not respond. Please refresh the quote."); }
      if (!upstream.ok) {
        if (upstream.status === 401 || upstream.status === 403) throw new DflowError(503, "DFLOW_ACCESS_UNAVAILABLE", "DFlow production API access is unavailable.");
        if (upstream.status === 429) throw new DflowError(429, "DFLOW_RATE_LIMITED", "DFlow is busy. Please try again shortly.");
        throw new DflowError(502, "DFLOW_NO_ROUTE", "DFlow could not return an executable route for this amount.");
      }
      const body = await upstream.json().catch(() => null);
      return validateDflowOrder(body, request);
    },
  };
}
