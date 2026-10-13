//! Non-CLMM oracle venues (`Market.oracle_kind` 1..=4): account decoding for create_market and the
//! current-tick sample that feeds `oracle::read_sampled` on every rebalance.
//!
//! Tick convention is Raydium's: price = token1 per token0 (raw amounts) = 1.0001^tick, so the tick
//! rises when token0 appreciates. Decimals cancel because only tick deltas move funds.
//!
//! Per kind:
//! * PumpSwap (1): tick = log_1.0001((quote_vault + Pool.virtual_quote_reserves) / base_vault) — the
//!   price PumpSwap itself quotes (boost pools carry ~17 SOL of virtual quote; legacy/short `Pool`
//!   accounts have no field and price raw). The `Pool` is re-read at every sample. Fee buckets that
//!   v2 trades leave in the quote vault are already netted out of `virtual_quote_reserves`.
//! * Raydium CPMM (2): tick = log_1.0001(amount1 / amount0) from the two vaults' `amount` fields,
//!   read raw. The vaults also hold accrued protocol/fund/creator fees (`PoolState.*_fees_token_{0,1}`),
//!   so the raw ratio differs from the pool's own price by those balances (measured 0.02 tick on a
//!   live pool; shrinks as the pool grows).
//! * Meteora DAMM v2 (3): tick = 2 * log_1.0001(sqrt_price / 2^64), sqrt_price being Q64.64
//!   sqrt(token_b / token_a).
//! * Meteora DLMM (4): price = (1 + bin_step / 10000)^active_id (token_y per token_x), so
//!   tick = active_id * log_1.0001(1 + bin_step / 10000).
//!
//! All logs are fixed point: `log2_q64` is a 48-bit binary log (error < 2^-47 in log2 units, i.e.
//! < 1e-10 tick) and ticks are rounded to nearest, so every tick here is within 0.5 of the exact
//! value. Rounding, not flooring, keeps the sample symmetric around the true price.

use {
    crate::{consts::*, error::HookedError, state::read_address},
    pinocchio::{error::ProgramError, Address},
};

/// log2(1.0001) * 2^64, rounded.
pub const LOG2_1_0001_Q64: i128 = 2_661_169_563_308_230;
/// Fractional bits computed by `log2_q64` (the rest of the Q64 fraction is zero).
const LOG2_FRAC_BITS: u32 = 48;

/// floor-ish log2(x) in Q64 for x > 0 (48 fractional bits). Returns 0 for x == 0 (callers reject).
pub fn log2_q64(x: u128) -> i128 {
    if x == 0 {
        return 0;
    }
    let msb = 127 - x.leading_zeros();
    // mantissa normalised to [2^63, 2^64): value = r / 2^63 in [1, 2)
    let mut r: u128 = if msb >= 63 { x >> (msb - 63) } else { x << (63 - msb) };
    let mut frac: u128 = 0;
    let mut i = 0;
    while i < LOG2_FRAC_BITS {
        r = (r * r) >> 63; // [2^63, 2^65)
        if r >= 1u128 << 64 {
            frac |= 1u128 << (63 - i);
            r >>= 1;
        }
        i += 1;
    }
    ((msb as i128) << 64) | frac as i128
}

/// Round-to-nearest division of a Q64 log2 quantity by log2(1.0001): ticks. Unsigned division on
/// the magnitude keeps the binary to the u128 helpers the program already links.
fn ticks_from_log2(l_q64: i128) -> Result<i32, ProgramError> {
    let div = LOG2_1_0001_Q64 as u128;
    let mag = (l_q64.unsigned_abs() + div / 2) / div;
    let t = if l_q64 < 0 { -(mag as i128) } else { mag as i128 };
    i32::try_from(t).map_err(|_| HookedError::MathOverflow.into())
}

/// Constant-product reserves -> tick: log_1.0001(amount1 / amount0).
pub fn tick_from_reserves(amount0: u128, amount1: u128) -> Result<i32, ProgramError> {
    if amount0 == 0 || amount1 == 0 {
        return Err(HookedError::InvalidOracle.into());
    }
    ticks_from_log2(log2_q64(amount1) - log2_q64(amount0))
}

