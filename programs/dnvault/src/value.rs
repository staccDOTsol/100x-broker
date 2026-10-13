//! On-chain valuation: NAV in lamports and the hedge error, from pinned accounts only.
//! X is valued at the 100x market's own TWAP (manipulation-resistant); the position's composition
//! uses the pool's current sqrt price; DOWN is valued at its pot share after the cash-out fee.

use {
    crate::{consts::*, error::VaultError, math, state::Vault},
    pinocchio::{error::ProgramError, sysvars::{rent::Rent, Sysvar}, AccountView, Address},
};

pub struct Valuation {
    pub nav: u64,
    /// DOWN pot share held (gross) and its target: X exposure / LEVERAGE, both in lamports.
    pub d: u64,
    pub d_star: u64,
    /// |d - d_star| / d_star in bps; u64::MAX when d_star == 0 but d > 0.
    pub err_bps: u64,
    /// Position fees owed but not yet collected, in lamports (what a harvest brings in).
    pub fees: u64,
}

fn req(c: bool, e: VaultError) -> Result<(), ProgramError> {
    if c { Ok(()) } else { Err(e.into()) }
}

pub fn addr(d: &[u8], o: usize) -> Address {
    Address::new_from_array(d[o..o + 32].try_into().unwrap())
}
fn u64_at(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn u128_at(d: &[u8], o: usize) -> u128 {
    u128::from_le_bytes(d[o..o + 16].try_into().unwrap())
}
fn i32_at(d: &[u8], o: usize) -> i32 {
    i32::from_le_bytes(d[o..o + 4].try_into().unwrap())
}

/// Amount in a token account that must belong to `owner` and hold `mint`. A closed/missing account counts as 0.
pub fn token_amount(a: &AccountView, mint: &Address, owner: &Address) -> Result<u64, ProgramError> {
    let d = a.try_borrow()?;
    if d.len() < TOKEN_ACCOUNT_LEN {
        return Ok(0);
    }
    req(&addr(&d, TOKEN_MINT) == mint && &addr(&d, TOKEN_OWNER) == owner, VaultError::InvalidAccount)?;
    Ok(u64_at(&d, TOKEN_AMOUNT))
}

pub fn mint_supply(a: &AccountView) -> Result<u64, ProgramError> {
    let d = a.try_borrow()?;
    req(d.len() >= MINT_LEN, VaultError::InvalidAccount)?;
    Ok(u64_at(&d, MINT_SUPPLY))
}

pub fn mint_decimals(a: &AccountView) -> Result<u8, ProgramError> {
    let d = a.try_borrow()?;
    req(d.len() >= MINT_LEN, VaultError::InvalidAccount)?;
    Ok(d[MINT_DECIMALS])
}

pub fn rent_min() -> Result<u64, ProgramError> {
    Ok(Rent::get()?.minimum_balance(Vault::LEN))
}

/// Lamports the SOL sub-account must always keep (rent-exempt minimum for zero data).
pub fn sol_floor() -> Result<u64, ProgramError> {
    Ok(Rent::get()?.minimum_balance(0))
}

/// `v` = the VAL_ACCOUNTS slice (see consts). Also returns the pool's current sqrt price.
pub fn value(vault: &Vault, vault_acc: &AccountView, v: &[AccountView]) -> Result<Valuation, ProgramError> {
    let [market, mkt_vault_bear, bear_mint, base_vault_bear, down_ata, pool, position, wsol_ata, x_ata, quote_ata, stake_pool, sol_pda, ..] = v else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    req(market.address() == &vault.market && market.owner() == &HOOKED, VaultError::InvalidMarket)?;
    req(pool.address() == &vault.pool, VaultError::InvalidPool)?;
    req(
        wsol_ata.address() == &vault.wsol_ata && x_ata.address() == &vault.x_ata && quote_ata.address() == &vault.quote_ata && down_ata.address() == &vault.down_ata,
        VaultError::InvalidAccount,
    )?;
    req(stake_pool.address() == &STAKE_POOL && sol_pda.address() == &vault.sol_pda, VaultError::InvalidAccount)?;

    // --- market: pots, bear supply, TWAP ---
    let (pot, twap_tick) = {
        let m = market.try_borrow()?;
        req(m.len() == MARKET_LEN && m[..8] == MARKET_DISC, VaultError::InvalidMarket)?;
        req(
            &addr(&m, MKT_VAULT_BEAR) == mkt_vault_bear.address()
                && &addr(&m, MKT_BEAR_MINT) == bear_mint.address()
                && &addr(&m, MKT_BASE_VAULT_BEAR) == base_vault_bear.address(),
            VaultError::InvalidMarket,
        )?;
        let q = i64::from_le_bytes(m[MKT_LAST_TWAP_Q32..MKT_LAST_TWAP_Q32 + 8].try_into().unwrap());
        let tick = q >> 32;
        req((math::MIN_TICK as i64..=math::MAX_TICK as i64).contains(&tick), VaultError::InvalidTick)?;
        let pot = {
            let d = mkt_vault_bear.try_borrow()?;
            req(d.len() >= TOKEN_ACCOUNT_LEN, VaultError::InvalidAccount)?;
            u64_at(&d, TOKEN_AMOUNT)
        };
        (pot, tick as i32)
    };
    let bear_supply = mint_supply(bear_mint)?;
    let base = {
        let d = base_vault_bear.try_borrow()?;
        req(d.len() >= TOKEN_ACCOUNT_LEN, VaultError::InvalidAccount)?;
        u64_at(&d, TOKEN_AMOUNT)
    };
    let circulating = bear_supply.saturating_sub(base);
    let held = token_amount(down_ata, &vault.down_mint, vault_acc.address())?;
    let d_gross: u128 = if circulating == 0 || held == 0 { 0 } else { math::mul_div(pot as u128, held as u128, circulating as u128).ok_or(VaultError::MathOverflow)? };
    let d_net = d_gross * (BPS - REDEEM_FEE_BPS) / BPS;

    // --- pool: current sqrt price, sanity-checked against its tick ---
    let pool_sqrt = {
        let p = pool.try_borrow()?;
        req(p.len() > POOL_TICK_CURRENT + 4 && p[..8] == POOL_DISC, VaultError::InvalidPool)?;
        let s = u128_at(&p, POOL_SQRT_PRICE);
        let t = i32_at(&p, POOL_TICK_CURRENT);
        let lo = math::sqrt_price_at_tick(t).ok_or(VaultError::InvalidTick)?;
        let hi = math::sqrt_price_at_tick(t + 1).ok_or(VaultError::InvalidTick)?;
        req(s >= lo - lo / 1_000_000 && s <= hi + hi / 1_000_000, VaultError::PriceSanity)?;
        s
    };

    // --- position (optional) ---
    let (mut amt0, mut amt1) = (0u128, 0u128);
    let (mut owed0, mut owed1) = (0u128, 0u128);
    if vault.has_position() {
        req(position.address() == &vault.position, VaultError::PositionMismatch)?;
        let p = position.try_borrow()?;
        if p.len() >= POS_MIN_LEN && position.owner() == &RAYDIUM_CLMM {
            req(p[..8] == POS_DISC && &addr(&p, POS_POOL) == pool.address(), VaultError::PositionMismatch)?;
            req(i32_at(&p, POS_TICK_LOWER) == vault.tick_lower && i32_at(&p, POS_TICK_UPPER) == vault.tick_upper, VaultError::PositionMismatch)?;
            let liq = u128_at(&p, POS_LIQUIDITY);
            let lower = math::sqrt_price_at_tick(vault.tick_lower).ok_or(VaultError::InvalidTick)?;
            let upper = math::sqrt_price_at_tick(vault.tick_upper).ok_or(VaultError::InvalidTick)?;
            let (a0, a1) = math::position_amounts(liq, pool_sqrt, lower, upper).ok_or(VaultError::MathOverflow)?;
            owed0 = u64_at(&p, POS_FEES_OWED_0) as u128;
            owed1 = u64_at(&p, POS_FEES_OWED_1) as u128;
            amt0 = a0 + owed0;
            amt1 = a1 + owed1;
        }
    }
    let x_raw = token_amount(x_ata, &vault.x_mint, &vault.sol_pda)? as u128;
    let (x_total, sol_pos) = if vault.x_is_token0 == 1 { (amt0 + x_raw, amt1) } else { (amt1 + x_raw, amt0) };

    // --- X in SOL at the market TWAP ---
    let twap_sqrt = math::sqrt_price_at_tick(twap_tick).ok_or(VaultError::InvalidTick)?;
    let price = math::price_x64(twap_sqrt).ok_or(VaultError::MathOverflow)?;
    let in_sol = |x: u128| -> Result<u128, ProgramError> {
        if x == 0 {
            Ok(0)
        } else if vault.x_is_token0 == 1 {
            math::to_token1(x, price).ok_or(VaultError::MathOverflow.into())
        } else {
            math::to_token0(x, price).ok_or(VaultError::MathOverflow.into())
        }
    };
    let x_val = in_sol(x_total)?;
    let (owed_x, owed_sol) = if vault.x_is_token0 == 1 { (owed0, owed1) } else { (owed1, owed0) };
    let fees = in_sol(owed_x)? + owed_sol;

    // --- liquid legs ---
    let free = sol_pda.lamports().saturating_sub(sol_floor()?) as u128;
    let wsol = token_amount(wsol_ata, &WSOL, &vault.sol_pda)? as u128;
    let quote = token_amount(quote_ata, &QUOTE_MINT, vault_acc.address())? as u128;
    let quote_sol = if quote == 0 {
        0
    } else {
        let sp = stake_pool.try_borrow()?;
        req(sp.len() > SP_POOL_TOKEN_SUPPLY + 8, VaultError::InvalidAccount)?;
        let total = u64_at(&sp, SP_TOTAL_LAMPORTS) as u128;
        let supply = u64_at(&sp, SP_POOL_TOKEN_SUPPLY) as u128;
        if supply == 0 { quote } else { math::mul_div(quote, total, supply).ok_or(VaultError::MathOverflow)? }
    };

    let nav = free + wsol + quote_sol + x_val + sol_pos + d_net;
    let d_star = x_val / LEVERAGE;
    let err_bps = if d_star == 0 {
        if d_gross == 0 { 0 } else { u64::MAX }
    } else {
        let diff = if d_gross > d_star { d_gross - d_star } else { d_star - d_gross };
        u64::try_from(diff * BPS / d_star).unwrap_or(u64::MAX)
    };
    Ok(Valuation {
        nav: u64::try_from(nav).map_err(|_| VaultError::MathOverflow)?,
        d: u64::try_from(d_gross).map_err(|_| VaultError::MathOverflow)?,
        d_star: u64::try_from(d_star).map_err(|_| VaultError::MathOverflow)?,
        err_bps,
        fees: u64::try_from(fees).map_err(|_| VaultError::MathOverflow)?,
    })
}
