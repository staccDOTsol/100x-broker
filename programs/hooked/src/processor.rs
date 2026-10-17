use {
    crate::{
        consts::*,
        cpi,
        error::HookedError,
        launch::{boost_split, check_creator, decode_curve},
        math::*,
        oracle::{self, Point},
        state::*,
        venue,
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
        Some(&TAG_REGISTER_LAUNCH) => register_launch(program_id, accounts, &data[1..]),
        Some(&TAG_BOOST) => boost(program_id, accounts, &data[1..]),
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

/// PDA from seeds + a stored bump (one sha256, no bump search).
#[cfg(target_os = "solana")]
fn create_pda(seeds: &[&[u8]], program_id: &Address) -> Result<Address, ProgramError> {
    Address::create_program_address(seeds, program_id).map_err(|_| HookedError::InvalidPda.into())
}
#[cfg(not(target_os = "solana"))]
fn create_pda(_seeds: &[&[u8]], _program_id: &Address) -> Result<Address, ProgramError> {
    unimplemented!("on-chain only")
}

/// Program log: a static message followed by up to five numbers (`sol_log_64`).
#[cfg(target_os = "solana")]
fn log(msg: &str, v: [u64; 5]) {
    unsafe {
        pinocchio::syscalls::sol_log_(msg.as_ptr(), msg.len() as u64);
        pinocchio::syscalls::sol_log_64_(v[0], v[1], v[2], v[3], v[4]);
    }
}
#[cfg(not(target_os = "solana"))]
fn log(_msg: &str, _v: [u64; 5]) {}

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

/// Sampling-mode read plus the bookkeeping for "no window yet": the sample still becomes a
/// checkpoint so the next call has something to integrate from.
fn sample(ring: Option<&[u8]>, m: &mut Market, now: u32, tick: i32) -> Result<Option<(Point, i64)>, ProgramError> {
    let (end, twap) = oracle::read_sampled(ring, m, now, tick)?;
    match twap {
        Some(t) => Ok(Some((end, t))),
        None => {
            if end.ts > m.last_obs_ts {
                m.push_ckpt(end.ts, end.tick_cumulative);
                m.last_obs_ts = end.ts;
            }
            Ok(None)
        }
    }
}

/// The PumpSwap `Pool` a kind-1 market prices from: owned by PumpSwap, well-formed, and naming the
/// market's two vault slots. Returns its current `virtual_quote_reserves`.
fn pumpswap_pool_virtual(ps_pool: &AccountView, base_slot: &Address, quote_slot: &Address) -> Result<i128, ProgramError> {
    require(ps_pool.owner() == &PUMPSWAP, HookedError::InvalidOracle)?;
    let d = ps_pool.try_borrow()?;
    let info = venue::decode_pool(KIND_PUMPSWAP, &d, ps_pool.address().as_array())?;
    require(
        &info.slot_obs == base_slot.as_array() && &info.slot_pool == quote_slot.as_array(),
        HookedError::InvalidOracle,
    )?;
    Ok(venue::pumpswap_virtual_quote(&d))
}

/// Kinds 1-4: checks the slot accounts against the market (address + owner) and returns the venue's
/// current tick. `obs` is always `Market.oracle_obs`; `pool` is the first trailing account, which
/// kinds 1 and 2 require (it is the second vault) and kinds 3 and 4 only check when present;
/// `ps_pool` is the second trailing account, the PumpSwap `Pool`, required by kind 1 only.
fn venue_tick(
    m: &Market,
    obs: &AccountView,
    pool: Option<&AccountView>,
    ps_pool: Option<&AccountView>,
) -> Result<i32, ProgramError> {
    let kind = m.oracle_kind;
    match kind {
        KIND_PUMPSWAP | KIND_RAYDIUM_CPMM => {
            let p = pool.ok_or(HookedError::InvalidOracle)?;
            require(p.address() == &m.oracle_pool, HookedError::InvalidOracle)?;
            require(
                venue::is_token_program(obs.owner()) && venue::is_token_program(p.owner()),
                HookedError::InvalidOracle,
            )?;
            let (a0, a1) = (token_amount(obs)?, token_amount(p)?);
            if kind == KIND_PUMPSWAP {
                let ps = ps_pool.ok_or(HookedError::InvalidOracle)?;
                let virtual_quote = pumpswap_pool_virtual(ps, &m.oracle_obs, &m.oracle_pool)?;
                venue::pumpswap_tick(a0, a1, virtual_quote)
            } else {
                venue::tick_from_reserves(a0 as u128, a1 as u128)
            }
        }
        KIND_METEORA_DAMM_V2 | KIND_METEORA_DLMM => {
            if let Some(p) = pool {
                require(p.address() == &m.oracle_pool, HookedError::InvalidOracle)?;
            }
            require(Some(obs.owner()) == venue::program_for(kind), HookedError::InvalidOracle)?;
            let d = obs.try_borrow()?;
            venue::pool_tick(kind, &d)
        }
        _ => Err(HookedError::InvalidOracleKind.into()),
    }
}

/// Moves `1 - 1.0001^(-L·|Δtwap|)` of the losing vault to the winning vault for every new stored
/// Raydium observation, and accrues the same factor as curve price the loser owes to settle.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn rebalance(
    program_id: &Address,
    market: &mut AccountView,
    obs: &AccountView,
    vault_bull: &AccountView,
    vault_bear: &AccountView,
    token_program: &AccountView,
    pool: Option<&AccountView>,
    ps_pool: Option<&AccountView>,
) -> ProgramResult {
    require(market.owner() == program_id, HookedError::InvalidMarket)?;
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
        let now = Clock::get()?.unix_timestamp as u32;
        let read = if m.oracle_kind == KIND_RAYDIUM_CLMM {
            require(obs.owner() == &RAYDIUM_CLMM, HookedError::InvalidOracle)?;
            let od = obs.try_borrow()?;
            // a dead ring + the pool account => sample the pool's tick ourselves, on long windows only:
            // a 2-obs market keeps reading the ring, so a stale ring is no move until it writes again
            match pool {
                Some(p) if oracle::samples(&od, m, now) => {
                    require(p.address() == &m.oracle_pool && p.owner() == &RAYDIUM_CLMM, HookedError::InvalidOracle)?;
                    let tick = {
                        let pd = p.try_borrow()?;
                        i32::from_le_bytes(pd[RAY_POOL_TICK_CURRENT..RAY_POOL_TICK_CURRENT + 4].try_into().unwrap())
                    };
                    sample(Some(&od[..]), m, now, tick)?
                }
                _ => oracle::read(&od, m)?,
            }
        } else if oracle::is_two_obs(m.window_secs) {
            // no stored venue point to read, and a 2-obs market never samples: no move
            // (create_market refuses these; this covers any created before it did)
            None
        } else {
            // no ring anywhere: every rebalance samples the venue's current tick
            let tick = venue_tick(m, obs, pool, ps_pool)?;
            sample(None, m, now, tick)?
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
/// vault_bull, vault_bear, token program, (oracle pool), (pumpswap pool)]. Anyone may also call it
/// directly; it only rebalances. "observation"/"oracle pool" are the two `Market` oracle slots; for
/// kinds 1 and 2 they are the venue's two vaults and the sixth extra meta is therefore not optional;
/// kind 1 also carries the PumpSwap `Pool` as the seventh.
fn execute(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    if accounts.len() < 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (head, tail) = accounts.split_at_mut(10);
    let [_src, _mint, _dst, _auth, _metas, market, obs, vault_bull, vault_bear, token_program] = head else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    rebalance(program_id, market, obs, vault_bull, vault_bear, token_program, tail.first(), tail.get(1))
}

/// [market(w), observation, vault_bull(w), vault_bear(w), token program, (oracle pool), (pumpswap pool)]
/// The first trailing slot is optional for kind 0 (used when the ring is dead), required for kinds 1-2;
/// the second is required for kind 1 only.
fn poke(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (head, tail) = accounts.split_at_mut(5);
    let [market, obs, vault_bull, vault_bear, token_program] = head else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    rebalance(program_id, market, obs, vault_bull, vault_bear, token_program, tail.first(), tail.get(1))
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
    extras: &[(&Address, bool)],
) -> ProgramResult {
    let (key, bump) = find_pda(&[META_SEED, &mint.as_array()[..]], program_id);
    require(meta.address() == &key, HookedError::InvalidPda)?;
    let bump_b = [bump];
    let seeds = [Seed::from(META_SEED), Seed::from(mint.as_array()), Seed::from(&bump_b)];
    let len = meta_list_len(extras.len());
    cpi::create_pda_account(
        system,
        payer,
        meta,
        len as u64,
        program_id,
        rent.try_minimum_balance(len)?,
        &[Signer::from(&seeds)],
    )?;
    let mut d = meta.try_borrow_mut()?;
    d[..8].copy_from_slice(&EXECUTE_DISC);
    d[8..12].copy_from_slice(&((4 + 35 * extras.len()) as u32).to_le_bytes());
    d[12..16].copy_from_slice(&(extras.len() as u32).to_le_bytes());
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
/// data: window_secs u32 | underlying_is_token0 u8 | oracle_kind u8 (absent = 0, Raydium CLMM)
/// accounts: the 21 below, then for kinds 1 and 2 the venue pool account (PumpSwap `Pool` /
/// Raydium CPMM `PoolState`) whose vaults the two oracle slots must be. Kinds 3 and 4 pass the
/// pool itself in both slots. Kind 1 also records the PumpSwap `Pool` as a 7th extra account meta.
fn create_market(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < 21 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (head, tail) = accounts.split_at_mut(21);
    let [payer, market, vault_bull, vault_bear, bull_mint, bear_mint, pool_bull, pool_bear, bv_bull, bv_bear, qv_bull, qv_bear, quote_mint, esc_bull, esc_bear, meta_bull, meta_bear, oracle_pool, oracle_obs, system, token_program] =
        head
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let window = data
        .get(0..4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
        .ok_or(HookedError::InvalidInstruction)?;
    let flag = *data.get(4).ok_or(HookedError::InvalidInstruction)?;
    require(window > 0 && flag <= 1, HookedError::InvalidInstruction)?;
    let kind = data.get(5).copied().unwrap_or(KIND_RAYDIUM_CLMM);
    require(kind <= KIND_MAX, HookedError::InvalidOracleKind)?;
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

    // kind 0 keeps the ring; every other kind is verified against its venue pool and sampled now.
    // A 2-obs market never samples, so it needs a ring that records: kinds 1-4 and stale rings are refused.
    let now = Clock::get()?.unix_timestamp as u32;
    let two_obs = oracle::is_two_obs(window);
    let venue_tick0 = if kind == KIND_RAYDIUM_CLMM {
        require(
            oracle_obs.owner() == &RAYDIUM_CLMM && oracle_pool.owner() == &RAYDIUM_CLMM,
            HookedError::InvalidOracle,
        )?;
        let od = oracle_obs.try_borrow()?;
        oracle::check_header(&od, oracle_pool.address())?;
        require(!(two_obs && oracle::ring_is_stale(&od, now)), HookedError::TwoObsNeedsLiveRing)?;
        None
    } else {
        require(!two_obs, HookedError::TwoObsNeedsLiveRing)?;
        Some(check_venue(kind, flag, oracle_obs, oracle_pool, tail.first())?)
    };
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
    // kind 1 adds the PumpSwap Pool (account 21, already verified) so Execute can read its virtual quote
    let ps_pool_key = match (kind, tail.first()) {
        (KIND_PUMPSWAP, Some(p)) => p.address(),
        _ => &SYSTEM,
    };
    let extras = [
        (&market_key, true),
        (oracle_obs.address(), false),
        (vault_bull.address(), true),
        (vault_bear.address(), true),
        (&TOKENKEG, false),
        (oracle_pool.address(), false),
        (ps_pool_key, false),
    ];
    let extras = if kind == KIND_PUMPSWAP { &extras[..EXTRA_METAS_PUMPSWAP] } else { &extras[..EXTRA_METAS] };
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
    m.oracle_kind = kind;
    let (end, twap) = match venue_tick0 {
        Some(tick) => {
            // kinds 1-4: the sampled tick is the baseline; the first checkpoint anchors the window
            let (end, t) = oracle::read_sampled(None, m, now, tick)?;
            (end, t.unwrap_or((tick as i64) << 32))
        }
        None => {
            let od = oracle_obs.try_borrow()?;
            if oracle::samples(&od, m, now) {
                // dead ring: start from the pool's own tick, sampling takes over from here
                let tick = {
                    let pd = oracle_pool.try_borrow()?;
                    i32::from_le_bytes(pd[RAY_POOL_TICK_CURRENT..RAY_POOL_TICK_CURRENT + 4].try_into().unwrap())
                };
                let (end, t) = oracle::read_sampled(Some(&od[..]), m, now, tick)?;
                (end, t.unwrap_or((tick as i64) << 32))
            } else {
                oracle::read(&od, m)?.ok_or(HookedError::OracleWindowEmpty)?
            }
        }
    };
    m.last_twap_q32 = twap;
    m.last_obs_ts = end.ts;
    m.push_ckpt(end.ts, end.tick_cumulative);
    Ok(())
}

/// create_market for kinds 1-4: the venue pool must be owned by its program and decode to the two
/// slot addresses the client passed; its mints must be {underlying, WSOL|USDC|USDT} with the quote on
/// the side `flag` says. Returns the venue's current tick (the market's starting TWAP).
fn check_venue(
    kind: u8,
    flag: u8,
    obs: &AccountView,
    pool_slot: &AccountView,
    venue_pool: Option<&AccountView>,
) -> Result<i32, ProgramError> {
    let program = venue::program_for(kind).ok_or(HookedError::InvalidOracleKind)?;
    let (info, tick) = match kind {
        KIND_PUMPSWAP | KIND_RAYDIUM_CPMM => {
            let vp = venue_pool.ok_or(ProgramError::NotEnoughAccountKeys)?;
            require(vp.owner() == program, HookedError::InvalidOracle)?;
            let (info, virtual_quote) = {
                let d = vp.try_borrow()?;
                (venue::decode_pool(kind, &d, vp.address().as_array())?, venue::pumpswap_virtual_quote(&d))
            };
            require(
                venue::is_token_program(obs.owner()) && venue::is_token_program(pool_slot.owner()),
                HookedError::InvalidOracle,
            )?;
            // the slots are token accounts holding exactly the pool's two mints
            let a0 = {
                let d = obs.try_borrow()?;
                require(read_address(&d, 0)? == &info.mint0, HookedError::InvalidOracle)?;
                token_amount_bytes(&d)?
            };
            let a1 = {
                let d = pool_slot.try_borrow()?;
                require(read_address(&d, 0)? == &info.mint1, HookedError::InvalidOracle)?;
                token_amount_bytes(&d)?
            };
            let tick = if kind == KIND_PUMPSWAP {
                venue::pumpswap_tick(a0, a1, virtual_quote)?
            } else {
                venue::tick_from_reserves(a0 as u128, a1 as u128)?
            };
            (info, tick)
        }
        _ => {
            require(obs.address() == pool_slot.address() && obs.owner() == program, HookedError::InvalidOracle)?;
            let d = obs.try_borrow()?;
            let info = venue::decode_pool(kind, &d, obs.address().as_array())?;
            let tick = venue::pool_tick(kind, &d)?;
            (info, tick)
        }
    };
    require(
        &info.slot_obs == obs.address().as_array() && &info.slot_pool == pool_slot.address().as_array(),
        HookedError::InvalidOracle,
    )?;
    require(venue::underlying_flag(&info.mint0, &info.mint1, flag)? == flag, HookedError::UnderlyingFlagMismatch)?;
    Ok(tick)
}

/// Burn BULL/BEAR for a pro-rata share of that side's vault, minus REDEEM_FEE_BPS. The fee stays
/// in the vaults; FUNDING_SHARE_BPS of it moves to the other vault if that one is smaller.
/// [user(s), user_token(w), mint(w), user_quote(w), market(w), observation, vault_bull(w),
///  vault_bear(w), dbc_base_vault, token program, token-2022, burn_vault(w), dev_ata(w),
///  (oracle pool), (pumpswap pool)]; data: side u8 | amount u64
fn redeem(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < 13 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (head, tail) = accounts.split_at_mut(13);
    let [user, user_token, mint, user_quote, market, obs, vault_bull, vault_bear, base_vault, token_program, token_2022, burn_vault, dev_ata] = head else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let side = side_arg(data)?;
    let amount = amount_arg(data, 1)?;
    require(amount > 0, HookedError::ZeroAmount)?;
    require(user.is_signer(), HookedError::MissingSigner)?;
    require(token_2022.address() == &TOKEN_2022, HookedError::InvalidProgram)?;

    rebalance(program_id, market, obs, vault_bull, vault_bear, token_program, tail.first(), tail.get(1))?;

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

    cpi::burn(token_2022, user_token, mint, user, amount, &[])?;
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
///  mint(w), escrow(w), dbc_pool, instructions sysvar, (oracle pool), (pumpswap pool)];
/// data: side u8 | amount u64
fn settle_begin(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    if accounts.len() < 11 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (head, tail) = accounts.split_at_mut(11);
    let [caller, market, obs, vault_bull, vault_bear, token_program, token_2022, mint, escrow, pool, ix_sysvar] = head else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let side = side_arg(data)?;
    let amount = amount_arg(data, 1)?;
    require(amount > 0, HookedError::ZeroAmount)?;
    require(caller.is_signer(), HookedError::MissingSigner)?;
    require(token_2022.address() == &TOKEN_2022, HookedError::InvalidProgram)?;

    rebalance(program_id, market, obs, vault_bull, vault_bear, token_program, tail.first(), tail.get(1))?;

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

/// Canonical PumpSwap pool of MEME_MINT/WSOL: PDA ["pool", 0u16, pump ["pool-authority", mint], mint, WSOL].
fn check_meme_pool(ps_pool: &AccountView, ps_base_ata: &AccountView, ps_quote_ata: &AccountView) -> ProgramResult {
    require(ps_pool.owner() == &PUMPSWAP, HookedError::InvalidVenue)?;
    let mint = MEME_MINT.to_bytes();
    let (auth, _) = find_pda(&[b"pool-authority", &mint], &PUMP);
    let auth_b = auth.to_bytes();
    let index = 0u16.to_le_bytes();
    let wsol = WSOL.to_bytes();
    let (pool_key, _) = find_pda(&[b"pool", &index, &auth_b, &mint, &wsol], &PUMPSWAP);
    require(ps_pool.address() == &pool_key, HookedError::InvalidVenue)?;
    let d = ps_pool.try_borrow()?;
    if d.len() < PS_POOL_MIN_LEN || d[..8] != PS_POOL_DISC {
        return Err(HookedError::InvalidVenue.into());
    }
    require(read_address(&d, PS_BASE_MINT)? == MEME_MINT.as_array(), HookedError::InvalidVenue)?;
    require(read_address(&d, PS_QUOTE_MINT)? == WSOL.as_array(), HookedError::InvalidVenue)?;
    require(ps_base_ata.address().as_array() == read_address(&d, PS_BASE_ATA)?, HookedError::InvalidVenue)?;
    require(ps_quote_ata.address().as_array() == read_address(&d, PS_QUOTE_ATA)?, HookedError::InvalidVenue)?;
    Ok(())
}

/// (mint, owner) of a token account, plus its amount. `boost` rejects anything else.
fn launch_token(acct: &AccountView, mint: &[u8; 32], owner: &[u8; 32]) -> Result<u64, ProgramError> {
    let d = acct.try_borrow()?;
    if d.len() < 72 || read_address(&d, 0)? != mint || read_address(&d, 32)? != owner {
        return Err(HookedError::InvalidLaunchTokenAccount.into());
    }
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
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
            check_meme_pool(ps_pool, ps_base_ata, ps_quote_ata)?;
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
    cpi::burn(meme_program, caller_meme, meme_mint, caller, amount, &[])?;
    let sseeds = [Seed::from(BURN_STATE_SEED), Seed::from(&seeds)];
    cpi::transfer(token_program, burn_vault, caller_quote, burn_state, payout, &[Signer::from(&sseeds)])
}

/// register_launch(side u8, mode u8). One companion coin per (market, side). The lister is the creator.
///
/// 0 lister (signer, payer)
/// 1 market
/// 2 launch (w, init)            ["launch", market, side]
/// 3 pump_mint
/// 4 bonding_curve               pump ["bonding-curve", pump_mint]
/// 5 system_program
/// 6 sharing_config              Pump Fees ["sharing-config", pump_mint], read-only even when still empty
#[inline(never)]
fn register_launch(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [lister, market, launch, pump_mint, bonding_curve, system, sharing, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    require(lister.is_signer(), HookedError::MissingSigner)?;
    require(system.address() == &SYSTEM, HookedError::InvalidProgram)?;
    require(MEME_MINT != SYSTEM, HookedError::MemeNotSet)?;
    let side = side_arg(data)?;
    let mode = match data.get(1) {
        Some(&m) if m == LAUNCH_MODE_SHARED || m == LAUNCH_MODE_FULL => m,
        _ => return Err(HookedError::InvalidInstruction.into()),
    };
    require(market.owner() == program_id, HookedError::InvalidMarket)?;
    {
        let d = market.try_borrow()?;
        Market::from_bytes(&d)?;
    }
    let market_bytes = market.address().to_bytes();
    let side_b = [side];
    let (launch_key, bump) = find_pda(&[LAUNCH_SEED, &market_bytes, &side_b], program_id);
    require(launch.address() == &launch_key, HookedError::InvalidLaunch)?;
    if launch.data_len() != 0 {
        return Err(HookedError::LaunchExists.into());
    }
    let (_, sol_bump) = find_pda(&[LAUNCH_SOL_SEED, &market_bytes, &side_b], program_id);

    let mint_bytes = pump_mint.address().to_bytes();
    let (bc_key, _) = find_pda(&[b"bonding-curve", &mint_bytes], &PUMP);
    require(
        bonding_curve.address() == &bc_key && bonding_curve.owner() == &PUMP,
        HookedError::InvalidLaunchCurve,
    )?;
    let curve = {
        let d = bonding_curve.try_borrow()?;
        decode_curve(&d)?
    };
    require(curve.quote_mint == *MEME_MINT.as_array(), HookedError::InvalidLaunchCurve)?;
    let (sc_key, _) = find_pda(&[b"sharing-config", &mint_bytes], &PUMP_FEES);
    require(sharing.address() == &sc_key, HookedError::InvalidSharingConfig)?;
    if sharing.data_len() > 0 && sharing.owner() == &PUMP_FEES {
        let d = sharing.try_borrow()?;
        check_creator(
            &curve,
            &mint_bytes,
            lister.address().as_array(),
            launch.address().as_array(),
            sc_key.as_array(),
            Some(&d),
            mode,
        )?;
    } else {
        check_creator(
            &curve,
            &mint_bytes,
            lister.address().as_array(),
            launch.address().as_array(),
            sc_key.as_array(),
            None,
            mode,
        )?;
    }

    let rent = Rent::get()?;
    let bump_b = [bump];
    let seeds = [
        Seed::from(LAUNCH_SEED),
        Seed::from(&market_bytes),
        Seed::from(&side_b),
        Seed::from(&bump_b),
    ];
    cpi::create_pda_account(
        system,
        lister,
        launch,
        Launch::LEN as u64,
        program_id,
        rent.try_minimum_balance(Launch::LEN)?,
        &[Signer::from(&seeds)],
    )?;
    let mut d = launch.try_borrow_mut()?;
    d[..8].copy_from_slice(&LAUNCH_DISC);
    let rec = Launch::from_bytes_mut(&mut d)?;
    rec.market = *market.address();
    rec.pump_mint = *pump_mint.address();
    rec.creator = *lister.address();
    rec.side = side;
    rec.mode = mode;
    rec.bump = bump;
    rec.sol_bump = sol_bump;
    rec.total_sold = 0;
    rec.total_burned = 0;
    rec.total_lister = 0;
    rec.total_boost = 0;
    Ok(())
}

/// boost(min_quote_out u64). Permissionless. Below BOOST_DUST it is a success and moves nothing.
/// Spends only the Launch PDA's MEME account. Mode 1 also credits `lister_meme` (10%). The sell-leg
/// goes to the canonical MEME/WSOL PumpSwap pool; the WSOL is closed into `launch_sol` and deposited
/// to the stake pool, which mints r-freestacc into this side's vault. The burn-leg is burned.
///
///  0 caller (signer; pays rent, never debited of tokens)
///  1 market
///  2 launch (w)                     ["launch", market, side]
///  3 launch_meme (w)                Launch PDA's MEME token account — the only MEME spent
///  4 lister_meme (w)                lister's MEME token account (paid in mode 1 only)
///  5 side_vault (w)                 this side's market vault; receives r-freestacc
///  6 launch_sol (w)                 ["launch-sol", market, side], system-owned, unwrapped SOL
///  7 wsol_ata (w)                   Launch PDA's WSOL account; sell quote, then closed into launch_sol
///  8 meme_mint (w)
///  9 wsol_mint
/// 10 meme_token_program            Token-2022
/// 11 token_program                 Tokenkeg (WSOL, r-freestacc, the stake-pool mint)
/// 12 system_program
/// 13 pumpswap_program
/// 14 global_config                 ["global_config"]
/// 15 ps_pool (w)                   canonical MEME/WSOL pool (same derivation as burn_meme)
/// 16 pool_base (w)
/// 17 pool_quote (w)
/// 18 user_volume_accumulator (w)   ["user_volume_accumulator", launch]; created here if empty
/// 19 fee_config                    Pump Fees ["fee_config", PS_FEE_CONFIG_SEED]
/// 20 buyback_fee_recipient (w)
/// 21 event_authority               ["__event_authority"]
/// 22 stake_pool_program
/// 23 stake_pool (w)
/// 24 withdraw_authority            [stake_pool, "withdraw"]
/// 25 reserve_stake (w)
/// 26 manager_fee (w)
/// 27 pool_mint (w)                 QUOTE_MINT. Referral of the deposit is `side_vault` (not a separate account).
#[inline(never)]
fn boost(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [caller, market, launch, launch_meme, lister_meme, side_vault, launch_sol, wsol_ata, meme_mint, wsol_mint, meme_program, token_program, system, ps_program, global_config, ps_pool, pool_base, pool_quote, user_volume, fee_config, buyback, event_authority, sp_program, stake_pool, withdraw_authority, reserve, manager_fee, pool_mint, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let min_out = amount_arg(data, 0)?;
    require(caller.is_signer(), HookedError::MissingSigner)?;
    require(MEME_MINT != SYSTEM, HookedError::MemeNotSet)?;
    require(launch.owner() == program_id && market.owner() == program_id, HookedError::InvalidLaunch)?;
    require(market.address() != launch.address(), HookedError::InvalidLaunch)?;

    let (market_bytes, creator, side, mode, bump, sol_bump) = {
        let d = launch.try_borrow()?;
        let rec = Launch::from_bytes(&d)?;
        require(rec.market == *market.address(), HookedError::InvalidLaunch)?;
        (rec.market.to_bytes(), rec.creator.to_bytes(), rec.side, rec.mode, rec.bump, rec.sol_bump)
    };
    let side_b = [side];
    let bump_b = [bump];
    let derived = create_pda(&[LAUNCH_SEED, &market_bytes, &side_b, &bump_b], program_id)?;
    require(derived == *launch.address(), HookedError::InvalidLaunch)?;
    let vault_addr = {
        let d = market.try_borrow()?;
        let m = Market::from_bytes(&d)?;
        require(side == SIDE_BULL || side == SIDE_BEAR, HookedError::InvalidLaunch)?;
        *m.vault(side)
    };
    let bal = launch_token(launch_meme, MEME_MINT.as_array(), launch.address().as_array())?;
    let Some(split) = boost_split(bal, mode)? else {
        return Ok(());
    };

    require(side_vault.address() == &vault_addr, HookedError::InvalidVault)?;
    launch_token(side_vault, QUOTE_MINT.as_array(), market.address().as_array())?;
    launch_token(wsol_ata, WSOL.as_array(), launch.address().as_array())?;
    require(
        meme_mint.address() == &MEME_MINT
            && wsol_mint.address() == &WSOL
            && meme_mint.owner() == meme_program.address()
            && (meme_program.address() == &TOKEN_2022 || meme_program.address() == &TOKENKEG)
            && token_program.address() == &TOKENKEG
            && system.address() == &SYSTEM
            && ps_program.address() == &PUMPSWAP
            && sp_program.address() == &STAKE_POOL_PROGRAM
            && stake_pool.address() == &STAKE_POOL
            && pool_mint.address() == &QUOTE_MINT,
        HookedError::InvalidProgram,
    )?;
    let sol_bump_b = [sol_bump];
    let sol_key = create_pda(&[LAUNCH_SOL_SEED, &market_bytes, &side_b, &sol_bump_b], program_id)?;
    require(launch_sol.address() == &sol_key, HookedError::InvalidLaunch)?;
    let (gc, _) = find_pda(&[b"global_config"], &PUMPSWAP);
    let (uva, _) = find_pda(&[b"user_volume_accumulator", launch.address().as_array()], &PUMPSWAP);
    let (fc, _) = find_pda(&[b"fee_config", &PS_FEE_CONFIG_SEED], &PUMP_FEES);
    let (ev, _) = find_pda(&[b"__event_authority"], &PUMPSWAP);
    require(
        global_config.address() == &gc && user_volume.address() == &uva && fee_config.address() == &fc && event_authority.address() == &ev,
        HookedError::InvalidVenue,
    )?;
    check_meme_pool(ps_pool, pool_base, pool_quote)?;
    let (wa, _) = find_pda(&[STAKE_POOL.as_array(), b"withdraw"], &STAKE_POOL_PROGRAM);
    require(withdraw_authority.address() == &wa, HookedError::InvalidBurnAccounts)?;
    {
        let d = stake_pool.try_borrow()?;
        require(d.len() >= SP_MANAGER_FEE + 32, HookedError::InvalidBurnAccounts)?;
        require(read_address(&d, SP_RESERVE_STAKE)? == reserve.address().as_array(), HookedError::InvalidBurnAccounts)?;
        require(read_address(&d, SP_POOL_MINT)? == QUOTE_MINT.as_array(), HookedError::InvalidBurnAccounts)?;
        require(read_address(&d, SP_MANAGER_FEE)? == manager_fee.address().as_array(), HookedError::InvalidBurnAccounts)?;
    }

    let launch_seeds = [
        Seed::from(LAUNCH_SEED),
        Seed::from(&market_bytes),
        Seed::from(&side_b),
        Seed::from(&bump_b),
    ];
    let launch_signer = [Signer::from(&launch_seeds)];
    if split.lister > 0 {
        launch_token(lister_meme, MEME_MINT.as_array(), &creator)?;
        cpi::transfer(meme_program, launch_meme, lister_meme, launch, split.lister, &launch_signer)?;
    }
    if split.burn > 0 {
        cpi::burn(meme_program, launch_meme, meme_mint, launch, split.burn, &launch_signer)?;
    }
    if user_volume.data_len() == 0 {
        cpi::init_user_volume_accumulator(ps_program, caller, launch, user_volume, system, event_authority)?;
    }
    let pre_wsol = token_amount(wsol_ata)?;
    cpi::PumpSwapSellV2 {
        program: ps_program,
        pool: ps_pool,
        user: launch,
        global_config,
        base_mint: meme_mint,
        quote_mint: wsol_mint,
        user_base: launch_meme,
        user_quote: wsol_ata,
        pool_base,
        pool_quote,
        base_token_program: meme_program,
        quote_token_program: token_program,
        system,
        user_volume_accumulator: user_volume,
        fee_config,
        buyback_fee_recipient: buyback,
        event_authority,
    }
    .invoke(split.sell, min_out, &launch_signer)?;
    let got = token_amount(wsol_ata)?.checked_sub(pre_wsol).ok_or(HookedError::MathOverflow)?;

    let sol_seeds = [
        Seed::from(LAUNCH_SOL_SEED),
        Seed::from(&market_bytes),
        Seed::from(&side_b),
        Seed::from(&sol_bump_b),
    ];
    if launch_sol.lamports() == 0 {
        let rent0 = Rent::get()?.try_minimum_balance(0)?;
        cpi::create_pda_account(system, caller, launch_sol, 0, &SYSTEM, rent0, &[Signer::from(&sol_seeds)])?;
    } else {
        require(launch_sol.owner() == &SYSTEM && launch_sol.data_len() == 0, HookedError::InvalidLaunch)?;
    }
    cpi::close_account(token_program, wsol_ata, launch_sol, launch, &launch_signer)?;
    let floor = Rent::get()?.try_minimum_balance(0)?;
    let have = launch_sol.lamports();
    require(have >= floor, HookedError::MathOverflow)?;
    let spare = have - floor;
    let pre_vault = token_amount(side_vault)?;
    if spare > 0 {
        cpi::StakePoolDepositSol {
            program: sp_program,
            stake_pool,
            withdraw_authority,
            reserve_stake: reserve,
            funding: launch_sol,
            destination: side_vault,
            manager_fee,
            referral: side_vault,
            pool_mint,
            system,
            token_program,
        }
        .invoke(spare, &[Signer::from(&sol_seeds)])?;
    }
    let minted = token_amount(side_vault)?.saturating_sub(pre_vault);
    {
        let mut d = launch.try_borrow_mut()?;
        let rec = Launch::from_bytes_mut(&mut d)?;
        rec.total_sold = rec.total_sold.saturating_add(split.sell);
        rec.total_burned = rec.total_burned.saturating_add(split.burn);
        rec.total_lister = rec.total_lister.saturating_add(split.lister);
        rec.total_boost = rec.total_boost.saturating_add(minted);
    }
    log("boost", [split.sell, split.burn, split.lister, minted, got]);
    Ok(())
}