/// PumpSwap `Pool.virtual_quote_reserves`; 0 for accounts written before the field existed.
pub fn pumpswap_virtual_quote(pool_data: &[u8]) -> i128 {
    match pool_data.get(PS_VIRTUAL_QUOTE..PS_VIRTUAL_QUOTE + 16) {
        Some(b) => i128::from_le_bytes(b.try_into().unwrap()),
        None => 0,
    }
}

/// PumpSwap tick: log_1.0001((quote + virtual_quote) / base). `virtual_quote` may be negative on
/// non-boost pools (fee accruals are subtracted from it); a non-positive effective quote is rejected.
pub fn pumpswap_tick(base: u64, quote: u64, virtual_quote: i128) -> Result<i32, ProgramError> {
    let eff = (quote as i128).checked_add(virtual_quote).ok_or(HookedError::MathOverflow)?;
    if eff <= 0 {
        return Err(HookedError::InvalidOracle.into());
    }
    tick_from_reserves(base as u128, eff as u128)
}

/// Q64.64 sqrt price -> tick: 2 * log_1.0001(sqrt_price / 2^64).
pub fn tick_from_sqrt_price_x64(sqrt_price: u128) -> Result<i32, ProgramError> {
    if sqrt_price == 0 {
        return Err(HookedError::InvalidOracle.into());
    }
    ticks_from_log2(2 * (log2_q64(sqrt_price) - (64i128 << 64)))
}

/// DLMM bin -> tick: active_id * log_1.0001(1 + bin_step / 10000).
pub fn tick_from_bin(active_id: i32, bin_step: u16) -> Result<i32, ProgramError> {
    if bin_step == 0 {
        return Err(HookedError::InvalidOracle.into());
    }
    let step = log2_q64(10_000 + bin_step as u128) - log2_q64(10_000);
    ticks_from_log2(active_id as i128 * step)
}

/// What a venue pool account says; `slot_obs`/`slot_pool` are what `Market.oracle_obs`/`oracle_pool`
/// must hold for this kind, `mint0`/`mint1` the pair in tick order.
pub struct PoolInfo {
    pub slot_obs: [u8; 32],
    pub slot_pool: [u8; 32],
    pub mint0: [u8; 32],
    pub mint1: [u8; 32],
}

pub fn program_for(kind: u8) -> Option<&'static Address> {
    match kind {
        KIND_PUMPSWAP => Some(&PUMPSWAP),
        KIND_RAYDIUM_CPMM => Some(&RAYDIUM_CPMM),
        KIND_METEORA_DAMM_V2 => Some(&METEORA_DAMM_V2),
        KIND_METEORA_DLMM => Some(&METEORA_DLMM),
        _ => None,
    }
}

pub fn is_token_program(owner: &Address) -> bool {
    owner == &TOKENKEG || owner == &TOKEN_2022
}

pub fn is_quote_mint(mint: &[u8; 32]) -> bool {
    mint == WSOL.as_array() || mint == USDC.as_array() || mint == USDT.as_array()
}

/// `underlying_is_token0` the pair implies: the quote (WSOL/USDC/USDT) side is never the underlying.
/// Both sides quote-like (e.g. SOL/USDC) -> either orientation is coherent, the client's `claimed`
/// stands. Neither side quote -> rejected.
pub fn underlying_flag(mint0: &[u8; 32], mint1: &[u8; 32], claimed: u8) -> Result<u8, ProgramError> {
    match (is_quote_mint(mint0), is_quote_mint(mint1)) {
        (false, true) => Ok(1),
        (true, false) => Ok(0),
        (true, true) => Ok(claimed),
        (false, false) => Err(HookedError::UnderlyingFlagMismatch.into()),
    }
}

