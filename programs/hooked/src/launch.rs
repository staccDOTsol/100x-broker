//! Companion pump.fun coins ("launches"): the pure checks and arithmetic behind `register_launch`
//! and `boost`, kept free of account types so they run against raw fixtures in tests.
//!
//! Creator-fee routing (pump-public-docs `docs/instructions/CREATOR_FEE_SHARING.md`): the coin's
//! creator (a normal wallet) calls Pump Fees `create_fee_sharing_config`, which rewrites
//! `BondingCurve.creator` to the `SharingConfig` PDA `["sharing-config", mint]`, then
//! `update_fee_shares_v2` with up to 10 `{address, share_bps}` entries summing to 10_000 (addresses
//! do not sign; this can be done once, after which `admin_revoked` is set). Permissionless
//! `distribute_creator_fees_v2` then pays each shareholder's ATA for the coin's quote mint. With the
//! Launch PDA as a shareholder, its MEME_MINT ATA is where the fees land.

use {
    crate::{consts::*, error::HookedError, state::read_address},
    pinocchio::error::ProgramError,
};

/// Fields of a pump BondingCurve `register_launch` cares about.
pub struct CurveInfo {
    pub creator: [u8; 32],
    pub quote_mint: [u8; 32],
    pub complete: bool,
    pub creator_fee_bps: u64,
    pub depth: u8,
}

/// Decodes `data` (already owner-checked as pump's) as a create_v2-era BondingCurve.
pub fn decode_curve(data: &[u8]) -> Result<CurveInfo, ProgramError> {
    if data.len() < BC_LEN_V2 || data[..8] != BC_DISC {
        return Err(HookedError::InvalidLaunchCurve.into());
    }
    Ok(CurveInfo {
        creator: *read_address(data, BC_CREATOR)?,
        quote_mint: *read_address(data, BC_QUOTE_MINT)?,
        complete: data[BC_COMPLETE] != 0,
        creator_fee_bps: u64::from_le_bytes(data[BC_CREATOR_FEE_BPS..BC_CREATOR_FEE_BPS + 8].try_into().unwrap()),
        depth: data[BC_DEPTH],
    })
}

/// The shareholder list a `mode` requires: lister at LAUNCH_LISTER_BPS + launch at the rest (mode 0),
/// or the launch alone (mode 1). Order-insensitive; nothing else may be on the list.
pub fn shares_match_mode(sc: &[u8], lister: &[u8; 32], launch: &[u8; 32], mode: u8) -> bool {
    let n = match sc.get(SC_SHAREHOLDERS_LEN..SC_SHAREHOLDERS_LEN + 4) {
        Some(b) => u32::from_le_bytes(b.try_into().unwrap()) as usize,
        None => return false,
    };
    if n == 0 || n > SC_MAX_SHAREHOLDERS || sc.len() < SC_SHAREHOLDERS + n * SC_SHAREHOLDER_SIZE {
        return false;
    }
    let (mut lister_bps, mut launch_bps, mut others) = (0u16, 0u16, 0usize);
    for i in 0..n {
        let o = SC_SHAREHOLDERS + i * SC_SHAREHOLDER_SIZE;
        let addr: &[u8; 32] = sc[o..o + 32].try_into().unwrap();
        let bps = u16::from_le_bytes([sc[o + 32], sc[o + 33]]);
        if addr == launch {
            launch_bps = bps;
        } else if addr == lister {
            lister_bps = bps;
        } else {
            others += 1;
        }
    }
    if others != 0 {
        return false;
    }
    match mode {
        LAUNCH_MODE_SHARED => n == 2 && lister_bps == LAUNCH_LISTER_BPS && launch_bps == 10_000 - LAUNCH_LISTER_BPS,
        LAUNCH_MODE_FULL => n == 1 && launch_bps == 10_000,
        _ => false,
    }
}

