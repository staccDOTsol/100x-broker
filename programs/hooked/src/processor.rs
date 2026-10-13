use {
    crate::{
        consts::*,
        cpi,
        error::HookedError,
        math::*,
        oracle,
        state::*,
    },
    pinocchio::{
        cpi::{Seed, Signer},
        error::ProgramError,
        sysvars::{clock::Clock, instructions::Instructions, rent::Rent, Sysvar},
        AccountView, Address, ProgramResult,
    },
};

pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    if data.len() >= 8 && data[..8] == EXECUTE_DISC {
        return execute(program_id, accounts);
    }
    match data.first() {
        Some(&TAG_CREATE_MARKET) => create_market(program_id, accounts, &data[1..]),
        Some(&TAG_POKE) => poke(program_id, accounts),
        Some(&TAG_REDEEM) => redeem(program_id, accounts, &data[1..]),
        Some(&TAG_SETTLE_BEGIN) => settle_begin(program_id, accounts, &data[1..]),
        Some(&TAG_SETTLE_END) => settle_end(program_id, accounts),
        Some(&TAG_CLAIM_FEES) => claim_fees(program_id, accounts, &data[1..]),
        Some(&TAG_INIT_BURN) => init_burn(program_id, accounts),
        Some(&TAG_BURN_MEME) => burn_meme(program_id, accounts, &data[1..]),
        _ => Err(HookedError::InvalidInstruction.into()),
    }
}

#[cfg(target_os = "solana")]
fn find_pda(seeds: &[&[u8]], program_id: &Address) -> (Address, u8) {
    Address::find_program_address(seeds, program_id)
}
#[cfg(not(target_os = "solana"))]
fn find_pda(_seeds: &[&[u8]], _program_id: &Address) -> (Address, u8) {
    unimplemented!("on-chain only")
}

fn require(cond: bool, e: HookedError) -> ProgramResult {
    if cond {
        Ok(())
    } else {
        Err(e.into())
    }
}

fn funding_share(fee: u64) -> u64 {
    ((fee as u128) * FUNDING_SHARE_BPS / BPS) as u64
}

/// (mechanism, burn pot, dev) shares of a collected fee.
fn split_fee(fee: u64) -> (u64, u64, u64) {
    let burn = ((fee as u128) * BURN_BPS / BPS) as u64;
    let dev = ((fee as u128) * DEV_BPS / BPS) as u64;
    (fee - burn - dev, burn, dev)
}

/// Pays the burn pot and the dev their shares out of `own` (a market vault signed by the market PDA).
fn pay_shares(
    program_id: &Address,
    token_program: &AccountView,
    own: &AccountView,
    burn_vault: &AccountView,
    dev_ata: &AccountView,
    market: &AccountView,
    signers: &[Signer],
    burn: u64,
    dev: u64,
) -> ProgramResult {
    require(dev_ata.address() == &DEV_ATA, HookedError::InvalidBurnAccounts)?;
    let (bv, _) = find_pda(&[BURN_SEED], program_id);
    require(burn_vault.address() == &bv, HookedError::InvalidBurnAccounts)?;
    if burn > 0 {
        cpi::transfer(token_program, own, burn_vault, market, burn, signers)?;
    }
    if dev > 0 {
        cpi::transfer(token_program, own, dev_ata, market, dev, signers)?;
    }
    Ok(())
}

fn side_arg(data: &[u8]) -> Result<u8, ProgramError> {
    match data.first() {
        Some(&s) if s == SIDE_BULL || s == SIDE_BEAR => Ok(s),
        _ => Err(HookedError::InvalidInstruction.into()),
    }
}

fn amount_arg(data: &[u8], at: usize) -> Result<u64, ProgramError> {
    data.get(at..at + 8)
        .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
        .ok_or(HookedError::InvalidInstruction.into())
}

fn pool_sqrt_price(pool: &AccountView) -> Result<u128, ProgramError> {
    require(pool.owner() == &DBC, HookedError::InvalidPool)?;
    let d = pool.try_borrow()?;
    require(d.len() >= DBC_POOL_LEN && d[..8] == DBC_POOL_DISC, HookedError::InvalidPool)?;
    read_u128(&d, DBC_POOL_SQRT_PRICE)
}

