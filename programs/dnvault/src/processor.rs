use {
    crate::{
        consts::*,
        cpi,
        error::VaultError,
        math,
        state::{signer, SolSeeds, Vault, VaultSeeds, VAULT_DISC},
        value::{self, addr},
    },
    pinocchio::{
        cpi::Seed,
        error::ProgramError,
        sysvars::{clock::Clock, instructions::Instructions, rent::Rent, Sysvar},
        AccountView, Address, ProgramResult,
    },
};

pub fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match *tag {
        TAG_CREATE_VAULT => create_vault(program_id, accounts, rest),
        TAG_DEPOSIT => deposit(program_id, accounts, rest),
        TAG_WITHDRAW => withdraw(program_id, accounts, rest),
        TAG_ACT => act(program_id, accounts, rest),
        TAG_SETTLE => settle(program_id, accounts),
        TAG_WRAP => wrap(program_id, accounts, rest),
        TAG_UNWRAP => unwrap(program_id, accounts),
        TAG_BIND_POSITION => bind_position(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
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

fn req(cond: bool, e: VaultError) -> ProgramResult {
    if cond { Ok(()) } else { Err(e.into()) }
}
fn u64_arg(data: &[u8], at: usize) -> Result<u64, ProgramError> {
    data.get(at..at + 8).map(|b| u64::from_le_bytes(b.try_into().unwrap())).ok_or(ProgramError::InvalidInstructionData)
}
fn i32_arg(data: &[u8], at: usize) -> Result<i32, ProgramError> {
    data.get(at..at + 4).map(|b| i32::from_le_bytes(b.try_into().unwrap())).ok_or(ProgramError::InvalidInstructionData)
}
fn u16_arg(data: &[u8], at: usize) -> Result<u16, ProgramError> {
    data.get(at..at + 2).map(|b| u16::from_le_bytes(b.try_into().unwrap())).ok_or(ProgramError::InvalidInstructionData)
}

/// [creator(s,w), vault(w), share_mint(w), sol_pda(w), market, clmm pool, x mint, down mint,
///  vault wsol ata, vault x ata, vault quote ata, vault down ata (addresses; anyone creates them later),
///  system, token program]; data: tick_lower i32 | tick_upper i32 | band_bps u16 | max_loss_bps u16 | keeper_bps u16
fn create_vault(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [creator, vault, share_mint, sol_pda, market, pool, x_mint, down_mint, wsol_ata, x_ata, quote_ata, down_ata, system, token_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let tick_lower = i32_arg(data, 0)?;
    let tick_upper = i32_arg(data, 4)?;
    let band_bps = u16_arg(data, 8)?;
    let max_loss_bps = u16_arg(data, 10)?;
    let keeper_bps = u16_arg(data, 12)?;
    req(creator.is_signer(), VaultError::MissingSigner)?;
    req(token_program.address() == &TOKENKEG && system.address() == &SYSTEM, VaultError::InvalidProgram)?;
    req(tick_lower < tick_upper && tick_lower >= math::MIN_TICK && tick_upper <= math::MAX_TICK, VaultError::InvalidTick)?;
    req(band_bps > 0 && band_bps <= 5_000 && max_loss_bps <= 2_000 && keeper_bps <= 1_000, VaultError::InvalidAccount)?;

    let (bear_mint, oracle_pool, x_is_token0) = {
        let m = market.try_borrow()?;
        req(market.owner() == &HOOKED && m.len() == MARKET_LEN && m[..8] == MARKET_DISC, VaultError::InvalidMarket)?;
        (addr(&m, MKT_BEAR_MINT), addr(&m, MKT_ORACLE_POOL), m[MKT_UNDERLYING_IS_TOKEN0])
    };
    req(pool.address() == &oracle_pool && pool.owner() == &RAYDIUM_CLMM, VaultError::InvalidPool)?;
    {
        let p = pool.try_borrow()?;
        req(p.len() > POOL_TICK_CURRENT + 4 && p[..8] == POOL_DISC, VaultError::InvalidPool)?;
        let spacing = u16::from_le_bytes(p[POOL_TICK_SPACING..POOL_TICK_SPACING + 2].try_into().unwrap()) as i32;
        req(spacing > 0 && tick_lower.rem_euclid(spacing) == 0 && tick_upper.rem_euclid(spacing) == 0, VaultError::InvalidTick)?;
        let (xo, so) = if x_is_token0 == 1 { (POOL_MINT0, POOL_MINT1) } else { (POOL_MINT1, POOL_MINT0) };
        req(x_mint.address() == &addr(&p, xo) && addr(&p, so) == WSOL, VaultError::InvalidPool)?;
    }
    req(down_mint.address() == &bear_mint, VaultError::InvalidMarket)?;

    let lo = tick_lower.to_le_bytes();
    let hi = tick_upper.to_le_bytes();
    let (vk, bump) = find_pda(&[VAULT_SEED, market.address().as_array(), &lo, &hi], program_id);
    req(&vk == vault.address(), VaultError::InvalidVault)?;
    let (sk, sbump) = find_pda(&[SHARES_SEED, vault.address().as_array()], program_id);
    req(&sk == share_mint.address(), VaultError::InvalidAccount)?;
    let (solk, sol_bump) = find_pda(&[SOL_SEED, vault.address().as_array()], program_id);
    req(&solk == sol_pda.address(), VaultError::InvalidAccount)?;
    let x_is_t22 = x_mint.owner() == &TOKEN_2022;
    req(x_is_t22 || x_mint.owner() == &TOKENKEG, VaultError::InvalidAccount)?;
    // WSOL and X belong to the SOL sub-account (Raydium's rent payer must own the deposited tokens); DOWN and quote to the vault.
    for (acc, owner, mint, prog) in [
        (&*wsol_ata, &solk, &WSOL, &TOKENKEG),
        (&*x_ata, &solk, x_mint.address(), if x_is_t22 { &TOKEN_2022 } else { &TOKENKEG }),
        (&*quote_ata, &vk, &QUOTE_MINT, &TOKENKEG),
        (&*down_ata, &vk, down_mint.address(), &TOKEN_2022),
    ] {
        let (a, _) = find_pda(&[owner.as_array(), prog.as_array(), mint.as_array()], &ATA_PROGRAM);
        req(&a == acc.address(), VaultError::InvalidAccount)?;
    }

    let rent = Rent::get()?;
    let seeds = VaultSeeds { market: market.address().to_bytes(), lower: lo, upper: hi, bump: [bump] };
    let s = seeds.seeds();
    cpi::create_pda_account(creator, vault, rent.minimum_balance(Vault::LEN), Vault::LEN, program_id, &[signer(&s)])?;
    let sb = [sbump];
    let ss = [Seed::from(SHARES_SEED.as_slice()), Seed::from(vault.address().as_array().as_slice()), Seed::from(sb.as_slice())];
    cpi::create_pda_account(creator, share_mint, rent.minimum_balance(MINT_LEN), MINT_LEN, &TOKENKEG, &[signer(&ss)])?;
    cpi::initialize_mint2(token_program, share_mint, vault.address(), SHARE_DECIMALS)?;
    let sol_seeds = SolSeeds { vault: vault.address().to_bytes(), bump: [sol_bump] };
    let sol_s = sol_seeds.seeds();
    cpi::create_pda_account(creator, sol_pda, rent.minimum_balance(0), 0, &SYSTEM, &[signer(&sol_s)])?;

    let mut d = vault.try_borrow_mut()?;
    d[..8].copy_from_slice(&VAULT_DISC);
    let v = Vault::from_bytes_mut(&mut d)?;
    v.market = *market.address();
    v.pool = *pool.address();
    v.x_mint = *x_mint.address();
    v.down_mint = *down_mint.address();
    v.share_mint = *share_mint.address();
    v.wsol_ata = *wsol_ata.address();
    v.x_ata = *x_ata.address();
    v.quote_ata = *quote_ata.address();
    v.down_ata = *down_ata.address();
    v.position = Address::default();
    v.position_nft = Address::default();
    v.creator = *creator.address();
    v.sol_pda = *sol_pda.address();
    v.tick_lower = tick_lower;
    v.tick_upper = tick_upper;
    v.band_bps = band_bps;
    v.max_loss_bps = max_loss_bps;
    v.keeper_bps = keeper_bps;
    v.bump = bump;
    v.x_is_token0 = if x_is_token0 == 1 { 1 } else { 0 };
    v.snap_active = 0;
    v.sol_bump = sol_bump;
    v.x_is_t22 = if x_is_t22 { 1 } else { 0 };
    Ok(())
}

/// [user(s,w), vault(w), share_mint(w), user share ata(w), VAL_ACCOUNTS..., system, token program]; data: lamports u64
fn deposit(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let lamports = u64_arg(data, 0)?;
    req(lamports > 0, VaultError::ZeroAmount)?;
    let (head, tail) = accounts.split_at_mut(4);
    let [user, vault, share_mint, user_share_ata] = head else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if tail.len() < VAL_ACCOUNTS + 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let val = &tail[..VAL_ACCOUNTS];
    let token_program = &tail[VAL_ACCOUNTS + 1];
    req(user.is_signer(), VaultError::MissingSigner)?;
    req(vault.owner() == program_id, VaultError::InvalidVault)?;
    req(token_program.address() == &TOKENKEG, VaultError::InvalidProgram)?;
    let (nav, seeds) = {
        let d = vault.try_borrow()?;
        let v = Vault::from_bytes(&d)?;
        req(v.snap_active == 0, VaultError::SnapshotActive)?;
        req(share_mint.address() == &v.share_mint, VaultError::InvalidAccount)?;
        (value::value(v, vault, val)?.nav, v.seeds())
    };
    let supply = value::mint_supply(share_mint)?;
    let shares = if supply == 0 {
        lamports
    } else {
        req(nav > 0, VaultError::MathOverflow)?;
        math::mul_div_u64(lamports, supply, nav).ok_or(VaultError::MathOverflow)?
    };
    req(shares > 0, VaultError::ZeroAmount)?;
    cpi::system_transfer(user, &val[11], lamports)?;
    let s = seeds.seeds();
    cpi::mint_to(token_program, share_mint, user_share_ata, vault, shares, &[signer(&s)])
}

/// Pro-rata, in kind: SOL, WSOL, quote, X, DOWN, and the position's share via decrease_liquidity.
/// [user(s,w), vault(w), share_mint(w), user share ata(w), VAL_ACCOUNTS..., user wsol ata(w), user quote ata(w),
///  user x ata(w), user down ata(w), token program, token-2022, system, hook accounts (n_extra),
///  clmm program + decrease_liquidity_v2 accounts (only when the vault holds a position)];
/// data: shares u64 | n_extra u8
fn withdraw(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let shares = u64_arg(data, 0)?;
    let n_extra = *data.get(8).ok_or(ProgramError::InvalidInstructionData)? as usize;
    req(shares > 0, VaultError::ZeroAmount)?;
    let (head, tail) = accounts.split_at_mut(4);
    let [user, vault, share_mint, user_share_ata] = head else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if tail.len() < VAL_ACCOUNTS + 8 + n_extra {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (val, rest) = tail.split_at(VAL_ACCOUNTS);
    let [user_wsol, user_quote, user_x, user_down, token_program, token_2022, system, x_mint_acc, rest2 @ ..] = rest else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (extras, dec) = rest2.split_at(n_extra);
    req(user.is_signer() && user.is_writable(), VaultError::MissingSigner)?;
    req(vault.owner() == program_id, VaultError::InvalidVault)?;
    req(token_program.address() == &TOKENKEG && token_2022.address() == &TOKEN_2022 && system.address() == &SYSTEM, VaultError::InvalidProgram)?;

    let supply = value::mint_supply(share_mint)?;
    req(supply > 0 && shares <= supply, VaultError::NoShares)?;
    let pay = |amount: u64| math::mul_div_u64(amount, shares, supply).ok_or(VaultError::MathOverflow);

    let vaddr = *vault.address();
    let (seeds, sol_seeds, x_mint, down_mint, has_position, position_addr, x_is_t22) = {
        let d = vault.try_borrow()?;
        let v = Vault::from_bytes(&d)?;
        req(v.snap_active == 0, VaultError::SnapshotActive)?;
        req(share_mint.address() == &v.share_mint, VaultError::InvalidAccount)?;
        req(
            val[4].address() == &v.down_ata
                && val[7].address() == &v.wsol_ata
                && val[8].address() == &v.x_ata
                && val[9].address() == &v.quote_ata
                && val[2].address() == &v.down_mint
                && val[11].address() == &v.sol_pda,
            VaultError::InvalidAccount,
        )?;
        (v.seeds(), v.sol_seeds(&vaddr), v.x_mint, v.down_mint, v.has_position(), v.position, v.x_is_t22 == 1)
    };
    let s = seeds.seeds();
    let sol_s = sol_seeds.seeds();

    cpi::burn(token_program, user_share_ata, share_mint, user, shares)?;

    // SOL
    let free = val[11].lamports().saturating_sub(value::sol_floor()?);
    let pay_l = pay(free)?;
    if pay_l > 0 {
        cpi::system_transfer_signed(&val[11], user, pay_l, &[signer(&sol_s)])?;
    }
    // fungible legs: WSOL and X are owned by the SOL sub-account, quote by the vault
    let sol_acc = &val[11];
    for (from, to, mint) in [(&val[7], user_wsol, WSOL), (&val[9], user_quote, QUOTE_MINT)] {
        let by_sol = mint == WSOL;
        let amt = value::token_amount(from, &mint, if by_sol { sol_acc.address() } else { &vaddr })?;
        let p = pay(amt)?;
        if p > 0 {
            if by_sol {
                cpi::transfer(token_program, from, to, sol_acc, p, &[signer(&sol_s)])?;
            } else {
                cpi::transfer(token_program, from, to, vault, p, &[signer(&s)])?;
            }
        }
    }
    // X: Token-2022 mints with extensions insist on transfer_checked (needs the mint account)
    req(x_mint_acc.address() == &x_mint, VaultError::InvalidAccount)?;
    let px = pay(value::token_amount(&val[8], &x_mint, sol_acc.address())?)?;
    if px > 0 {
        if x_is_t22 {
            let dec = value::mint_decimals(x_mint_acc)?;
            cpi::transfer_checked_hooked(token_2022, &val[8], x_mint_acc, user_x, sol_acc, &[], px, dec, &[signer(&sol_s)])?;
        } else {
            cpi::transfer(token_program, &val[8], user_x, sol_acc, px, &[signer(&sol_s)])?;
        }
    }
    // DOWN (transfer hook: hook accounts forwarded as given)
    let down_amt = value::token_amount(&val[4], &down_mint, &vaddr)?;
    let p = pay(down_amt)?;
    if p > 0 {
        let decimals = value::mint_decimals(&val[2])?;
        cpi::transfer_checked_hooked(token_2022, &val[4], &val[2], user_down, vault, extras, p, decimals, &[signer(&s)])?;
    }
    // position share
    if has_position {
        let position = &val[6];
        req(position.address() == &position_addr, VaultError::PositionMismatch)?;
        let liq = {
            let pd = position.try_borrow()?;
            if pd.len() >= POS_MIN_LEN && position.owner() == &RAYDIUM_CLMM { u128::from_le_bytes(pd[POS_LIQUIDITY..POS_LIQUIDITY + 16].try_into().unwrap()) } else { 0 }
        };
        let share_liq = math::mul_div(liq, shares as u128, supply as u128).ok_or(VaultError::MathOverflow)?;
        if share_liq > 0 {
            if dec.len() < 2 {
                return Err(ProgramError::NotEnoughAccountKeys);
            }
            let clmm = &dec[0];
            let inner = &dec[1..];
            req(clmm.address() == &RAYDIUM_CLMM && inner[0].address() == sol_acc.address(), VaultError::InvalidProgram)?;
            let mut ixd = [0u8; 40];
            ixd[..8].copy_from_slice(&RAY_DECREASE_V2);
            ixd[8..24].copy_from_slice(&share_liq.to_le_bytes());
            cpi::forward2(clmm, inner, &ixd, &vaddr, sol_acc.address(), &[signer(&s), signer(&sol_s)])?;
        }
    }
    Ok(())
}

/// Keeper action: forward one allowlisted instruction signed by the vault (and its SOL sub-account).
/// The first act in a transaction snapshots NAV + hedge error and requires a `settle` for this vault later in the tx.
/// [vault(w), instructions sysvar, target program, VAL_ACCOUNTS..., inner accounts...]; data: inner data
fn act(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (head, tail) = accounts.split_at_mut(3);
    let [vault, ix_sysvar, target] = head else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if tail.len() < VAL_ACCOUNTS + 1 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let (val, inner) = tail.split_at(VAL_ACCOUNTS);
    req(vault.owner() == program_id && target.address() != program_id, VaultError::InvalidVault)?;
    let vaddr = *vault.address();

    {
        let d = vault.try_borrow()?;
        let v = Vault::from_bytes(&d)?;
        let m = val[0].try_borrow()?;
        req(val[0].address() == &v.market && m.len() == MARKET_LEN && val[11].address() == &v.sol_pda, VaultError::InvalidMarket)?;
        let ok = if target.address() == &RAYDIUM_CLMM {
            data.len() >= 8
                && [RAY_OPEN_POSITION_T22, RAY_OPEN_POSITION_V2, RAY_INCREASE_V2, RAY_DECREASE_V2, RAY_SWAP_V2, RAY_CLOSE_POSITION].iter().any(|x| x == &data[..8])
        } else if target.address() == &DBC {
            data.len() >= 24 && data[..8] == DBC_SWAP2_HOOK_DISC && inner.len() > 3 && inner[2].address() == &addr(&m, MKT_POOL_BEAR)
        } else if target.address() == &HOOKED {
            data.len() >= 10 && data[0] == HOOKED_TAG_REDEEM && data[1] == 1 && inner.len() > 5 && inner[4].address() == &v.market
        } else if target.address() == &STAKE_POOL_PROGRAM {
            // DepositSol: funder = sol_pda, destination = quote ata. WithdrawSol: authority = vault, from = quote ata, lamports to sol_pda.
            data.len() >= 9
                && inner.len() > 5
                && inner[0].address() == &STAKE_POOL
                && ((data[0] == SP_DEPOSIT_SOL && inner[3].address() == &v.sol_pda && inner[4].address() == &v.quote_ata)
                    || (data[0] == SP_WITHDRAW_SOL && inner[2].address() == &vaddr && inner[3].address() == &v.quote_ata && inner[5].address() == &v.sol_pda))
        } else {
            false
        };
        req(ok, VaultError::NotAllowlisted)?;
    }

    let fresh = {
        let d = vault.try_borrow()?;
        Vault::from_bytes(&d)?.snap_active == 0
    };
    if fresh {
        let ixs = Instructions::try_from(&*ix_sysvar)?;
        let cur = ixs.load_current_index() as usize;
        let mut found = false;
        for i in cur + 1..ixs.num_instructions() {
            let ix = ixs.load_instruction_at(i)?;
            if ix.get_program_id() == program_id && ix.get_instruction_data().first() == Some(&TAG_SETTLE) && ix.get_instruction_account_at(0)?.key == vaddr {
                found = true;
                break;
            }
        }
        req(found, VaultError::SettleMissing)?;
        let (nav, err, d0, fees) = {
            let d = vault.try_borrow()?;
            let v = Vault::from_bytes(&d)?;
            let x = value::value(v, vault, val)?;
            (x.nav, x.err_bps, x.d, x.fees)
        };
        let mut d = vault.try_borrow_mut()?;
        let v = Vault::from_bytes_mut(&mut d)?;
        v.snap_nav = nav;
        v.snap_err_bps = err;
        v.snap_d = d0;
        v.snap_fees = fees;
        v.snap_slot = Clock::get()?.slot;
        v.snap_active = 1;
    }
    let (seeds, sol_seeds, sol_pda) = {
        let d = vault.try_borrow()?;
        let v = Vault::from_bytes(&d)?;
        (v.seeds(), v.sol_seeds(&vaddr), v.sol_pda)
    };
    let s = seeds.seeds();
    let sol_s = sol_seeds.seeds();
    cpi::forward2(target, inner, data, &vaddr, &sol_pda, &[signer(&s), signer(&sol_s)])
}

/// Closes a rebalance: NAV may not have dropped more than max_loss_bps and the hedge must be inside
/// the band or no worse than at the snapshot. Pays the keeper keeper_bps of the hedge it moved plus
/// the fees it harvested, in SOL. [vault(w), keeper(s,w), system, VAL_ACCOUNTS...]
fn settle(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let (head, tail) = accounts.split_at_mut(3);
    let [vault, keeper, system] = head else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if tail.len() < VAL_ACCOUNTS {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let val = &tail[..VAL_ACCOUNTS];
    req(vault.owner() == program_id, VaultError::InvalidVault)?;
    req(keeper.is_signer() && system.address() == &SYSTEM, VaultError::MissingSigner)?;
    let vaddr = *vault.address();
    let (snap_nav, snap_err, snap_d, snap_fees, band, max_loss, keeper_bps, x, sol_seeds) = {
        let d = vault.try_borrow()?;
        let v = Vault::from_bytes(&d)?;
        req(v.snap_active == 1, VaultError::NoSnapshot)?;
        let x = value::value(v, vault, val)?;
        (v.snap_nav as u128, v.snap_err_bps, v.snap_d, v.snap_fees, v.band_bps as u64, v.max_loss_bps as u128, v.keeper_bps as u128, x, v.sol_seeds(&vaddr))
    };
    req((x.nav as u128) >= snap_nav * (BPS - max_loss) / BPS, VaultError::ValueLeaked)?;
    req(x.err_bps <= band || x.err_bps <= snap_err, VaultError::HedgeWorse)?;
    {
        let mut d = vault.try_borrow_mut()?;
        let v = Vault::from_bytes_mut(&mut d)?;
        v.snap_active = 0;
        v.snap_nav = 0;
        v.snap_err_bps = 0;
        v.snap_d = 0;
        v.snap_fees = 0;
    }
    let moved = if x.d > snap_d { x.d - snap_d } else { snap_d - x.d } as u128;
    let harvested = snap_fees.saturating_sub(x.fees) as u128;
    let bounty = ((moved + harvested) * keeper_bps / BPS) as u64;
    let free = val[11].lamports().saturating_sub(value::sol_floor()?);
    let pay = bounty.min(free);
    if pay > 0 {
        let sol_s = sol_seeds.seeds();
        cpi::system_transfer_signed(&val[11], keeper, pay, &[signer(&sol_s)])?;
    }
    Ok(())
}

/// Move SOL from the sub-account into the vault's WSOL account.
/// [vault, sol_pda(w), vault wsol ata(w), system, token program]; data: lamports u64
fn wrap(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let lamports = u64_arg(data, 0)?;
    let [vault, sol_pda, wsol_ata, system, token_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    req(vault.owner() == program_id, VaultError::InvalidVault)?;
    req(token_program.address() == &TOKENKEG && system.address() == &SYSTEM, VaultError::InvalidProgram)?;
    let sol_seeds = {
        let d = vault.try_borrow()?;
        let v = Vault::from_bytes(&d)?;
        req(wsol_ata.address() == &v.wsol_ata && sol_pda.address() == &v.sol_pda, VaultError::InvalidAccount)?;
        v.sol_seeds(vault.address())
    };
    let free = sol_pda.lamports().saturating_sub(value::sol_floor()?);
    req(lamports > 0 && lamports <= free, VaultError::ZeroAmount)?;
    let sol_s = sol_seeds.seeds();
    cpi::system_transfer_signed(sol_pda, wsol_ata, lamports, &[signer(&sol_s)])?;
    cpi::sync_native(token_program, wsol_ata)
}

/// Close the WSOL account back into the SOL sub-account. [vault, sol_pda(w), vault wsol ata(w), token program]
fn unwrap(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [vault, sol_pda, wsol_ata, token_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    req(vault.owner() == program_id, VaultError::InvalidVault)?;
    req(token_program.address() == &TOKENKEG, VaultError::InvalidProgram)?;
    let sol_seeds = {
        let d = vault.try_borrow()?;
        let v = Vault::from_bytes(&d)?;
        req(wsol_ata.address() == &v.wsol_ata && sol_pda.address() == &v.sol_pda, VaultError::InvalidAccount)?;
        v.sol_seeds(vault.address())
    };
    let sol_s = sol_seeds.seeds();
    cpi::close_account(token_program, wsol_ata, sol_pda, sol_pda, &[signer(&sol_s)])
}

/// Pin the vault's Raydium position (its NFT must sit in a vault-owned token account), or unpin a
/// closed one by passing the vault as `position` and the old position account as `nft_account`.
/// [vault(w), position, nft token account]
fn bind_position(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [vault, position, nft_account, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    req(vault.owner() == program_id, VaultError::InvalidVault)?;
    let vaddr = *vault.address();
    let mut d = vault.try_borrow_mut()?;
    let v = Vault::from_bytes_mut(&mut d)?;
    if position.address() == &vaddr {
        req(v.has_position() && nft_account.address() == &v.position && nft_account.data_len() == 0, VaultError::PositionMismatch)?;
        v.position = Address::default();
        v.position_nft = Address::default();
        return Ok(());
    }
    req(!v.has_position(), VaultError::PositionMismatch)?;
    let p = position.try_borrow()?;
    req(
        position.owner() == &RAYDIUM_CLMM
            && p.len() >= POS_MIN_LEN
            && p[..8] == POS_DISC
            && addr(&p, POS_POOL) == v.pool
            && i32::from_le_bytes(p[POS_TICK_LOWER..POS_TICK_LOWER + 4].try_into().unwrap()) == v.tick_lower
            && i32::from_le_bytes(p[POS_TICK_UPPER..POS_TICK_UPPER + 4].try_into().unwrap()) == v.tick_upper,
        VaultError::PositionMismatch,
    )?;
    let nft_mint = addr(&p, POS_NFT_MINT);
    req(value::token_amount(nft_account, &nft_mint, &v.sol_pda)? == 1, VaultError::PositionMismatch)?;
    v.position = *position.address();
    v.position_nft = nft_mint;
    Ok(())
}
