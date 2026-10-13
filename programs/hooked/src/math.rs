//! Fixed-point helpers. Q64 = value * 2^64, Q63 = value * 2^63, Q32 ticks = tick * 2^32.

pub const ONE_Q64: u128 = 1 << 64;
pub const ONE_Q63: u64 = 1 << 63;
/// ln(1.0001) * 2^64
pub const LN_1_0001_Q64: u128 = 1_844_582_179_799_040;
/// ln(2) * 2^64
pub const LN2_Q64: u128 = 12_786_308_645_202_655_659;

/// floor(exp(-y) * 2^64) for y in Q64.
pub fn exp_neg_q64(y: u128) -> u128 {
    // exp(-44) < 2^-63
    if y >= 44 * ONE_Q64 {
        return 0;
    }
    let k = y / LN2_Q64;
    let r = y - k * LN2_Q64; // [0, ln2)
    // exp(-r) = sum (-r)^n / n!, alternating; r < 0.7 so 22 terms reach < 2^-64.
    let mut term: u128 = ONE_Q64;
    let mut sum: i128 = ONE_Q64 as i128;
    let mut n: u128 = 1;
    while n <= 22 {
        term = ((term * r) >> 64) / n;
        if term == 0 {
            break;
        }
        if n & 1 == 1 {
            sum -= term as i128;
        } else {
            sum += term as i128;
        }
        n += 1;
    }
    let s = if sum < 0 { 0 } else { sum as u128 };
    if k >= 128 {
        0
    } else {
        s >> k
    }
}

/// Fraction the losing side keeps, 1.0001^(-LEVERAGE * |du|), as Q64. `du_q32_abs` is |Δtick| in Q32.
pub fn keep_factor_q64(du_q32_abs: u64, leverage: u128) -> u128 {
    // y = L * |du| * ln(1.0001); du Q32 * LN Q64 = Q96 -> >> 32 = Q64
    let y = (du_q32_abs as u128)
        .saturating_mul(leverage)
        .saturating_mul(LN_1_0001_Q64)
        >> 32;
    exp_neg_q64(y)
}

/// floor(balance * (1 - keep)) — what the losing vault pays.
pub fn loss_amount(balance: u64, keep_q64: u128) -> u64 {
    let keep = if keep_q64 > ONE_Q64 { ONE_Q64 } else { keep_q64 };
    (((balance as u128) * (ONE_Q64 - keep)) >> 64) as u64
}

/// Q63 * Q64 -> Q63
pub fn mul_q63_q64(a_q63: u64, b_q64: u128) -> u64 {
    let b = if b_q64 > ONE_Q64 { ONE_Q64 } else { b_q64 };
    (((a_q63 as u128) * b) >> 64) as u64
}

pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = 1u128 << ((128 - n.leading_zeros() + 1) / 2);
    loop {
        let y = (x + n / x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// sqrt(keep) as Q64, keep in Q63 (< 1.0).
pub fn sqrt_keep_q64(keep_q63: u64) -> u128 {
    // sqrt(keep/2^63) * 2^64 = sqrt(keep * 2^65)
    isqrt((keep_q63 as u128) << 65)
}

/// floor(s0 * sqrt_keep / 2^64), exact for s0 < 2^96 and sqrt_keep <= 2^64.
pub fn scale_sqrt_price(s0: u128, sqrt_keep_q64: u128) -> u128 {
    let hi = s0 >> 64;
    let lo = s0 & (u64::MAX as u128);
    hi * sqrt_keep_q64 + ((lo * sqrt_keep_q64) >> 64)
}

/// (target / s1)^2 as Q63, saturating at 1.0.
pub fn remaining_keep_q63(target: u128, s1: u128) -> u64 {
    if target >= s1 {
        return ONE_Q63;
    }
    // r = target / s1 in Q64 with >= 64 significant bits: shift target up as far as it goes
    // (<= 64) and s1 down by the remainder.
    let z = target.leading_zeros().min(64);
    let den = s1 >> (64 - z);
    if den == 0 {
        return ONE_Q63;
    }
    let r = (target << z) / den; // < 2^64
    ((r * r) >> 65) as u64
}

/// a * b / c with a 128-bit intermediate.
pub fn mul_div(a: u64, b: u64, c: u64) -> Option<u64> {
    if c == 0 {
        return None;
    }
    u64::try_from((a as u128) * (b as u128) / (c as u128)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(q: u128) -> f64 {
        q as f64 / ONE_Q64 as f64
    }

    #[test]
    fn exp_matches_f64() {
        for &y in &[0.0, 1e-9, 1e-4, 0.01, 0.3, 0.69, 0.7, 1.0, 2.5, 5.0, 10.0, 20.0, 40.0] {
            let yq = (y * ONE_Q64 as f64) as u128;
            let got = f(exp_neg_q64(yq));
            let want = (-y as f64).exp();
            assert!((got - want).abs() <= want * 1e-12 + 1e-18, "y={y} got={got} want={want}");
        }
        assert_eq!(exp_neg_q64(44 * ONE_Q64), 0);
    }

    #[test]
    fn keep_factor_l100() {
        // 1% move ~ 100.5 ticks; at L=100 keep = 1.0001^-10050 ~ 0.366
        let ticks: f64 = (1.01f64).ln() / (1.0001f64).ln();
        let du = (ticks * 4294967296.0) as u64;
        let k = f(keep_factor_q64(du, 100));
        // loser keeps (1/1.01)^100 ~ 0.3697 of its vault
        assert!((k - (1.0f64 / 1.01).powi(100)).abs() < 1e-9, "k={k}");
    }

    #[test]
    fn loss_and_keep() {
        assert_eq!(loss_amount(1_000_000, ONE_Q64), 0);
        assert_eq!(loss_amount(1_000_000, 0), 1_000_000);
        assert_eq!(loss_amount(1_000_000, ONE_Q64 / 4), 750_000);
        assert_eq!(mul_q63_q64(ONE_Q63, ONE_Q64 / 2), ONE_Q63 / 2);
    }

    #[test]
    fn sqrt_paths() {
        let k = ONE_Q63 / 4; // 0.25 -> sqrt 0.5
        let s = sqrt_keep_q64(k);
        assert!((f(s) - 0.5).abs() < 1e-15);
        let s0: u128 = 91_396_790_948_438_988; // real DBC pool
        let t = scale_sqrt_price(s0, s);
        assert!(((t as f64) / (s0 as f64) - 0.5).abs() < 1e-8);
        // fully settled -> nothing owed; half-way in price -> keep 0.5 remains
        assert_eq!(remaining_keep_q63(t, t), ONE_Q63);
        let s1 = (s0 as f64 * (0.5f64).sqrt()) as u128; // price at 0.5
        let rem = remaining_keep_q63(t, s1) as f64 / ONE_Q63 as f64;
        assert!((rem - 0.5).abs() < 1e-6, "rem={rem}");
    }

    #[test]
    fn isqrt_exact() {
        for n in [0u128, 1, 2, 3, 4, 15, 16, 17, 1 << 100, u128::MAX] {
            let r = isqrt(n);
            assert!(r * r <= n);
            assert!((r + 1).checked_mul(r + 1).map_or(true, |v| v > n));
        }
    }
}