/// Moves `1 - 1.0001^(-L·|Δtwap|)` of the losing vault to the winning vault for every new stored
/// Raydium observation, and accrues the same factor as curve price the loser owes to settle.
#[inline(never)]
fn rebalance(
    program_id: &Address,
    market: &mut AccountView,
    obs: &AccountView,
    vault_bull: &AccountView,
    vault_bear: &AccountView,
    token_program: &AccountView,
    pool: Option<&AccountView>,
) -> ProgramResult {
    require(market.owner() == program_id, HookedError::InvalidMarket)?;
    require(obs.owner() == &RAYDIUM_CLMM, HookedError::InvalidOracle)?;
    require(token_program.address() == &TOKENKEG, HookedError::InvalidProgram)?;
    let bal_bull = token_amount(vault_bull)?;
    let bal_bear = token_amount(vault_bear)?;

    let (bull_pays, amount, seeds) = {
        let mut data = market.try_borrow_mut()?;
        let m = Market::from_bytes_mut(&mut data)?;
        require(obs.address() == &m.oracle_obs, HookedError::InvalidOracle)?;
        require(
            vault_bull.address() == &m.vault_bull && vault_bear.address() == &m.vault_bear,
            HookedError::InvalidVault,
        )?;
        let od = obs.try_borrow()?;
        let now = Clock::get()?.unix_timestamp as u32;
        // a dead ring + the pool account => sample the pool's tick ourselves
        let read = match pool {
            Some(p) if oracle::ring_is_stale(&od, now) => {
                require(p.address() == &m.oracle_pool && p.owner() == &RAYDIUM_CLMM, HookedError::InvalidOracle)?;
                let tick = {
                    let pd = p.try_borrow()?;
                    i32::from_le_bytes(pd[RAY_POOL_TICK_CURRENT..RAY_POOL_TICK_CURRENT + 4].try_into().unwrap())
                };
                let (end, twap) = oracle::read_sampled(&od, m, now, tick)?;
                match twap {
                    Some(t) => Some((end, t)),
                    None => {
                        if end.ts > m.last_obs_ts {
                            m.push_ckpt(end.ts, end.tick_cumulative);
                            m.last_obs_ts = end.ts;
                        }
                        None
                    }
                }
            }
            _ => oracle::read(&od, m)?,
        };
        let Some((end, twap)) = read else {
            return Ok(());
        };
        if end.ts <= m.last_obs_ts {
            return Ok(());
        }
        m.push_ckpt(end.ts, end.tick_cumulative);
        // underlying log-price change: +tick if the underlying is token0, -tick if token1
        let d_tick = twap.checked_sub(m.last_twap_q32).ok_or(HookedError::MathOverflow)?;
        let du = if m.underlying_is_token0 == 1 { d_tick } else { -d_tick };
        m.last_twap_q32 = twap;
        m.last_obs_ts = end.ts;
        if du == 0 {
            return Ok(());
        }
        let keep = keep_factor_q64(du.unsigned_abs(), LEVERAGE);
        if du > 0 {
            m.keep_bear_q63 = mul_q63_q64(m.keep_bear_q63, keep);
            (false, loss_amount(bal_bear, keep), m.seeds())
        } else {
            m.keep_bull_q63 = mul_q63_q64(m.keep_bull_q63, keep);
            (true, loss_amount(bal_bull, keep), m.seeds())
        }
    };
    if amount == 0 {
        return Ok(());
    }
    let s = seeds.seeds();
    if bull_pays {
        cpi::transfer(token_program, vault_bull, vault_bear, market, amount, &[signer(&s)])
    } else {
        cpi::transfer(token_program, vault_bear, vault_bull, market, amount, &[signer(&s)])
    }
}

/// Transfer-hook Execute: [source, mint, destination, authority, extra-metas, market, observation,
/// vault_bull, vault_bear, token program]. Anyone may also call it directly; it only rebalances.
fn execute(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    if accounts.len() < 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (head, tail) = accounts.split_at_mut(10);
    let [_src, _mint, _dst, _auth, _metas, market, obs, vault_bull, vault_bear, token_program] = head else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    rebalance(program_id, market, obs, vault_bull, vault_bear, token_program, tail.first())
}

/// [market(w), observation, vault_bull(w), vault_bear(w), token program, (oracle pool)]
fn poke(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (head, tail) = accounts.split_at_mut(5);
    let [market, obs, vault_bull, vault_bear, token_program] = head else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    rebalance(program_id, market, obs, vault_bull, vault_bear, token_program, tail.first())
}

fn mint_has_hook(d: &[u8], program_id: &Address) -> bool {
    let mut o = T22_TLV_START;
    while o + 4 <= d.len() {
        let t = u16::from_le_bytes([d[o], d[o + 1]]);
        let l = u16::from_le_bytes([d[o + 2], d[o + 3]]) as usize;
        if t == 0 {
            return false;
        }
        if t == T22_EXT_TRANSFER_HOOK {
            return l >= 64
                && o + 4 + 64 <= d.len()
                && &d[o + 4 + 32..o + 4 + 64] == program_id.as_array();
        }
        o += 4 + l;
    }
    false
}

