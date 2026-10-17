/** At most 20 requested plays; fork plays each mint two keys through two paid opening bids. */
export const MAX_WAR_BIDS = 20;
const MAX_U64 = (1n << 64n) - 1n;

export function warBidCount(value: unknown = 1): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_WAR_BIDS) throw new Error(`choose between 1 and ${MAX_WAR_BIDS} plays`);
  return count;
}

export function warBidAmounts(first: bigint, count: number): bigint[] {
  warBidCount(count);
  if (first < 1n || first + BigInt(count - 1) > MAX_U64) throw new Error("bid amount is out of range");
  return Array.from({ length: count }, (_, i) => first + BigInt(i));
}

/** Every fork is one play with two paid opening bids; all paid bids advance by one raw unit. */
export function warPlayAmounts(first: bigint, operations: readonly string[]) {
  warBidCount(operations.length);
  const count = operations.reduce((sum, op) => sum + (op === "fork" ? 2 : 1), 0);
  if (first < 1n || first + BigInt(count - 1) > MAX_U64) throw new Error("bid amount is out of range");
  let next = first;
  const moveAmounts = operations.map((op) => {
    const amount = next;
    next += op === "fork" ? 2n : 1n;
    return amount;
  });
  const lastAmount = next - 1n;
  const total = BigInt(count) * (first + lastAmount) / 2n;
  return { moveAmounts, count, plays: operations.length, lastAmount, total };
}

export const transactionTooLarge = (error: unknown) => /too large|encoding overruns|offset is out of bounds|outside.*bounds/i.test(error instanceof Error ? error.message : String(error));

/** Keep each logical instruction group atomic; only the first transaction can be simulated against today's state.
 * The instruction bound reserves compute headroom independently of serialized byte size. */
export async function packWarGroups<T>(groups: readonly (readonly T[])[], pack: (items: T[], check: boolean) => Promise<string>, maxGroups = 4, maxInstructions = Infinity): Promise<string[]> {
  const txs: string[] = [];
  let items: T[] = [];
  let groupCount = 0;
  const flush = async () => {
    if (!items.length) return;
    txs.push(await pack(items, txs.length === 0));
    items = [];
    groupCount = 0;
  };
  for (const group of groups) {
    if (!group.length) continue;
    if (group.length > maxInstructions) throw new Error("an atomic instruction group exceeds the transaction's instruction budget");
    if (groupCount >= maxGroups || items.length + group.length > maxInstructions) await flush();
    const candidate = [...items, ...group];
    try {
      await pack(candidate, false); // serialize/size check only
    } catch (error) {
      if (!items.length || !transactionTooLarge(error)) throw error;
      await flush();
      await pack([...group], false); // a group must fit by itself
    }
    items.push(...group);
    groupCount++;
  }
  await flush();
  return txs;
}