/// Decodes the venue pool `data` (already owner-checked by the caller) for `kind`; `pool_key` is the
/// pool's own address, which is both slots for kinds 3 and 4.
pub fn decode_pool(kind: u8, data: &[u8], pool_key: &[u8; 32]) -> Result<PoolInfo, ProgramError> {
    let bad = || ProgramError::from(HookedError::InvalidOracle);
    match kind {
        KIND_PUMPSWAP => {
            if data.len() < PS_POOL_MIN_LEN || data[..8] != PS_POOL_DISC {
                return Err(bad());
            }
            Ok(PoolInfo {
                slot_obs: *read_address(data, PS_BASE_ATA)?,
                slot_pool: *read_address(data, PS_QUOTE_ATA)?,
                mint0: *read_address(data, PS_BASE_MINT)?,
                mint1: *read_address(data, PS_QUOTE_MINT)?,
            })
        }
        KIND_RAYDIUM_CPMM => {
            if data.len() < CP_POOL_LEN || data[..8] != CP_POOL_DISC {
                return Err(bad());
            }
            Ok(PoolInfo {
                slot_obs: *read_address(data, CP_TOKEN_0_VAULT)?,
                slot_pool: *read_address(data, CP_TOKEN_1_VAULT)?,
                mint0: *read_address(data, CP_TOKEN_0_MINT)?,
                mint1: *read_address(data, CP_TOKEN_1_MINT)?,
            })
        }
        KIND_METEORA_DAMM_V2 => {
            if data.len() < DAMM_POOL_LEN || data[..8] != DAMM_POOL_DISC {
                return Err(bad());
            }
            Ok(PoolInfo {
                slot_obs: *pool_key,
                slot_pool: *pool_key,
                mint0: *read_address(data, DAMM_TOKEN_A_MINT)?,
                mint1: *read_address(data, DAMM_TOKEN_B_MINT)?,
            })
        }
        KIND_METEORA_DLMM => {
            if data.len() < DLMM_PAIR_LEN || data[..8] != DLMM_PAIR_DISC {
                return Err(bad());
            }
            Ok(PoolInfo {
                slot_obs: *pool_key,
                slot_pool: *pool_key,
                mint0: *read_address(data, DLMM_TOKEN_X_MINT)?,
                mint1: *read_address(data, DLMM_TOKEN_Y_MINT)?,
            })
        }
        _ => Err(HookedError::InvalidOracleKind.into()),
    }
}