#[allow(clippy::too_many_arguments)]
fn check_side(
    program_id: &Address,
    market_key: &Address,
    quote_mint: &Address,
    mint: &AccountView,
    pool: &AccountView,
    base_vault: &AccountView,
    quote_vault: &AccountView,
    escrow: &AccountView,
) -> ProgramResult {
    require(mint.owner() == &TOKEN_2022, HookedError::InvalidMint)?;
    {
        let d = mint.try_borrow()?;
        require(
            d.len() > T22_TLV_START
                && d[0..4] == [1, 0, 0, 0]
                && &d[4..36] == market_key.as_array()
                && d[T22_ACCOUNT_TYPE] == 1
                && mint_has_hook(&d, program_id),
            HookedError::InvalidMint,
        )?;
    }
    require(pool.owner() == &DBC, HookedError::InvalidPool)?;
    {
        let d = pool.try_borrow()?;
        require(
            d.len() >= DBC_POOL_LEN
                && d[..8] == DBC_POOL_DISC
                && read_address(&d, DBC_POOL_BASE_MINT)? == mint.address().as_array()
                && read_address(&d, DBC_POOL_BASE_VAULT)? == base_vault.address().as_array()
                && read_address(&d, DBC_POOL_QUOTE_VAULT)? == quote_vault.address().as_array(),
            HookedError::InvalidPool,
        )?;
    }
    require(quote_vault.owner() == &TOKENKEG, HookedError::InvalidPool)?;
    {
        let d = quote_vault.try_borrow()?;
        require(read_address(&d, 0)? == quote_mint.as_array(), HookedError::InvalidPool)?;
    }
    require(escrow.owner() == &TOKEN_2022, HookedError::InvalidEscrow)?;
    let d = escrow.try_borrow()?;
    require(
        read_address(&d, 0)? == mint.address().as_array()
            && read_address(&d, 32)? == market_key.as_array(),
        HookedError::InvalidEscrow,
    )
}

#[allow(clippy::too_many_arguments)]
fn create_vault(
    program_id: &Address,
    rent: &Rent,
    system: &AccountView,
    token_program: &AccountView,
    payer: &AccountView,
    vault: &AccountView,
    quote_mint: &AccountView,
    market_key: &Address,
    side: u8,
) -> ProgramResult {
    let side_b = [side];
    let (key, bump) = find_pda(&[VAULT_SEED, &market_key.as_array()[..], &side_b], program_id);
    require(vault.address() == &key, HookedError::InvalidPda)?;
    let bump_b = [bump];
    let seeds = [
        Seed::from(VAULT_SEED),
        Seed::from(market_key.as_array()),
        Seed::from(&side_b),
        Seed::from(&bump_b),
    ];
    cpi::create_pda_account(
        system,
        payer,
        vault,
        TOKEN_ACCOUNT_LEN as u64,
        &TOKENKEG,
        rent.try_minimum_balance(TOKEN_ACCOUNT_LEN)?,
        &[Signer::from(&seeds)],
    )?;
    cpi::initialize_account3(token_program, vault, quote_mint, market_key)
}

#[allow(clippy::too_many_arguments)]
fn create_meta_list(
    program_id: &Address,
    rent: &Rent,
    system: &AccountView,
    payer: &AccountView,
    meta: &mut AccountView,
    mint: &Address,
    extras: [(&Address, bool); EXTRA_METAS],
) -> ProgramResult {
    let (key, bump) = find_pda(&[META_SEED, &mint.as_array()[..]], program_id);
    require(meta.address() == &key, HookedError::InvalidPda)?;
    let bump_b = [bump];
    let seeds = [Seed::from(META_SEED), Seed::from(mint.as_array()), Seed::from(&bump_b)];
    cpi::create_pda_account(
        system,
        payer,
        meta,
        META_LIST_LEN as u64,
        program_id,
        rent.try_minimum_balance(META_LIST_LEN)?,
        &[Signer::from(&seeds)],
    )?;
    let mut d = meta.try_borrow_mut()?;
    d[..8].copy_from_slice(&EXECUTE_DISC);
    d[8..12].copy_from_slice(&((4 + 35 * EXTRA_METAS) as u32).to_le_bytes());
    d[12..16].copy_from_slice(&(EXTRA_METAS as u32).to_le_bytes());
    for (i, (addr, writable)) in extras.iter().enumerate() {
        let o = 16 + 35 * i;
        d[o] = 0; // fixed address
        d[o + 1..o + 33].copy_from_slice(addr.as_array());
        d[o + 33] = 0; // signer
        d[o + 34] = *writable as u8;
    }
    Ok(())
}

