//! 256-bit mul/div, Raydium tick -> sqrt price (Q64.64), and CLMM position amounts.

/// (hi, lo) of a * b.
fn mul_wide(a: u128, b: u128) -> (u128, u128) {
    let (a1, a0) = (a >> 64, a & u64::MAX as u128);
    let (b1, b0) = (b >> 64, b & u64::MAX as u128);
    let ll = a0 * b0;
    let lh = a0 * b1;
    let hl = a1 * b0;
    let hh = a1 * b1;
    let (mid, c1) = lh.overflowing_add(hl);
    let carry_mid = if c1 { 1u128 << 64 } else { 0 };
    let (lo, c2) = ll.overflowing_add(mid << 64);
    let hi = hh + (mid >> 64) + carry_mid + if c2 { 1 } else { 0 };
    (hi, lo)
}

/// floor((hi:lo) / d); None if the quotient does not fit in u128 or d == 0.
fn div_wide(hi: u128, lo: u128, d: u128) -> Option<u128> {
    if d == 0 || hi >= d {
        return None;
    }
    if hi == 0 {
        return Some(lo / d);
    }
    let mut rem = hi;
    let mut q: u128 = 0;
    for i in (0..128).rev() {
        let top = rem >> 127;
        rem = (rem << 1) | ((lo >> i) & 1);
        if top == 1 || rem >= d {
            rem = rem.wrapping_sub(d);
            q |= 1 << i;
        }
    }
    Some(q)
}

/// floor(a * b / c) with a 256-bit intermediate.
pub fn mul_div(a: u128, b: u128, c: u128) -> Option<u128> {
    let (hi, lo) = mul_wide(a, b);
    div_wide(hi, lo, c)
}

/// floor(a * b / 2^64)
pub fn mul_shr64(a: u128, b: u128) -> Option<u128> {
    let (hi, lo) = mul_wide(a, b);
    if hi >> 64 != 0 {
        return None;
    }
    Some((hi << 64) | (lo >> 64))
}

pub const MIN_TICK: i32 = -443636;
pub const MAX_TICK: i32 = 443636;

/// sqrt(1.0001^tick) * 2^64 — the Raydium CLMM tick table (Uniswap constants at 64-bit precision).
pub fn sqrt_price_at_tick(tick: i32) -> Option<u128> {
    if !(MIN_TICK..=MAX_TICK).contains(&tick) {
        return None;
    }
    let abs = tick.unsigned_abs();
    let mut ratio: u128 = if abs & 0x1 != 0 { 0xfffcb933bd6fb800 } else { 1 << 64 };
    const K: [(u32, u128); 18] = [
        (0x2, 0xfff97272373d4000),
        (0x4, 0xfff2e50f5f657000),
        (0x8, 0xffe5caca7e10f000),
        (0x10, 0xffcb9843d60f7000),
        (0x20, 0xff973b41fa98e800),
        (0x40, 0xff2ea16466c9b000),
        (0x80, 0xfe5dee046a9a3800),
        (0x100, 0xfcbe86c7900bb000),
        (0x200, 0xf987a7253ac65800),
        (0x400, 0xf3392b0822bb6000),
        (0x800, 0xe7159475a2caf000),
        (0x1000, 0xd097f3bdfd2f2000),
        (0x2000, 0xa9f746462d9f8000),
        (0x4000, 0x70d869a156f31c00),
        (0x8000, 0x31be135f97ed3200),
        (0x10000, 0x9aa508b5b85a500),
        (0x20000, 0x5d6af8dedc582c),
        (0x40000, 0x2216e584f5fa),
    ];
    for (bit, k) in K {
        if abs & bit != 0 {
            ratio = mul_shr64(ratio, k)?;
        }
    }
    if tick > 0 {
        ratio = u128::MAX / ratio;
    }
    Some(ratio)
}

/// token0 owed by `liquidity` between sqrt prices a < b: L * (b - a) * 2^64 / (a * b).
pub fn amount0(liquidity: u128, a: u128, b: u128) -> Option<u128> {
    if a == 0 || b <= a {
        return Some(0);
    }
    // (L << 64) overflows for large L, so do L * (b-a) / b first, then * 2^64 / a.
    let t = mul_div(liquidity, b - a, b)?;
    mul_div(t, 1 << 64, a)
}

/// token1 owed by `liquidity` between sqrt prices a < b: L * (b - a) / 2^64.
pub fn amount1(liquidity: u128, a: u128, b: u128) -> Option<u128> {
    if b <= a {
        return Some(0);
    }
    mul_shr64(liquidity, b - a)
}

/// (token0, token1) held by a position with `liquidity` over [lower, upper] at price `sqrt_p`.
pub fn position_amounts(liquidity: u128, sqrt_p: u128, lower: u128, upper: u128) -> Option<(u128, u128)> {
    if liquidity == 0 {
        return Some((0, 0));
    }
    if sqrt_p <= lower {
        Some((amount0(liquidity, lower, upper)?, 0))
    } else if sqrt_p < upper {
        Some((amount0(liquidity, sqrt_p, upper)?, amount1(liquidity, lower, sqrt_p)?))
    } else {
        Some((0, amount1(liquidity, lower, upper)?))
    }
}