/// Current tick of a single-account venue (kinds 3 and 4) from the pool's data.
pub fn pool_tick(kind: u8, data: &[u8]) -> Result<i32, ProgramError> {
    let bad = || ProgramError::from(HookedError::InvalidOracle);
    match kind {
        KIND_METEORA_DAMM_V2 => {
            if data.len() < DAMM_POOL_LEN || data[..8] != DAMM_POOL_DISC {
                return Err(bad());
            }
            let sp = u128::from_le_bytes(data[DAMM_SQRT_PRICE..DAMM_SQRT_PRICE + 16].try_into().unwrap());
            tick_from_sqrt_price_x64(sp)
        }
        KIND_METEORA_DLMM => {
            if data.len() < DLMM_PAIR_LEN || data[..8] != DLMM_PAIR_DISC {
                return Err(bad());
            }
            let id = i32::from_le_bytes(data[DLMM_ACTIVE_ID..DLMM_ACTIVE_ID + 4].try_into().unwrap());
            let bs = u16::from_le_bytes(data[DLMM_BIN_STEP..DLMM_BIN_STEP + 2].try_into().unwrap());
            tick_from_bin(id, bs)
        }
        _ => Err(HookedError::InvalidOracleKind.into()),
    }
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::{state::token_amount_bytes, venue_fixtures::*},
    };

    const LOG2_1_0001: f64 = 0.000_144_262_291_094_554_18;
    fn addr(s: &str) -> [u8; 32] {
        *Address::from_str_const(s).as_array()
    }
    fn exact_ratio_tick(a0: u64, a1: u64) -> f64 {
        ((a1 as f64).ln() - (a0 as f64).ln()) / 1.0001f64.ln()
    }

    #[test]
    fn log2_q64_is_accurate() {
        // integers, mantissas across the whole range, and the exact powers of two
        let cases: [u128; 12] = [1, 2, 3, 10_000, 10_001, 2_712_153_960_073, 112_903_059_368_683_291, u64::MAX as u128, 1 << 64, 6_067_185_011_641_124_888, 1 << 100, u128::MAX];
        for &x in &cases {
            let got = log2_q64(x) as f64 / 18_446_744_073_709_551_616.0;
            let want = (x as f64).log2();
            assert!((got - want).abs() < 1e-12, "log2({x}): {got} vs {want}");
        }
        assert_eq!(log2_q64(1), 0);
        assert_eq!(log2_q64(1 << 64), 64i128 << 64);
        assert_eq!(log2_q64(0), 0);
    }

    #[test]
    fn reserve_ticks_match_real_vaults() {
        // Raydium CPMM WSOL/CYBERLEEK: amounts decoded from the real vault accounts
        let v0 = unhex(RAYDIUM_CPMM_VAULT_0);
        let v1 = unhex(RAYDIUM_CPMM_VAULT_1);
        let (a0, a1) = (token_amount_bytes(&v0).unwrap(), token_amount_bytes(&v1).unwrap());
        assert_eq!((a0, a1), (2_712_153_960_073, 112_903_059_368_683_291));
        // exact: 106370.735276…
        assert_eq!(tick_from_reserves(a0 as u128, a1 as u128).unwrap(), 106_371);
        // symmetry and limits
        assert_eq!(tick_from_reserves(5, 5).unwrap(), 0);
        assert_eq!(tick_from_reserves(1, u64::MAX as u128).unwrap(), 443_636); // 443636.3759
        assert_eq!(tick_from_reserves(u64::MAX as u128, 1).unwrap(), -443_636);
        assert_eq!(tick_from_reserves(1, u128::MAX).unwrap(), 887_273); // 887272.75
        assert!(tick_from_reserves(0, 1).is_err());
        assert!(tick_from_reserves(1, 0).is_err());
    }

    /// PumpSwap HIRE/WSOL at slot ~456333555: base vault 75_893_544_954_362 (Token-2022), quote vault
    /// 322_245_176_481, `virtual_quote_reserves` 17_435_199_260. Jupiter quoted 2_213_448_384 HIRE for
    /// 0.01 SOL through this exact pool at the same time; that is the (quote + virtual) model at the
    /// pool's 95 bps fee tier (0.02 % off), and 6 % away from the raw-vault model.
    #[test]
    fn pumpswap_tick_uses_virtual_quote_and_matches_jupiter() {
        let pool = unhex(PUMPSWAP_POOL);
        let b = unhex(PUMPSWAP_BASE_ATA);
        let q = unhex(PUMPSWAP_QUOTE_ATA);
        let (bb, qb) = (token_amount_bytes(&b).unwrap(), token_amount_bytes(&q).unwrap());
        assert_eq!((bb, qb), (75_893_544_954_362, 322_245_176_481));
        let v = pumpswap_virtual_quote(&pool);
        assert_eq!(v, 17_435_199_260);
        // exact: -54093.522585…
        let tick = pumpswap_tick(bb, qb, v).unwrap();
        assert_eq!(tick, -54_094);
        // tick -> price, against the marginal price Jupiter's quote implies: a buy of n = 0.01 SOL at
        // fee f returns out = base * n(1-f) / (Q + n(1-f)), so Q = n(1-f) (base - out) / out.
        let price = 1.0001f64.powi(tick);
        let (n, out, fee) = (10_000_000f64, 2_213_448_384f64, 0.0095f64);
        let n_eff = n * (1.0 - fee);
        let jup_q = n_eff * (bb as f64 - out) / out;
        let jup_price = jup_q / bb as f64;
        assert!(((price - jup_price) / jup_price).abs() < 0.001, "{price} vs jupiter {jup_price}");
        // decoded (quote + virtual) itself is within 0.1 % of what Jupiter implies
        assert!(((qb as f64 + v as f64 - jup_q) / jup_q).abs() < 0.001);
        // the raw ratio (what a legacy pool without the field prices at) is 527 ticks = 5.4 % away
        assert_eq!(pumpswap_virtual_quote(&pool[..PS_POOL_MIN_LEN]), 0);
        assert_eq!(pumpswap_tick(bb, qb, 0).unwrap(), -54_620);
        let raw_price = 1.0001f64.powi(-54_620);
        assert!(((raw_price - jup_price) / jup_price).abs() > 0.05);
        // negative virtual (non-boost pool with un-swept v2 fees) nets off the vault; never below zero
        assert_eq!(pumpswap_tick(7, 10, -3).unwrap(), 0);
        assert!(pumpswap_tick(7, 10, -10).is_err());
        assert!(pumpswap_tick(7, 10, -11).is_err());
        assert!(pumpswap_tick(7, 10, i128::MAX).is_err());
    }

    #[test]
    fn reserve_ticks_within_half_tick_of_exact() {
        // deterministic LCG over wildly different magnitudes
        let mut s: u64 = 0x9E37_79B9_7F4A_7C15;
        for _ in 0..20_000 {
            s = s.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            let a0 = (s >> (s % 60)).max(1);
            s = s.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            let a1 = (s >> ((s >> 8) % 60)).max(1);
            let got = tick_from_reserves(a0 as u128, a1 as u128).unwrap() as f64;
            let want = exact_ratio_tick(a0, a1);
            assert!((got - want).abs() <= 0.5 + 1e-6, "{a0} {a1}: {got} vs {want}");
        }
    }

    #[test]
    fn sqrt_price_tick_matches_real_damm_pool() {
        let d = unhex(DAMM_V2_POOL);
        let sp = u128::from_le_bytes(d[DAMM_SQRT_PRICE..DAMM_SQRT_PRICE + 16].try_into().unwrap());
        assert_eq!(sp, 6_067_185_011_641_124_888);
        // price = (sp/2^64)^2 = 0.108177 USDC-raw per SOL-raw = 108.18 USDC/SOL; exact tick -22240.9747…
        assert_eq!(tick_from_sqrt_price_x64(sp).unwrap(), -22_241);
        assert_eq!(pool_tick(KIND_METEORA_DAMM_V2, &d).unwrap(), -22_241);
        assert_eq!(tick_from_sqrt_price_x64(1 << 64).unwrap(), 0);
        // sqrt(1.0001^2000) * 2^64 -> tick 2000
        let sp2000 = (1.0001f64.powi(1000) * 18_446_744_073_709_551_616.0) as u128;
        assert_eq!(tick_from_sqrt_price_x64(sp2000).unwrap(), 2_000);
        assert_eq!(tick_from_sqrt_price_x64(1).unwrap(), -887_273); // -887272.75
        assert_eq!(tick_from_sqrt_price_x64(u128::MAX).unwrap(), 887_273);
        assert!(tick_from_sqrt_price_x64(0).is_err());
    }

    #[test]
    fn bin_tick_matches_real_dlmm_pair() {
        let d = unhex(DLMM_PAIR);
        let id = i32::from_le_bytes(d[DLMM_ACTIVE_ID..DLMM_ACTIVE_ID + 4].try_into().unwrap());
        let bs = u16::from_le_bytes(d[DLMM_BIN_STEP..DLMM_BIN_STEP + 2].try_into().unwrap());
        assert_eq!((id, bs), (-22_238, 1));
        // bin_step 1 is 1.0001 exactly, so DLMM bins are Raydium ticks: 108.21 USDC/SOL, consistent
        // with the DAMM v2 pool above (-22241) at the same slot
        assert_eq!(tick_from_bin(id, bs).unwrap(), -22_238);
        assert_eq!(pool_tick(KIND_METEORA_DLMM, &d).unwrap(), -22_238);
        for id in [-443_636, -1, 0, 1, 7, 443_636] {
            assert_eq!(tick_from_bin(id, 1).unwrap(), id);
        }
        // exact: 99508.2836…, -124850.252…
        assert_eq!(tick_from_bin(1_000, 100).unwrap(), 99_508);
        assert_eq!(tick_from_bin(-5_000, 25).unwrap(), -124_850);
        for bs in [1u16, 2, 4, 5, 8, 10, 15, 16, 20, 25, 50, 80, 100, 125, 200, 250, 400] {
            for id in [-20_000i32, -3, 0, 3, 777, 20_000] {
                let got = tick_from_bin(id, bs).unwrap() as f64;
                let want = id as f64 * (1.0 + bs as f64 / 10_000.0).log2() / LOG2_1_0001;
                assert!((got - want).abs() <= 0.5 + 1e-6, "id {id} bs {bs}: {got} vs {want}");
            }
        }
        assert!(tick_from_bin(5, 0).is_err());
    }

    #[test]
    fn decodes_real_raydium_cpmm_pool() {
        let d = unhex(RAYDIUM_CPMM_POOL);
        assert_eq!(d.len(), CP_POOL_LEN);
        let key = addr("G8kgi7aUpeX8EVR8VMkrth9SKEv5BietWC33UjAiiMGh");
        let info = decode_pool(KIND_RAYDIUM_CPMM, &d, &key).unwrap();
        assert_eq!(info.slot_obs, addr("6iZNEKMsSDHG42UpDXgGd2FRNZosEDe7RbLwjNPAtaKU"));
        assert_eq!(info.slot_pool, addr("4cQ4QmL4h85RyEVzb1bWsmvd25zMdgkAKipVyKqpKs5Y"));
        assert_eq!(&info.mint0, WSOL.as_array());
        assert_eq!(info.mint1, addr("ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg"));
        // the vault accounts hold exactly those mints
        assert_eq!(&unhex(RAYDIUM_CPMM_VAULT_0)[..32], &info.mint0);
        assert_eq!(&unhex(RAYDIUM_CPMM_VAULT_1)[..32], &info.mint1);
        // WSOL is token0 -> the underlying is token1 whatever the client claims
        assert_eq!(underlying_flag(&info.mint0, &info.mint1, 1).unwrap(), 0);
        assert_eq!(underlying_flag(&info.mint0, &info.mint1, 0).unwrap(), 0);
        // other kinds reject these bytes
        assert!(decode_pool(KIND_PUMPSWAP, &d, &key).is_err());
        assert!(decode_pool(KIND_METEORA_DAMM_V2, &d, &key).is_err());
        assert!(decode_pool(KIND_METEORA_DLMM, &d, &key).is_err());
        assert!(decode_pool(KIND_RAYDIUM_CPMM, &d[..CP_POOL_LEN - 1], &key).is_err());
    }

    #[test]
    fn decodes_real_pumpswap_pool() {
        let d = unhex(PUMPSWAP_POOL);
        assert_eq!(d.len(), 301);
        let key = addr("2U5kdozDrdgYzyGRNbTdBejGLYEeRt1FkERQmyPbV85P");
        let info = decode_pool(KIND_PUMPSWAP, &d, &key).unwrap();
        assert_eq!(info.slot_obs, addr("BHtcjUisZcEPKAFRZXqp3E32skkCK5474Lu6VJt2eGRD"));
        assert_eq!(info.slot_pool, addr("3Kqj6sroN1ZHeKj14tWkRurndm1pqmQehNyLxE4vfRHa"));
        assert_eq!(info.mint0, addr("98AG3zJUawbvDnpgbDhmxpMKva43vtgPLLPSXqo1pump"));
        assert_eq!(&info.mint1, WSOL.as_array());
        assert_eq!(&unhex(PUMPSWAP_BASE_ATA)[..32], &info.mint0);
        assert_eq!(&unhex(PUMPSWAP_QUOTE_ATA)[..32], &info.mint1);
        // base is the underlying -> token0
        assert_eq!(underlying_flag(&info.mint0, &info.mint1, 0).unwrap(), 1);
        // the shortest historical layout still decodes; shorter does not
        assert!(decode_pool(KIND_PUMPSWAP, &d[..PS_POOL_MIN_LEN], &key).is_ok());
        assert!(decode_pool(KIND_PUMPSWAP, &d[..PS_POOL_MIN_LEN - 1], &key).is_err());
        assert!(decode_pool(KIND_RAYDIUM_CPMM, &d, &key).is_err());
        // same anchor discriminator as DAMM v2, but far too short for it
        assert!(decode_pool(KIND_METEORA_DAMM_V2, &d, &key).is_err());
    }

    #[test]
    fn decodes_real_damm_v2_pool() {
        let d = unhex(DAMM_V2_POOL);
        assert_eq!(d.len(), DAMM_POOL_LEN);
        let key = addr("8Pm2kZpnxD3hoMmt4bjStX2Pw2Z9abpbHzZxMPqxPmie");
        let info = decode_pool(KIND_METEORA_DAMM_V2, &d, &key).unwrap();
        assert_eq!(info.slot_obs, key);
        assert_eq!(info.slot_pool, key);
        assert_eq!(&info.mint0, WSOL.as_array());
        assert_eq!(&info.mint1, USDC.as_array());
        // both quote-like: the client's orientation stands
        assert_eq!(underlying_flag(&info.mint0, &info.mint1, 1).unwrap(), 1);
        assert_eq!(underlying_flag(&info.mint0, &info.mint1, 0).unwrap(), 0);
        assert!(decode_pool(KIND_METEORA_DLMM, &d, &key).is_err());
        assert!(pool_tick(KIND_METEORA_DLMM, &d).is_err());
        assert!(pool_tick(KIND_METEORA_DAMM_V2, &d[..DAMM_POOL_LEN - 1]).is_err());
    }

    #[test]
    fn decodes_real_dlmm_pair() {
        let d = unhex(DLMM_PAIR);
        assert_eq!(d.len(), DLMM_PAIR_LEN);
        let key = addr("HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR");
        let info = decode_pool(KIND_METEORA_DLMM, &d, &key).unwrap();
        assert_eq!(info.slot_obs, key);
        assert_eq!(info.slot_pool, key);
        assert_eq!(&info.mint0, WSOL.as_array());
        assert_eq!(&info.mint1, USDC.as_array());
        assert!(decode_pool(KIND_METEORA_DAMM_V2, &d, &key).is_err());
        assert!(pool_tick(KIND_METEORA_DAMM_V2, &d).is_err());
        assert!(decode_pool(5, &d, &key).is_err());
        assert!(pool_tick(KIND_PUMPSWAP, &d).is_err());
    }

    #[test]
    fn quote_set_and_flags() {
        let x = [9u8; 32];
        let y = [8u8; 32];
        assert!(is_quote_mint(WSOL.as_array()) && is_quote_mint(USDC.as_array()) && is_quote_mint(USDT.as_array()));
        assert!(!is_quote_mint(&x));
        assert!(underlying_flag(&x, &y, 0).is_err());
        assert_eq!(underlying_flag(&x, USDT.as_array(), 0).unwrap(), 1);
        assert_eq!(underlying_flag(USDC.as_array(), &x, 1).unwrap(), 0);
        assert_eq!(program_for(KIND_PUMPSWAP), Some(&PUMPSWAP));
        assert_eq!(program_for(KIND_RAYDIUM_CPMM), Some(&RAYDIUM_CPMM));
        assert_eq!(program_for(KIND_METEORA_DAMM_V2), Some(&METEORA_DAMM_V2));
        assert_eq!(program_for(KIND_METEORA_DLMM), Some(&METEORA_DLMM));
        assert_eq!(program_for(KIND_RAYDIUM_CLMM), None);
        assert_eq!(program_for(5), None);
    }
}
