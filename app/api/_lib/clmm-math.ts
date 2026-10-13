// Raydium CLMM math in BigInt (mirrors programs/dnvault/src/math.rs): tick -> sqrt price Q64, position amounts, liquidity from amounts.
export const MIN_TICK = -443636;
export const MAX_TICK = 443636;
const Q64 = 1n << 64n;
const K: [number, bigint][] = [
  [0x2, 0xfff97272373d4000n], [0x4, 0xfff2e50f5f657000n], [0x8, 0xffe5caca7e10f000n], [0x10, 0xffcb9843d60f7000n],
  [0x20, 0xff973b41fa98e800n], [0x40, 0xff2ea16466c9b000n], [0x80, 0xfe5dee046a9a3800n], [0x100, 0xfcbe86c7900bb000n],
  [0x200, 0xf987a7253ac65800n], [0x400, 0xf3392b0822bb6000n], [0x800, 0xe7159475a2caf000n], [0x1000, 0xd097f3bdfd2f2000n],
  [0x2000, 0xa9f746462d9f8000n], [0x4000, 0x70d869a156f31c00n], [0x8000, 0x31be135f97ed3200n], [0x10000, 0x9aa508b5b85a500n],
  [0x20000, 0x5d6af8dedc582cn], [0x40000, 0x2216e584f5fan],
];
const U128_MAX = (1n << 128n) - 1n;

export function sqrtPriceAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick ${tick} out of range`);
  const abs = Math.abs(tick);
  let ratio = abs & 1 ? 0xfffcb933bd6fb800n : Q64;
  for (const [bit, k] of K) if (abs & bit) ratio = (ratio * k) >> 64n;
  return tick > 0 ? U128_MAX / ratio : ratio;
}

export const amount0 = (L: bigint, a: bigint, b: bigint) => (a === 0n || b <= a ? 0n : (((L * (b - a)) / b) << 64n) / a);
export const amount1 = (L: bigint, a: bigint, b: bigint) => (b <= a ? 0n : (L * (b - a)) >> 64n);

/** (token0, token1) held by `L` over [lower, upper] at price `sqrtP`. */
export function positionAmounts(L: bigint, sqrtP: bigint, lower: bigint, upper: bigint): [bigint, bigint] {
  if (L === 0n) return [0n, 0n];
  if (sqrtP <= lower) return [amount0(L, lower, upper), 0n];
  if (sqrtP < upper) return [amount0(L, sqrtP, upper), amount1(L, lower, sqrtP)];
  return [0n, amount1(L, lower, upper)];
}

export const liquidityFromAmount0 = (a: bigint, b: bigint, amt0: bigint) => (b <= a ? 0n : (amt0 * ((a * b) >> 64n)) / (b - a));
export const liquidityFromAmount1 = (a: bigint, b: bigint, amt1: bigint) => (b <= a ? 0n : (amt1 << 64n) / (b - a));

/** Largest liquidity both amounts can fund over [lower, upper] at `sqrtP`. */
export function liquidityFromAmounts(sqrtP: bigint, lower: bigint, upper: bigint, amt0: bigint, amt1: bigint): bigint {
  if (sqrtP <= lower) return liquidityFromAmount0(lower, upper, amt0);
  if (sqrtP < upper) {
    const l0 = liquidityFromAmount0(sqrtP, upper, amt0);
    const l1 = liquidityFromAmount1(lower, sqrtP, amt1);
    return l0 < l1 ? l0 : l1;
  }
  return liquidityFromAmount1(lower, upper, amt1);
}

export const priceX64 = (sqrtP: bigint) => (sqrtP * sqrtP) >> 64n;