/// A live, final SharingConfig for `mint` administered by `lister` whose shares match `mode`.
pub fn check_sharing_config(sc: &[u8], mint: &[u8; 32], lister: &[u8; 32], launch: &[u8; 32], mode: u8) -> Result<(), ProgramError> {
    let bad = || ProgramError::from(HookedError::InvalidSharingConfig);
    if sc.len() < SC_SHAREHOLDERS || sc[..8] != SC_DISC {
        return Err(bad());
    }
    if sc[SC_STATUS] != 1 || read_address(sc, SC_MINT)? != mint || read_address(sc, SC_ADMIN)? != lister || sc[SC_ADMIN_REVOKED] != 1 {
        return Err(bad());
    }
    if !shares_match_mode(sc, lister, launch, mode) {
        return Err(bad());
    }
    Ok(())
}

/// register_launch's creator rule. `sc_data` is the SharingConfig PDA's data when that account exists.
/// Either the curve's creator is still the lister (fees not yet shared on-chain; `mode` is the lister's
/// promise of how they will be), or it is the SharingConfig, which must then be final and match `mode`.
#[allow(clippy::too_many_arguments)]
pub fn check_creator(
    curve: &CurveInfo,
    mint: &[u8; 32],
    lister: &[u8; 32],
    launch: &[u8; 32],
    sc_key: &[u8; 32],
    sc_data: Option<&[u8]>,
    mode: u8,
) -> Result<(), ProgramError> {
    if &curve.creator == lister {
        return Ok(());
    }
    if &curve.creator != sc_key {
        return Err(HookedError::InvalidLaunchCreator.into());
    }
    let sc = sc_data.ok_or(HookedError::InvalidSharingConfig)?;
    check_sharing_config(sc, mint, lister, launch, mode)
}

/// How `boost` divides the MEME the Launch PDA holds. `None` below BOOST_DUST (no-op).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BoostSplit {
    pub lister: u64,
    pub burn: u64,
    pub sell: u64,
}

