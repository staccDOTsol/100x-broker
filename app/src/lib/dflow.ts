import { Buffer } from "buffer";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

export type DflowParams = { inputMint: string; outputMint: string; amount: string; slippageBps: number };
export type DflowQuote = {
  provider: "DFlow";
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  minOutAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  executionMode: "sync";
  contextSlot: number;
  priceImpactPct: string;
  routePlan: { venue: string; marketKey: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string; inputMintDecimals: number; outputMintDecimals: number }[];
  transaction?: string;
  transactionVersion?: "v0";
  lastValidBlockHeight?: number;
  prioritizationFeeLamports?: number;
};
export class DflowClientError extends Error {
  constructor(message: string, public readonly code = "DFLOW_UNAVAILABLE") { super(message); }
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveU64 = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= (1n << 64n) - 1n;
const uint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const unverifiable = () => new DflowClientError("DFlow returned a trade that could not be verified. Refresh the quote.", "DFLOW_INVALID_RESPONSE");
const boundedSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000);

async function jsonResponse(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = record(body) && typeof body.error === "string" ? body.error.slice(0, 200) : "DFlow did not return a quote. Please try again.";
    const code = record(body) && typeof body.code === "string" ? body.code : "DFLOW_UNAVAILABLE";
    throw new DflowClientError(message, code);
  }
  return body;
}

export async function fetchDflowStatus(signal?: AbortSignal): Promise<boolean> {
  const body = await jsonResponse(await fetch("/api/dflow?status=1", { cache: "no-store", signal: boundedSignal(signal) }));
  if (!record(body) || body.provider !== "DFlow" || typeof body.configured !== "boolean") throw unverifiable();
  return body.configured;
}

export function validateClientQuote(body: unknown, expected: DflowParams): DflowQuote {
  if (!record(body) || body.provider !== "DFlow" || body.inputMint !== expected.inputMint || body.outputMint !== expected.outputMint ||
    body.inAmount !== expected.amount || body.slippageBps !== expected.slippageBps || body.executionMode !== "sync" ||
    !positiveU64(body.outAmount) || !positiveU64(body.minOutAmount) || body.otherAmountThreshold !== body.minOutAmount ||
    BigInt(body.minOutAmount) > BigInt(body.outAmount) ||
    BigInt(body.minOutAmount) < BigInt(body.outAmount) * BigInt(10_000 - expected.slippageBps) / 10_000n ||
    !uint(body.contextSlot) || !Array.isArray(body.routePlan) || body.routePlan.length === 0 || body.routePlan.length > 32) throw unverifiable();
  for (const hop of body.routePlan) {
    if (!record(hop) || typeof hop.venue !== "string" || hop.venue.length > 100 || typeof hop.inputMint !== "string" || typeof hop.outputMint !== "string") throw unverifiable();
  }
  return body as DflowQuote;
}

export async function fetchDflowQuote(params: DflowParams, signal?: AbortSignal): Promise<DflowQuote> {
  const query = new URLSearchParams({ ...params, slippageBps: String(params.slippageBps) });
  return validateClientQuote(await jsonResponse(await fetch(`/api/dflow?${query}`, { cache: "no-store", signal: boundedSignal(signal) })), params);
}

export async function fetchDflowOrder(params: DflowParams, userPublicKey: string, signal?: AbortSignal): Promise<DflowQuote> {
  return validateClientQuote(await jsonResponse(await fetch("/api/dflow", {
    method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", signal: boundedSignal(signal),
    body: JSON.stringify({ ...params, userPublicKey }),
  })), params);
}

/** Check quote metadata and the unsigned wallet envelope. DFlow remains the trusted transaction constructor:
 * this does not independently decode swap instruction amounts or destinations. A refreshed quoted minimum must
 * not be lower than the minimum the user reviewed. */
export function prepareDflowTransaction(order: DflowQuote, displayed: DflowQuote, expected: DflowParams, owner: PublicKey): VersionedTransaction {
  validateClientQuote(displayed, expected);
  validateClientQuote(order, expected);
  if (BigInt(order.minOutAmount) < BigInt(displayed.minOutAmount)) {
    throw new DflowClientError("The minimum received dropped. Refresh the quote and review the new price before trading.", "DFLOW_PRICE_CHANGED");
  }
  if (order.transactionVersion !== "v0" || !uint(order.lastValidBlockHeight) || order.lastValidBlockHeight === 0 ||
    typeof order.transaction !== "string" || order.transaction.length > 1644 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(order.transaction)) throw unverifiable();
  try {
    const wire = Buffer.from(order.transaction, "base64");
    if (!wire.length || wire.length > 1232 || wire.toString("base64") !== order.transaction) throw unverifiable();
    const tx = VersionedTransaction.deserialize(wire);
    if (tx.version !== 0 || tx.message.header.numRequiredSignatures !== 1 || tx.message.header.numReadonlySignedAccounts !== 0 ||
      tx.signatures.length !== 1 || tx.signatures.some((signature) => signature.some((byte) => byte !== 0)) ||
      !tx.message.staticAccountKeys[0]?.equals(owner) || !tx.message.compiledInstructions.length ||
      !Buffer.from(tx.serialize()).equals(wire)) throw unverifiable();
    return tx;
  } catch { throw unverifiable(); }
}

export function dflowRequestKey(params: DflowParams): string {
  return [params.inputMint, params.outputMint, params.amount, params.slippageBps].join(":");
}