/// Permissionless. The market PDA commits to both mints, the oracle and the window, and must be
/// each mint's authority (DBC `PartnerUpdateAndMintAuthority` with fee_claimer = market).
/// data: window_secs u32 | underlying_is_token0 u8
fn create_market(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [payer, market, vault_bull, vault_bear, bull_mint, bear_mint, pool_bull, pool_bear, bv_bull, bv_bear, qv_bull, qv_bear, quote_mint, esc_bull, esc_bear, meta_bull, meta_bear, oracle_pool, oracle_obs, system, token_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let window = data
        .get(0..4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .ok_or(HookedError::InvalidInstruction)?;
    let flag = *data.get(4).ok_or(HookedError::InvalidInstruction)?;
    require(window > 0 && flag <= 1, HookedError::InvalidInstruction)?;
    require(payer.is_signer(), HookedError::MissingSigner)?;
    require(
        system.address() == &SYSTEM && token_program.address() == &TOKENKEG,
        HookedError::InvalidProgram,
    )?;
    require(bull_mint.address() != bear_mint.address(), HookedError::InvalidMint)?;

    let mut params = [0u8; 5];
    params[..4].copy_from_slice(&window.to_le_bytes());
    params[4] = flag;
    let (market_key, bump) = find_pda(
        &[
            MARKET_SEED,
            &bull_mint.address().as_array()[..],
            &bear_mint.address().as_array()[..],
            &oracle_obs.address().as_array()[..],
            &params,
        ],
        program_id,
    );
    require(market.address() == &market_key, HookedError::InvalidPda)?;

    require(
        oracle_obs.owner() == &RAYDIUM_CLMM && oracle_pool.owner() == &RAYDIUM_CLMM,
        HookedError::InvalidOracle,
    )?;
    oracle::check_header(&oracle_obs.try_borrow()?, oracle_pool.address())?;
    require(
        quote_mint.address() == &QUOTE_MINT && quote_mint.owner() == &TOKENKEG,
        HookedError::InvalidMint,
    )?;
    let quote_key = quote_mint.address().clone();
    check_side(program_id, &market_key, &quote_key, bull_mint, pool_bull, bv_bull, qv_bull, esc_bull)?;
    check_side(program_id, &market_key, &quote_key, bear_mint, pool_bear, bv_bear, qv_bear, esc_bear)?;

    let rent = Rent::get()?;
    let ms = MarketSeeds {
        bull: bull_mint.address().to_bytes(),
        bear: bear_mint.address().to_bytes(),
        obs: oracle_obs.address().to_bytes(),
        params,
        bump: [bump],
    };
    let s = ms.seeds();
    cpi::create_pda_account(
        system,
        payer,
        market,
        Market::LEN as u64,
        program_id,
        rent.try_minimum_balance(Market::LEN)?,
        &[signer(&s)],
    )?;
    create_vault(program_id, &rent, system, token_program, payer, vault_bull, quote_mint, &market_key, SIDE_BULL)?;
    create_vault(program_id, &rent, system, token_program, payer, vault_bear, quote_mint, &market_key, SIDE_BEAR)?;
    let extras = [
        (&market_key, true),
        (oracle_obs.address(), false),
        (vault_bull.address(), true),
        (vault_bear.address(), true),
        (&TOKENKEG, false),
        (oracle_pool.address(), false),
    ];
    let bull_key = bull_mint.address().clone();
    let bear_key = bear_mint.address().clone();
    create_meta_list(program_id, &rent, system, payer, meta_bull, &bull_key, extras)?;
    create_meta_list(program_id, &rent, system, payer, meta_bear, &bear_key, extras)?;

    let mut d = market.try_borrow_mut()?;
    d[..8].copy_from_slice(&MARKET_DISC);
    let m = Market::from_bytes_mut(&mut d)?;
    m.bull_mint = bull_key;
    m.bear_mint = bear_key;
    m.quote_mint = quote_key;
    m.oracle_pool = oracle_pool.address().clone();
    m.oracle_obs = oracle_obs.address().clone();
    m.vault_bull = vault_bull.address().clone();
    m.vault_bear = vault_bear.address().clone();
    m.pool_bull = pool_bull.address().clone();
    m.pool_bear = pool_bear.address().clone();
    m.base_vault_bull = bv_bull.address().clone();
    m.base_vault_bear = bv_bear.address().clone();
    m.escrow_bull = esc_bull.address().clone();
    m.escrow_bear = esc_bear.address().clone();
    m.keep_bull_q63 = ONE_Q63;
    m.keep_bear_q63 = ONE_Q63;
    m.window_secs = window;
    m.underlying_is_token0 = flag;
    m.bump = bump;
    let od = oracle_obs.try_borrow()?;
    let now = Clock::get()?.unix_timestamp as u32;
    let (end, twap) = if oracle::ring_is_stale(&od, now) {
        // dead ring: start from the pool's own tick, sampling takes over from here
        let tick = {
            let pd = oracle_pool.try_borrow()?;
            i32::from_le_bytes(pd[RAY_POOL_TICK_CURRENT..RAY_POOL_TICK_CURRENT + 4].try_into().unwrap())
        };
        let (end, t) = oracle::read_sampled(&od, m, now, tick)?;
        (end, t.unwrap_or((tick as i64) << 32))
    } else {
        oracle::read(&od, m)?.ok_or(HookedError::OracleWindowEmpty)?
    };
    m.last_twap_q32 = twap;
    m.last_obs_ts = end.ts;
    m.push_ckpt(end.ts, end.tick_cumulative);
    Ok(())
}

/// Burn BULL/BEAR for a pro-rata share of that side's vault, minus REDEEM_FEE_BPS. The fee stays
/// in the vaults; FUNDING_SHARE_BPS of it moves to the other vault if that one is smaller.
/// [user(s), user_token(w), mint(w), user_quote(w), market(w), observation, vault_bull(w),
///  vault_bear(w), dbc_base_vault, token program, token-2022]; data: side u8 | amount u64
fn redeem(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < 13 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (head, tail) = accounts.split_at_mut(13);
    let [user, user_token, mint, user_quote, market, obs, vault_bull, vault_bear, base_vault, token_program, token_2022, burn_vault, dev_ata] = head else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let oracle_pool = tail.first();
    let side = side_arg(data)?;
    let amount = amount_arg(data, 1)?;
    require(amount > 0, HookedError::ZeroAmount)?;
    require(user.is_signer(), HookedError::MissingSigner)?;
    require(token_2022.address() == &TOKEN_2022, HookedError::InvalidProgram)?;

    rebalance(program_id, market, obs, vault_bull, vault_bear, token_program, oracle_pool)?;

    let seeds = {
        let d = market.try_borrow()?;
        let m = Market::from_bytes(&d)?;
        require(m.settling == 0, HookedError::SettleInProgress)?;
        require(mint.address() == m.mint(side), HookedError::InvalidMint)?;
        require(base_vault.address() == m.base_vault(side), HookedError::InvalidPool)?;
        m.seeds()
    };
    let supply = {
        let d = mint.try_borrow()?;
        u64::from_le_bytes(d[MINT_SUPPLY..MINT_SUPPLY + 8].try_into().unwrap())
    };
    let circulating = supply
        .checked_sub(token_amount(base_vault)?)
        .ok_or(HookedError::MathOverflow)?;
    require(amount <= circulating, HookedError::ExceedsCirculating)?;

    let (own, other) = if side == SIDE_BULL { (&*vault_bull, &*vault_bear) } else { (&*vault_bear, &*vault_bull) };
    let balance = token_amount(own)?;
    let other_balance = token_amount(other)?;
    let gross = mul_div(balance, amount, circulating).ok_or(HookedError::MathOverflow)?;
    let fee = ((gross as u128) * REDEEM_FEE_BPS / BPS) as u64;
    let payout = gross - fee;

    cpi::burn(token_2022, user_token, mint, user, amount)?;
    let s = seeds.seeds();
    if payout > 0 {
        cpi::transfer(token_program, own, user_quote, market, payout, &[signer(&s)])?;
    }
    let (mech, burn, dev) = split_fee(fee);
    pay_shares(program_id, token_program, own, burn_vault, dev_ata, market, &[signer(&s)], burn, dev)?;
    let fund = funding_share(mech);
    if fund > 0 && other_balance < balance - payout - burn - dev {
        cpi::transfer(token_program, own, other, market, fund, &[signer(&s)])?;
    }
    Ok(())
}

/// First of three top-level instructions: [settle_begin, DBC swap2_with_transfer_hook selling
/// `amount` of the losing side from escrow into its curve with proceeds to the winning vault,
/// settle_end]. Mints `amount` to the escrow and approves the caller to sell exactly that.
/// [caller(s), market(w), observation, vault_bull(w), vault_bear(w), token program, token-2022,
///  mint(w), escrow(w), dbc_pool, instructions sysvar]; data: side u8 | amount u64
fn settle_begin(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < 11 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (head, tail) = accounts.split_at_mut(11);
    let [caller, market, obs, vault_bull, vault_bear, token_program, token_2022, mint, escrow, pool, ix_sysvar] = head else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let oracle_pool = tail.first();
    let side = side_arg(data)?;
    let amount = amount_arg(data, 1)?;
    require(amount > 0, HookedError::ZeroAmount)?;
    require(caller.is_signer(), HookedError::MissingSigner)?;
    require(token_2022.address() == &TOKEN_2022, HookedError::InvalidProgram)?;

    rebalance(program_id, market, obs, vault_bull, vault_bear, token_program, oracle_pool)?;

    let winner_vault = if side == SIDE_BULL { &*vault_bear } else { &*vault_bull };
    let vault_pre = token_amount(winner_vault)?;
    let s0 = pool_sqrt_price(pool)?;

    let seeds = {
        let mut d = market.try_borrow_mut()?;
        let m = Market::from_bytes_mut(&mut d)?;
        require(m.settling == 0, HookedError::SettleInProgress)?;
        require(
            mint.address() == m.mint(side)
                && escrow.address() == m.escrow(side)
                && pool.address() == m.pool(side),
            HookedError::InvalidMint,
        )?;
        {
            let ixs = Instructions::try_from(&*ix_sysvar)?;
            let cur = ixs.load_current_index() as usize;
            let swap = ixs.load_instruction_at(cur + 1)?;
            let sd = swap.get_instruction_data();
            require(
                swap.get_program_id() == &DBC
                    && sd.len() >= 16
                    && sd[..8] == DBC_SWAP2_HOOK_DISC
                    && u64::from_le_bytes(sd[8..16].try_into().unwrap()) == amount
                    && &swap.get_instruction_account_at(2)?.key == m.pool(side)
                    && &swap.get_instruction_account_at(3)?.key == m.escrow(side)
                    && &swap.get_instruction_account_at(4)?.key == m.vault(1 - side)
                    && &swap.get_instruction_account_at(12)?.key == &DBC,
                HookedError::SettleSandwich,
            )?;
            let end = ixs.load_instruction_at(cur + 2)?;
            require(
                end.get_program_id() == program_id
                    && end.get_instruction_data().first() == Some(&TAG_SETTLE_END),
                HookedError::SettleSandwich,
            )?;
        }
        let keep = *m.keep_mut(side);
        require(keep < ONE_Q63, HookedError::NothingOwed)?;
        let target = scale_sqrt_price(s0, sqrt_keep_q64(keep));
        m.settling = 1;
        m.settle_side = side;
        m.settle_target_sqrt = target.to_le_bytes();
        m.settle_vault_pre = vault_pre;
        m.settle_amount = amount;
        m.seeds()
    };
    let s = seeds.seeds();
    cpi::mint_to(token_2022, mint, escrow, market, amount, &[signer(&s)])?;
    cpi::approve(token_2022, escrow, caller, market, amount, &[signer(&s)])
}

/// [market(w), escrow(w), dbc_pool, winner_vault, token-2022]
fn settle_end(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [market, escrow, pool, winner_vault, token_2022, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    require(market.owner() == program_id, HookedError::InvalidMarket)?;
    require(token_2022.address() == &TOKEN_2022, HookedError::InvalidProgram)?;
    require(token_amount(escrow)? == 0, HookedError::EscrowNotEmpty)?;
    let s1 = pool_sqrt_price(pool)?;
    let vault_post = token_amount(winner_vault)?;
    let seeds = {
        let mut d = market.try_borrow_mut()?;
        let m = Market::from_bytes_mut(&mut d)?;
        require(m.settling == 1, HookedError::NotSettling)?;
        let side = m.settle_side;
        require(
            escrow.address() == m.escrow(side)
                && pool.address() == m.pool(side)
                && winner_vault.address() == m.vault(1 - side),
            HookedError::InvalidEscrow,
        )?;
        let target = u128::from_le_bytes(m.settle_target_sqrt);
        require(s1 >= target, HookedError::Overshoot)?;
        require(vault_post > m.settle_vault_pre, HookedError::NoProceeds)?;
        *m.keep_mut(side) = remaining_keep_q63(target, s1);
        m.settling = 0;
        m.settle_target_sqrt = [0; 16];
        m.settle_vault_pre = 0;
        m.settle_amount = 0;
        m.seeds()
    };
    let s = seeds.seeds();
    cpi::revoke(token_2022, escrow, market, &[signer(&s)])
}

/// Claims a curve's partner trading fees (quote only) into that side's vault, then moves
/// FUNDING_SHARE_BPS of the claim to the other vault if that one is smaller.
/// [market, vault_bull(w), vault_bear(w), token program, token-2022, dbc program,
///  dbc pool_authority, dbc config, dbc pool(w), escrow(w), dbc base_vault(w), dbc quote_vault(w),
///  base_mint, quote_mint, dbc event_authority]; data: side u8
fn claim_fees(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [market, vault_bull, vault_bear, token_program, token_2022, dbc, pool_authority, config, pool, escrow, base_vault, quote_vault, base_mint, quote_mint, event_authority, burn_vault, dev_ata, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let side = side_arg(data)?;
    require(market.owner() == program_id, HookedError::InvalidMarket)?;
    require(
        dbc.address() == &DBC
            && token_program.address() == &TOKENKEG
            && token_2022.address() == &TOKEN_2022,
        HookedError::InvalidProgram,
    )?;
    let seeds = {
        let d = market.try_borrow()?;
        let m = Market::from_bytes(&d)?;
        require(
            vault_bull.address() == &m.vault_bull && vault_bear.address() == &m.vault_bear,
            HookedError::InvalidVault,
        )?;
        require(
            pool.address() == m.pool(side)
                && escrow.address() == m.escrow(side)
                && base_mint.address() == m.mint(side)
                && base_vault.address() == m.base_vault(side),
            HookedError::InvalidPool,
        )?;
        m.seeds()
    };
    let (own, other) = if side == SIDE_BULL { (&*vault_bull, &*vault_bear) } else { (&*vault_bear, &*vault_bull) };
    let pre = token_amount(own)?;
    let s = seeds.seeds();
    cpi::DbcClaim {
        dbc,
        pool_authority,
        config,
        pool,
        token_a_account: escrow,
        token_b_account: own,
        base_vault,
        quote_vault,
        base_mint,
        quote_mint,
        fee_claimer: market,
        token_base_program: token_2022,
        token_quote_program: token_program,
        event_authority,
    }
    .invoke(&[signer(&s)])?;
    let post = token_amount(own)?;
    let claimed = post.checked_sub(pre).ok_or(HookedError::MathOverflow)?;
    let (mech, burn, dev) = split_fee(claimed);
    pay_shares(program_id, token_program, own, burn_vault, dev_ata, market, &[signer(&s)], burn, dev)?;
    let fund = funding_share(mech);
    if fund > 0 && token_amount(other)? < post - burn - dev {
        cpi::transfer(token_program, own, other, market, fund, &[signer(&s)])?;
    }
    Ok(())
}

/// Permissionless, idempotent: creates the global burn-state PDA and the burn pot (an r-freestacc account
/// owned by it). [payer(s), burn_state(w), burn_vault(w), quote_mint, system, token program]
fn init_burn(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [payer, burn_state, burn_vault, quote_mint, system, token_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    require(payer.is_signer(), HookedError::MissingSigner)?;
    require(
        system.address() == &SYSTEM && token_program.address() == &TOKENKEG && quote_mint.address() == &QUOTE_MINT,
        HookedError::InvalidProgram,
    )?;
    let (state_key, bump) = find_pda(&[BURN_STATE_SEED], program_id);
    let (vault_key, vbump) = find_pda(&[BURN_SEED], program_id);
    require(burn_state.address() == &state_key && burn_vault.address() == &vault_key, HookedError::InvalidPda)?;
    if burn_state.data_len() == BurnState::LEN {
        return Ok(());
    }
    let rent = Rent::get()?;
    let sb = [bump];
    let sseeds = [Seed::from(BURN_STATE_SEED), Seed::from(&sb)];
    cpi::create_pda_account(system, payer, burn_state, BurnState::LEN as u64, program_id, rent.try_minimum_balance(BurnState::LEN)?, &[Signer::from(&sseeds)])?;
    let vb = [vbump];
    let vseeds = [Seed::from(BURN_SEED), Seed::from(&vb)];
    cpi::create_pda_account(system, payer, burn_vault, TOKEN_ACCOUNT_LEN as u64, &TOKENKEG, rent.try_minimum_balance(TOKEN_ACCOUNT_LEN)?, &[Signer::from(&vseeds)])?;
    cpi::initialize_account3(token_program, burn_vault, quote_mint, &state_key)?;
    let mut d = burn_state.try_borrow_mut()?;
    d[..8].copy_from_slice(&BURN_DISC);
    let st = BurnState::from_bytes_mut(&mut d)?;
    st.bump = bump;
    st.vault_bump = vbump;
    Ok(())
}

/// Bring MEME, burn it, get paid from the pot at the venue's own sell quote plus BURN_BONUS_BPS.
/// Price comes from pump.fun's bonding curve before graduation and from the canonical PumpSwap pool after;
/// both are derived from the mint, so there is no venue to choose and nothing to manipulate but the market.
/// [caller(s), caller_meme_ata(w), meme_mint(w), caller_quote_ata(w), burn_vault(w), burn_state(w), stake_pool,
///  bonding_curve, ps_pool, ps_base_ata, ps_quote_ata, meme token program, token program]; data: amount u64
fn burn_meme(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [caller, caller_meme, meme_mint, caller_quote, burn_vault, burn_state, stake_pool, bonding_curve, ps_pool, ps_base_ata, ps_quote_ata, meme_program, token_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let amount = amount_arg(data, 0)?;
    require(amount > 0, HookedError::ZeroAmount)?;
    require(caller.is_signer(), HookedError::MissingSigner)?;
    require(MEME_MINT != SYSTEM, HookedError::MemeNotSet)?;
    require(meme_mint.address() == &MEME_MINT, HookedError::InvalidMint)?;
    require(
        token_program.address() == &TOKENKEG
            && (meme_program.address() == &TOKENKEG || meme_program.address() == &TOKEN_2022)
            && meme_program.address() == meme_mint.owner(),
        HookedError::InvalidProgram,
    )?;
    require(stake_pool.address() == &STAKE_POOL, HookedError::InvalidBurnAccounts)?;
    require(burn_state.owner() == program_id, HookedError::InvalidBurnAccounts)?;
    let (vault_key, _) = find_pda(&[BURN_SEED], program_id);
    require(burn_vault.address() == &vault_key, HookedError::InvalidBurnAccounts)?;

    // venue: the mint's own bonding curve, or its canonical PumpSwap pool once complete
    let mint_bytes = MEME_MINT.to_bytes();
    let (bc_key, _) = find_pda(&[b"bonding-curve", &mint_bytes], &PUMP);
    require(bonding_curve.address() == &bc_key && bonding_curve.owner() == &PUMP, HookedError::InvalidVenue)?;
    let lamports: u128 = {
        let bc = bonding_curve.try_borrow()?;
        require(bc.len() > BC_COMPLETE, HookedError::InvalidVenue)?;
        let n = amount as u128;
        if bc[BC_COMPLETE] == 0 {
            let vt = u64::from_le_bytes(bc[BC_VIRTUAL_TOKEN..BC_VIRTUAL_TOKEN + 8].try_into().unwrap()) as u128;
            let vs = u64::from_le_bytes(bc[BC_VIRTUAL_SOL..BC_VIRTUAL_SOL + 8].try_into().unwrap()) as u128;
            vs * n / (vt + n) * (BPS - PUMP_FEE_BPS) / BPS
        } else {
            let (auth, _) = find_pda(&[b"pool-authority", &mint_bytes], &PUMP);
            let (pool_key, _) = find_pda(&[b"pool", &0u16.to_le_bytes(), auth.as_array(), &mint_bytes, WSOL.as_array()], &PUMPSWAP);
            require(ps_pool.address() == &pool_key && ps_pool.owner() == &PUMPSWAP, HookedError::InvalidVenue)?;
            let pd = ps_pool.try_borrow()?;
            require(
                pd.len() >= PS_QUOTE_ATA + 32
                    && read_address(&pd, PS_BASE_MINT)? == mint_bytes.as_slice()
                    && read_address(&pd, PS_QUOTE_MINT)? == WSOL.as_array()
                    && read_address(&pd, PS_BASE_ATA)? == ps_base_ata.address().as_array()
                    && read_address(&pd, PS_QUOTE_ATA)? == ps_quote_ata.address().as_array(),
                HookedError::InvalidVenue,
            )?;
            let bb = token_amount(ps_base_ata)? as u128;
            let qb = token_amount(ps_quote_ata)? as u128;
            qb * n / (bb + n) * (BPS - PUMPSWAP_FEE_BPS) / BPS
        }
    };
    // SOL value + bounty -> r-freestacc at the stake pool's live rate
    let payout: u64 = {
        let sp = stake_pool.try_borrow()?;
        let total = u64::from_le_bytes(sp[SP_TOTAL_LAMPORTS..SP_TOTAL_LAMPORTS + 8].try_into().unwrap()) as u128;
        let supply = u64::from_le_bytes(sp[SP_POOL_TOKEN_SUPPLY..SP_POOL_TOKEN_SUPPLY + 8].try_into().unwrap()) as u128;
        require(total > 0, HookedError::InvalidBurnAccounts)?;
        u64::try_from(lamports * (BPS + BURN_BONUS_BPS) / BPS * supply / total).map_err(|_| HookedError::MathOverflow)?
    };
    require(payout > 0, HookedError::NoProceeds)?;
    let pot = token_amount(burn_vault)?;
    require((payout as u128) <= (pot as u128) * MAX_BURN_SHARE_BPS / BPS, HookedError::BurnTooLarge)?;

    let now = Clock::get()?.unix_timestamp;
    let seeds = {
        let mut d = burn_state.try_borrow_mut()?;
        let st = BurnState::from_bytes_mut(&mut d)?;
        require(now - st.last_ts >= BURN_COOLDOWN_SECS, HookedError::BurnCooldown)?;
        st.last_ts = now;
        st.total_burned = st.total_burned.saturating_add(amount);
        st.total_paid = st.total_paid.saturating_add(payout);
        [st.bump]
    };
    // burn with the caller's own authority (they signed this instruction), then pay them from the pot
    cpi::burn(meme_program, caller_meme, meme_mint, caller, amount)?;
    let sseeds = [Seed::from(BURN_STATE_SEED), Seed::from(&seeds)];
    cpi::transfer(token_program, burn_vault, caller_quote, burn_state, payout, &[Signer::from(&sseeds)])
}