pub fn boost_split(balance: u64, mode: u8) -> Result<Option<BoostSplit>, ProgramError> {
    if balance < BOOST_DUST {
        return Ok(None);
    }
    let s = match mode {
        // the PDA holds 90 % of the fee: burn 1/9 of it (= 10 % of the fee), sell the rest (= 80 %)
        LAUNCH_MODE_SHARED => {
            let burn = balance / 9;
            BoostSplit { lister: 0, burn, sell: balance - burn }
        }
        LAUNCH_MODE_FULL => {
            let lister = balance / 10;
            let burn = balance / 10;
            BoostSplit { lister, burn, sell: balance - lister - burn }
        }
        _ => return Err(HookedError::InvalidLaunch.into()),
    };
    Ok(Some(s))
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::{launch_fixtures::*, venue_fixtures::unhex},
        pinocchio::Address,
    };

    fn addr(s: &str) -> [u8; 32] {
        *Address::from_str_const(s).as_array()
    }

    /// $100XBRO's own curve: SOL-quoted (all-zero quote_mint), complete, depth 0, creator 331nEB….
    #[test]
    fn decodes_real_sol_quoted_curve() {
        let d = unhex(MEME_CURVE);
        assert_eq!(d.len(), BC_LEN_V2);
        let c = decode_curve(&d).unwrap();
        assert_eq!(c.creator, addr("331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth"));
        assert_eq!(c.quote_mint, [0u8; 32]);
        assert!(c.complete);
        assert_eq!(c.creator_fee_bps, 0);
        assert_eq!(c.depth, 0);
        // the earlier fixed offsets still line up with the IDL
        assert_eq!(u64::from_le_bytes(d[40..48].try_into().unwrap()), 1_000_000_000_000_000);
        assert_eq!(u64::from_le_bytes(d[142..150].try_into().unwrap()), 30_000_000_000); // initial_virtual_quote_reserves
        assert!(decode_curve(&d[..BC_LEN_V2 - 1]).is_err());
        let mut bad = d.clone();
        bad[0] ^= 1;
        assert!(decode_curve(&bad).is_err());
    }

    /// A live coin paired with a pump coin (depth 1): quote_mint is that coin, the "sol" reserve fields
    /// hold quote-token amounts and initial_virtual_quote_reserves = virtual - real.
    #[test]
    fn decodes_real_pump_coin_quoted_curve() {
        let d = unhex(PUMP_QUOTED_CURVE);
        assert_eq!(d.len(), BC_LEN_V2);
        let c = decode_curve(&d).unwrap();
        assert_eq!(c.quote_mint, addr(PUMP_QUOTED_CURVE_QUOTE));
        assert!(!c.complete);
        assert_eq!(c.depth, 1);
        assert_eq!(c.creator_fee_bps, 0);
        let vq = u64::from_le_bytes(d[16..24].try_into().unwrap());
        let rq = u64::from_le_bytes(d[32..40].try_into().unwrap());
        let ivq = u64::from_le_bytes(d[142..150].try_into().unwrap());
        assert_eq!(vq, ivq + rq);
        assert_eq!(u64::from_le_bytes(d[8..16].try_into().unwrap()), 1_073_000_000_000_000);
        assert_eq!(u64::from_le_bytes(d[24..32].try_into().unwrap()), 793_100_000_000_000);
    }

    /// Live SharingConfig for FT7PTm…: version 1, Active, admin = sole 10_000 bps shareholder, not revoked.
    #[test]
    fn decodes_real_sharing_config() {
        let d = unhex(SHARING_CONFIG);
        assert_eq!(d.len(), 1024);
        assert_eq!(d[..8], SC_DISC);
        assert_eq!(d[SC_STATUS], 1);
        let mint = addr("FT7PTm96p9o4PMdY6mibM4JE6iBJ6gSu9pmCczgVpump");
        let admin = addr("HNvRQWybhe9hG6xxsusyjGEmhnkJejubk3s7jwzBcAhT");
        assert_eq!(read_address(&d, SC_MINT).unwrap(), &mint);
        assert_eq!(read_address(&d, SC_ADMIN).unwrap(), &admin);
        assert_eq!(d[SC_ADMIN_REVOKED], 0);
        assert_eq!(u32::from_le_bytes(d[76..80].try_into().unwrap()), 1);
        assert_eq!(read_address(&d, SC_SHAREHOLDERS).unwrap(), &admin);
        assert_eq!(u16::from_le_bytes([d[112], d[113]]), 10_000);
        // as found: mode-1 shape but admin not revoked -> rejected; revoked -> only mode 1 with launch = admin
        assert!(check_sharing_config(&d, &mint, &admin, &admin, LAUNCH_MODE_FULL).is_err());
        let mut fin = d.clone();
        fin[SC_ADMIN_REVOKED] = 1;
        assert!(check_sharing_config(&fin, &mint, &admin, &admin, LAUNCH_MODE_FULL).is_ok());
        assert!(check_sharing_config(&fin, &mint, &admin, &[1u8; 32], LAUNCH_MODE_FULL).is_err());
        assert!(check_sharing_config(&fin, &mint, &admin, &admin, LAUNCH_MODE_SHARED).is_err());
    }

    fn sharing_config(mint: &[u8; 32], admin: &[u8; 32], revoked: bool, shares: &[(&[u8; 32], u16)]) -> Vec<u8> {
        let mut d = vec![0u8; 1024];
        d[..8].copy_from_slice(&SC_DISC);
        d[8] = 255;
        d[9] = 2;
        d[SC_STATUS] = 1;
        d[SC_MINT..SC_MINT + 32].copy_from_slice(mint);
        d[SC_ADMIN..SC_ADMIN + 32].copy_from_slice(admin);
        d[SC_ADMIN_REVOKED] = revoked as u8;
        d[76..80].copy_from_slice(&(shares.len() as u32).to_le_bytes());
        for (i, (a, bps)) in shares.iter().enumerate() {
            let o = SC_SHAREHOLDERS + i * SC_SHAREHOLDER_SIZE;
            d[o..o + 32].copy_from_slice(*a);
            d[o + 32..o + 34].copy_from_slice(&bps.to_le_bytes());
        }
        d
    }

    #[test]
    fn sharing_config_shapes_per_mode() {
        let (mint, lister, launch, other) = ([1u8; 32], [2u8; 32], [3u8; 32], [4u8; 32]);
        let m0 = sharing_config(&mint, &lister, true, &[(&lister, 1_000), (&launch, 9_000)]);
        let m0r = sharing_config(&mint, &lister, true, &[(&launch, 9_000), (&lister, 1_000)]);
        let m1 = sharing_config(&mint, &lister, true, &[(&launch, 10_000)]);
        assert!(check_sharing_config(&m0, &mint, &lister, &launch, LAUNCH_MODE_SHARED).is_ok());
        assert!(check_sharing_config(&m0r, &mint, &lister, &launch, LAUNCH_MODE_SHARED).is_ok());
        assert!(check_sharing_config(&m0, &mint, &lister, &launch, LAUNCH_MODE_FULL).is_err());
        assert!(check_sharing_config(&m1, &mint, &lister, &launch, LAUNCH_MODE_FULL).is_ok());
        assert!(check_sharing_config(&m1, &mint, &lister, &launch, LAUNCH_MODE_SHARED).is_err());
        // wrong split, extra shareholder, wrong launch, wrong mint, wrong admin, not revoked, paused
        for bad in [
            sharing_config(&mint, &lister, true, &[(&lister, 2_000), (&launch, 8_000)]),
            sharing_config(&mint, &lister, true, &[(&lister, 1_000), (&launch, 8_000), (&other, 1_000)]),
            sharing_config(&mint, &lister, true, &[(&lister, 1_000), (&other, 9_000)]),
            sharing_config(&other, &lister, true, &[(&lister, 1_000), (&launch, 9_000)]),
            sharing_config(&mint, &other, true, &[(&lister, 1_000), (&launch, 9_000)]),
            sharing_config(&mint, &lister, false, &[(&lister, 1_000), (&launch, 9_000)]),
        ] {
            assert!(check_sharing_config(&bad, &mint, &lister, &launch, LAUNCH_MODE_SHARED).is_err());
        }
        let mut paused = m0.clone();
        paused[SC_STATUS] = 0;
        assert!(check_sharing_config(&paused, &mint, &lister, &launch, LAUNCH_MODE_SHARED).is_err());
        let mut wrong_disc = m0.clone();
        wrong_disc[3] ^= 1;
        assert!(check_sharing_config(&wrong_disc, &mint, &lister, &launch, LAUNCH_MODE_SHARED).is_err());
        // a list claiming more entries than the account holds is rejected, not read out of bounds
        let mut overlong = m0.clone();
        overlong[76..80].copy_from_slice(&40u32.to_le_bytes());
        assert!(!shares_match_mode(&overlong, &lister, &launch, LAUNCH_MODE_SHARED));
        assert!(!shares_match_mode(&m0, &lister, &launch, 7));
    }

    /// register_launch's creator rule on the real curves: the lister must be the creator, or the creator
    /// must be the (final, matching) SharingConfig. Wrong creator / wrong quote are rejected.
    #[test]
    fn register_launch_rejects_wrong_creator_quote_and_mint() {
        let meme = *MEME_MINT.as_array();
        let launch = [9u8; 32];
        let sc_key = [8u8; 32];
        // a curve quoted in MEME whose creator is the lister
        let mut d = unhex(PUMP_QUOTED_CURVE);
        d[BC_QUOTE_MINT..BC_QUOTE_MINT + 32].copy_from_slice(&meme);
        let c = decode_curve(&d).unwrap();
        let lister = c.creator;
        let mint = [7u8; 32]; // the pump coin; the processor ties it to the curve by PDA
        assert_eq!(c.quote_mint, meme);
        assert!(check_creator(&c, &mint, &lister, &launch, &sc_key, None, LAUNCH_MODE_SHARED).is_ok());
        // someone else signing: rejected
        assert_eq!(
            check_creator(&c, &mint, &[5u8; 32], &launch, &sc_key, None, LAUNCH_MODE_SHARED).unwrap_err(),
            HookedError::InvalidLaunchCreator.into()
        );
        // creator migrated to the sharing config: config must be present, final, admin = lister, shares per mode
        let mut migrated = d.clone();
        migrated[BC_CREATOR..BC_CREATOR + 32].copy_from_slice(&sc_key);
        let cm = decode_curve(&migrated).unwrap();
        assert!(check_creator(&cm, &mint, &lister, &launch, &sc_key, None, LAUNCH_MODE_SHARED).is_err());
        let good = sharing_config(&mint, &lister, true, &[(&lister, 1_000), (&launch, 9_000)]);
        assert!(check_creator(&cm, &mint, &lister, &launch, &sc_key, Some(&good), LAUNCH_MODE_SHARED).is_ok());
        assert!(check_creator(&cm, &mint, &lister, &launch, &sc_key, Some(&good), LAUNCH_MODE_FULL).is_err());
        // a config for another coin is rejected even with the right shares
        assert!(check_creator(&cm, &[6u8; 32], &lister, &launch, &sc_key, Some(&good), LAUNCH_MODE_SHARED).is_err());
        let full = sharing_config(&mint, &lister, true, &[(&launch, 10_000)]);
        assert!(check_creator(&cm, &mint, &lister, &launch, &sc_key, Some(&full), LAUNCH_MODE_FULL).is_ok());
        // a non-admin signer cannot register a migrated coin
        assert!(check_creator(&cm, &mint, &[5u8; 32], &launch, &sc_key, Some(&good), LAUNCH_MODE_SHARED).is_err());
        // the processor's quote check: the real curves are not quoted in MEME
        assert_ne!(decode_curve(&unhex(PUMP_QUOTED_CURVE)).unwrap().quote_mint, meme);
        assert_ne!(decode_curve(&unhex(MEME_CURVE)).unwrap().quote_mint, meme);
        // "wrong mint" is the bonding-curve PDA check in the processor: the MEME curve's bytes decode but
        // only the PDA ["bonding-curve", MEME] under pump is accepted for MEME (see fixtures' addresses)
        assert_ne!(MEME_CURVE_ADDRESS, PUMP_QUOTED_CURVE_ADDRESS);
    }

    #[test]
    fn boost_split_math() {
        // below the dust floor: no-op
        assert_eq!(boost_split(0, LAUNCH_MODE_SHARED).unwrap(), None);
        assert_eq!(boost_split(BOOST_DUST - 1, LAUNCH_MODE_FULL).unwrap(), None);
        // mode 0 holds 90 % of fee F = 1_000_000: burn 1/9 = 100_000 = 10 % F, sell 800_000 = 80 % F
        let s = boost_split(900_000, LAUNCH_MODE_SHARED).unwrap().unwrap();
        assert_eq!(s, BoostSplit { lister: 0, burn: 100_000, sell: 800_000 });
        // mode 1 holds 100 %: 10 / 10 / 80
        let s = boost_split(1_000_000, LAUNCH_MODE_FULL).unwrap().unwrap();
        assert_eq!(s, BoostSplit { lister: 100_000, burn: 100_000, sell: 800_000 });
        // exactly the floor, odd amounts: shares sum to the balance, remainder goes to the sell leg
        for (b, mode) in [(BOOST_DUST, 0u8), (BOOST_DUST, 1), (1_000_001, 0), (1_000_001, 1), (u64::MAX, 0), (u64::MAX, 1)] {
            let s = boost_split(b, mode).unwrap().unwrap();
            assert_eq!(s.lister + s.burn + s.sell, b);
            if mode == LAUNCH_MODE_SHARED {
                assert_eq!(s.lister, 0);
                assert_eq!(s.burn, b / 9);
            } else {
                assert_eq!((s.lister, s.burn), (b / 10, b / 10));
            }
        }
        assert!(boost_split(5_000, 2).is_err());
    }
}