/// token1 per token0 as Q64 from a Q64 sqrt price.
pub fn price_x64(sqrt_p: u128) -> Option<u128> {
    mul_shr64(sqrt_p, sqrt_p)
}

/// Value of `amount` of token0 in token1 units (Q64 price), floor.
pub fn to_token1(amount: u128, price: u128) -> Option<u128> {
    mul_shr64(amount, price)
}

/// Value of `amount` of token1 in token0 units.
pub fn to_token0(amount: u128, price: u128) -> Option<u128> {
    if price == 0 {
        return None;
    }
    mul_div(amount, 1 << 64, price)
}

/// a * b / c for u64 (fits by construction of callers).
pub fn mul_div_u64(a: u64, b: u64, c: u64) -> Option<u64> {
    if c == 0 {
        return None;
    }
    u64::try_from((a as u128) * (b as u128) / (c as u128)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_math() {
        assert_eq!(mul_div(u128::MAX, 3, 3), Some(u128::MAX));
        assert_eq!(mul_div(1 << 100, 1 << 100, 1 << 100), Some(1 << 100));
        assert_eq!(mul_shr64(1 << 64, 1 << 64), Some(1 << 64));
        assert_eq!(mul_shr64(3 << 64, 5 << 62), Some(15 << 62));
        assert_eq!(mul_div(7, 11, 0), None);
        assert_eq!(div_wide(1 << 127, 0, 1 << 120), None); // quotient 2^135 does not fit
    }

    #[test]
    fn div_wide_exact() {
        // (2^130) / 2^66 = 2^64
        assert_eq!(div_wide(1 << 2, 0, 1 << 66), Some(1 << 64));
        // (2^128 + 5) / 1 = overflow
        assert_eq!(div_wide(1, 5, 1), None);
        // random-ish check
        let a: u128 = 123_456_789_012_345_678_901_234_567_890;
        let b: u128 = 987_654_321_098_765_432;
        let (hi, lo) = mul_wide(a, b);
        assert_eq!(div_wide(hi, lo, b), Some(a));
        assert_eq!(div_wide(hi, lo, a), Some(b));
    }

    #[test]
    fn tick_table() {
        // tick 0 -> 2^64 exactly
        assert_eq!(sqrt_price_at_tick(0), Some(1 << 64));
        // sqrt(1.0001) and its inverse
        let p1 = sqrt_price_at_tick(1).unwrap() as f64 / 2f64.powi(64);
        assert!((p1 - 1.0001f64.sqrt()).abs() < 1e-9, "{p1}");
        let m1 = sqrt_price_at_tick(-1).unwrap() as f64 / 2f64.powi(64);
        assert!((m1 - 1.0 / 1.0001f64.sqrt()).abs() < 1e-9, "{m1}");
        for t in [-443636i32, -200000, -50000, -1234, 1234, 50000, 200000, 443636] {
            let got = sqrt_price_at_tick(t).unwrap() as f64 / 2f64.powi(64);
            let want = 1.0001f64.powf(t as f64 / 2.0);
            assert!(((got - want) / want).abs() < 1e-7, "tick {t}: {got} vs {want}");
        }
        // Raydium MIN/MAX sqrt prices
        assert_eq!(sqrt_price_at_tick(MIN_TICK), Some(4295048016));
        assert_eq!(sqrt_price_at_tick(MAX_TICK), Some(79226673521066979257578248091));
    }

    #[test]
    fn position_math() {
        // full-ish range at price 1: half liquidity each side
        let p = 1u128 << 64;
        let lo = sqrt_price_at_tick(-100000).unwrap();
        let hi = sqrt_price_at_tick(100000).unwrap();
        let l = 1_000_000_000_000u128;
        let (a0, a1) = position_amounts(l, p, lo, hi).unwrap();
        // amount0 = L*(hi-p)/(p*hi)*2^64 ~ L*(1 - 1/sqrt(hi)); amount1 = L*(p-lo)/2^64 ~ L*(1-sqrt(lo))
        let h = hi as f64 / 2f64.powi(64);
        let lf = lo as f64 / 2f64.powi(64);
        let w0 = l as f64 * (h - 1.0) / h;
        let w1 = l as f64 * (1.0 - lf);
        assert!(((a0 as f64 - w0) / w0).abs() < 1e-6, "{a0} {w0}");
        assert!(((a1 as f64 - w1) / w1).abs() < 1e-6, "{a1} {w1}");
        assert_eq!(position_amounts(l, lo / 2, lo, hi).unwrap().1, 0);
        assert_eq!(position_amounts(l, hi * 2, lo, hi).unwrap().0, 0);
        assert_eq!(position_amounts(0, p, lo, hi), Some((0, 0)));
    }

    #[test]
    fn price_conversions() {
        let sp = sqrt_price_at_tick(-20000).unwrap(); // price ~ 0.1353
        let px = price_x64(sp).unwrap();
        let v = to_token1(1_000_000, px).unwrap();
        let want = 1e6 * 1.0001f64.powi(-20000);
        assert!((v as f64 - want).abs() < 2.0, "{v} vs {want}");
        let back = to_token0(v, px).unwrap();
        assert!((back as i128 - 1_000_000).abs() < 20, "{back}");
    }
}
