//! Minimal CPI builders (SPL Token / Token-2022 share these layouts; System; Meteora DBC).

use pinocchio::{
    cpi::{invoke_signed, Signer},
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address, ProgramResult,
};

fn amount_ix(tag: u8, amount: u64) -> [u8; 9] {
    let mut d = [0u8; 9];
    d[0] = tag;
    d[1..].copy_from_slice(&amount.to_le_bytes());
    d
}

/// Transfer (3): source(w), destination(w), authority(s)
pub fn transfer(
    program: &AccountView,
    from: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    amount: u64,
    signers: &[Signer],
) -> ProgramResult {
    let data = amount_ix(3, amount);
    let metas = [
        InstructionAccount::writable(from.address()),
        InstructionAccount::writable(to.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    let ix = InstructionView { program_id: program.address(), data: &data, accounts: &metas };
    invoke_signed(&ix, &[from, to, authority], signers)
}

/// MintTo (7): mint(w), destination(w), authority(s)
pub fn mint_to(
    program: &AccountView,
    mint: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    amount: u64,
    signers: &[Signer],
) -> ProgramResult {
    let data = amount_ix(7, amount);
    let metas = [
        InstructionAccount::writable(mint.address()),
        InstructionAccount::writable(to.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    let ix = InstructionView { program_id: program.address(), data: &data, accounts: &metas };
    invoke_signed(&ix, &[mint, to, authority], signers)
}

/// Burn (8): account(w), mint(w), owner(s). `signers` is empty when the owner signed the transaction.
pub fn burn(
    program: &AccountView,
    account: &AccountView,
    mint: &AccountView,
    owner: &AccountView,
    amount: u64,
    signers: &[Signer],
) -> ProgramResult {
    let data = amount_ix(8, amount);
    let metas = [
        InstructionAccount::writable(account.address()),
        InstructionAccount::writable(mint.address()),
        InstructionAccount::readonly_signer(owner.address()),
    ];
    let ix = InstructionView { program_id: program.address(), data: &data, accounts: &metas };
    invoke_signed(&ix, &[account, mint, owner], signers)
}

/// CloseAccount (9): account(w), destination(w), owner(s). Moves every lamport (a native account's
/// wrapped SOL plus its rent) to `destination`.
pub fn close_account(
    program: &AccountView,
    account: &AccountView,
    destination: &AccountView,
    owner: &AccountView,
    signers: &[Signer],
) -> ProgramResult {
    let data = [9u8];
    let metas = [
        InstructionAccount::writable(account.address()),
        InstructionAccount::writable(destination.address()),
        InstructionAccount::readonly_signer(owner.address()),
    ];
    let ix = InstructionView { program_id: program.address(), data: &data, accounts: &metas };
    invoke_signed(&ix, &[account, destination, owner], signers)
}

/// Creates PumpSwap's ["user_volume_accumulator", user] when it is still empty. `payer` signed the
/// outer transaction; `user` does not sign. `boost` calls this before `sell_v2` because the Launch
/// PDA holds data and cannot pay the accumulator's rent itself.
pub fn init_user_volume_accumulator(
    program: &AccountView,
    payer: &AccountView,
    user: &AccountView,
    accumulator: &AccountView,
    system: &AccountView,
    event_authority: &AccountView,
) -> ProgramResult {
    let metas = [
        InstructionAccount::writable_signer(payer.address()),
        InstructionAccount::readonly(user.address()),
        InstructionAccount::writable(accumulator.address()),
        InstructionAccount::readonly(system.address()),
        InstructionAccount::readonly(event_authority.address()),
        InstructionAccount::readonly(program.address()),
    ];
    let ix = InstructionView { program_id: program.address(), data: &crate::consts::PS_INIT_USER_VOLUME_DISC, accounts: &metas };
    invoke_signed(&ix, &[payer, user, accumulator, system, event_authority, program], &[])
}

/// PumpSwap `sell_v2` (pump-public-docs idl/pump_amm.json; 17 accounts, no remaining accounts):
/// sells `base_amount_in` of the pool's base for at least `min_quote_amount_out` quote. Protocol and
/// creator fees stay in the pool; `user_volume_accumulator` must already exist when `user` cannot
/// pay rent (a PDA with data). `boost` creates it with `init_user_volume_accumulator` first.
pub struct PumpSwapSellV2<'a> {
    pub program: &'a AccountView,
    pub pool: &'a AccountView,
    pub user: &'a AccountView,
    pub global_config: &'a AccountView,
    pub base_mint: &'a AccountView,
    pub quote_mint: &'a AccountView,
    pub user_base: &'a AccountView,
    pub user_quote: &'a AccountView,
    pub pool_base: &'a AccountView,
    pub pool_quote: &'a AccountView,
    pub base_token_program: &'a AccountView,
    pub quote_token_program: &'a AccountView,
    pub system: &'a AccountView,
    pub user_volume_accumulator: &'a AccountView,
    pub fee_config: &'a AccountView,
    pub buyback_fee_recipient: &'a AccountView,
    pub event_authority: &'a AccountView,
}

impl PumpSwapSellV2<'_> {
    pub fn invoke(&self, base_amount_in: u64, min_quote_amount_out: u64, signers: &[Signer]) -> ProgramResult {
        let mut data = [0u8; 24];
        data[..8].copy_from_slice(&crate::consts::PS_SELL_V2_DISC);
        data[8..16].copy_from_slice(&base_amount_in.to_le_bytes());
        data[16..24].copy_from_slice(&min_quote_amount_out.to_le_bytes());
        let metas = [
            InstructionAccount::writable(self.pool.address()),
            InstructionAccount::writable_signer(self.user.address()),
            InstructionAccount::readonly(self.global_config.address()),
            InstructionAccount::readonly(self.base_mint.address()),
            InstructionAccount::readonly(self.quote_mint.address()),
            InstructionAccount::writable(self.user_base.address()),
            InstructionAccount::writable(self.user_quote.address()),
            InstructionAccount::writable(self.pool_base.address()),
            InstructionAccount::writable(self.pool_quote.address()),
            InstructionAccount::readonly(self.base_token_program.address()),
            InstructionAccount::readonly(self.quote_token_program.address()),
            InstructionAccount::readonly(self.system.address()),
            InstructionAccount::writable(self.user_volume_accumulator.address()),
            InstructionAccount::readonly(self.fee_config.address()),
            InstructionAccount::writable(self.buyback_fee_recipient.address()),
            InstructionAccount::readonly(self.event_authority.address()),
            InstructionAccount::readonly(self.program.address()),
        ];
        let ix = InstructionView { program_id: self.program.address(), data: &data, accounts: &metas };
        invoke_signed(
            &ix,
            &[
                self.pool,
                self.user,
                self.global_config,
                self.base_mint,
                self.quote_mint,
                self.user_base,
                self.user_quote,
                self.pool_base,
                self.pool_quote,
                self.base_token_program,
                self.quote_token_program,
                self.system,
                self.user_volume_accumulator,
                self.fee_config,
                self.buyback_fee_recipient,
                self.event_authority,
                self.program,
            ],
            signers,
        )
    }
}

/// SPL stake pool `DepositSol` (index 14): moves `lamports` from the system-owned `funding` signer
/// into the reserve and mints pool tokens to `destination` (fees to `manager_fee`, referral share to
/// `referral`). Account order as on live SzoSo… deposits.
pub struct StakePoolDepositSol<'a> {
    pub program: &'a AccountView,
    pub stake_pool: &'a AccountView,
    pub withdraw_authority: &'a AccountView,
    pub reserve_stake: &'a AccountView,
    pub funding: &'a AccountView,
    pub destination: &'a AccountView,
    pub manager_fee: &'a AccountView,
    pub referral: &'a AccountView,
    pub pool_mint: &'a AccountView,
    pub system: &'a AccountView,
    pub token_program: &'a AccountView,
}

impl StakePoolDepositSol<'_> {
    pub fn invoke(&self, lamports: u64, signers: &[Signer]) -> ProgramResult {
        let data = amount_ix(crate::consts::SP_DEPOSIT_SOL, lamports);
        let metas = [
            InstructionAccount::writable(self.stake_pool.address()),
            InstructionAccount::readonly(self.withdraw_authority.address()),
            InstructionAccount::writable(self.reserve_stake.address()),
            InstructionAccount::writable_signer(self.funding.address()),
            InstructionAccount::writable(self.destination.address()),
            InstructionAccount::writable(self.manager_fee.address()),
            InstructionAccount::writable(self.referral.address()),
            InstructionAccount::writable(self.pool_mint.address()),
            InstructionAccount::readonly(self.system.address()),
            InstructionAccount::readonly(self.token_program.address()),
        ];
        let ix = InstructionView { program_id: self.program.address(), data: &data, accounts: &metas };
        invoke_signed(
            &ix,
            &[
                self.stake_pool,
                self.withdraw_authority,
                self.reserve_stake,
                self.funding,
                self.destination,
                self.manager_fee,
                self.referral,
                self.pool_mint,
                self.system,
                self.token_program,
            ],
            signers,
        )
    }
}

/// Approve (4): source(w), delegate(r), owner(s)
pub fn approve(
    program: &AccountView,
    source: &AccountView,
    delegate: &AccountView,
    owner: &AccountView,
    amount: u64,
    signers: &[Signer],
) -> ProgramResult {
    let data = amount_ix(4, amount);
    let metas = [
        InstructionAccount::writable(source.address()),
        InstructionAccount::readonly(delegate.address()),
        InstructionAccount::readonly_signer(owner.address()),
    ];
    let ix = InstructionView { program_id: program.address(), data: &data, accounts: &metas };
    invoke_signed(&ix, &[source, delegate, owner], signers)
}

/// Revoke (5): source(w), owner(s)
pub fn revoke(
    program: &AccountView,
    source: &AccountView,
    owner: &AccountView,
    signers: &[Signer],
) -> ProgramResult {
    let data = [5u8];
    let metas = [
        InstructionAccount::writable(source.address()),
        InstructionAccount::readonly_signer(owner.address()),
    ];
    let ix = InstructionView { program_id: program.address(), data: &data, accounts: &metas };
    invoke_signed(&ix, &[source, owner], signers)
}

/// InitializeAccount3 (18): account(w), mint(r); data = owner
pub fn initialize_account3(
    program: &AccountView,
    account: &AccountView,
    mint: &AccountView,
    owner: &Address,
) -> ProgramResult {
    let mut data = [0u8; 33];
    data[0] = 18;
    data[1..].copy_from_slice(owner.as_array());
    let metas = [
        InstructionAccount::writable(account.address()),
        InstructionAccount::readonly(mint.address()),
    ];
    let ix = InstructionView { program_id: program.address(), data: &data, accounts: &metas };
    invoke_signed(&ix, &[account, mint], &[])
}

fn system_ix(
    system: &AccountView,
    data: &[u8],
    a: &AccountView,
    a_signer: bool,
    b: Option<&AccountView>,
    signers: &[Signer],
) -> ProgramResult {
    match b {
        Some(b) => {
            let metas = [
                InstructionAccount::new(a.address(), true, a_signer),
                InstructionAccount::new(b.address(), true, true),
            ];
            let ix = InstructionView { program_id: system.address(), data, accounts: &metas };
            invoke_signed(&ix, &[a, b], signers)
        }
        None => {
            let metas = [InstructionAccount::new(a.address(), true, a_signer)];
            let ix = InstructionView { program_id: system.address(), data, accounts: &metas };
            invoke_signed(&ix, &[a], signers)
        }
    }
}

/// Creates a PDA account even if someone pre-funded its address (transfer + allocate + assign).
pub fn create_pda_account(
    system: &AccountView,
    payer: &AccountView,
    target: &AccountView,
    space: u64,
    owner: &Address,
    rent_lamports: u64,
    target_signer: &[Signer],
) -> ProgramResult {
    let current = target.lamports();
    if current == 0 {
        let mut d = [0u8; 52];
        d[4..12].copy_from_slice(&rent_lamports.to_le_bytes());
        d[12..20].copy_from_slice(&space.to_le_bytes());
        d[20..52].copy_from_slice(owner.as_array());
        // CreateAccount: from(ws), to(ws)
        let metas = [
            InstructionAccount::writable_signer(payer.address()),
            InstructionAccount::writable_signer(target.address()),
        ];
        let ix = InstructionView { program_id: system.address(), data: &d, accounts: &metas };
        return invoke_signed(&ix, &[payer, target], target_signer);
    }
    if current < rent_lamports {
        let mut d = [0u8; 12];
        d[0] = 2;
        d[4..12].copy_from_slice(&(rent_lamports - current).to_le_bytes());
        // Transfer: from(ws), to(w)
        let metas = [
            InstructionAccount::writable_signer(payer.address()),
            InstructionAccount::writable(target.address()),
        ];
        let ix = InstructionView { program_id: system.address(), data: &d, accounts: &metas };
        invoke_signed(&ix, &[payer, target], &[])?;
    }
    let mut alloc = [0u8; 12];
    alloc[0] = 8;
    alloc[4..12].copy_from_slice(&space.to_le_bytes());
    system_ix(system, &alloc, target, true, None, target_signer)?;
    let mut assign = [0u8; 36];
    assign[0] = 1;
    assign[4..36].copy_from_slice(owner.as_array());
    system_ix(system, &assign, target, true, None, target_signer)
}

/// DBC claim_trading_fee2 as the partner fee claimer, quote side only (max_amount_a = 0 means
/// no base transfer, so Token-2022 and the hook are never entered).
pub struct DbcClaim<'a> {
    pub dbc: &'a AccountView,
    pub pool_authority: &'a AccountView,
    pub config: &'a AccountView,
    pub pool: &'a AccountView,
    pub token_a_account: &'a AccountView,
    pub token_b_account: &'a AccountView,
    pub base_vault: &'a AccountView,
    pub quote_vault: &'a AccountView,
    pub base_mint: &'a AccountView,
    pub quote_mint: &'a AccountView,
    pub fee_claimer: &'a AccountView,
    pub token_base_program: &'a AccountView,
    pub token_quote_program: &'a AccountView,
    pub event_authority: &'a AccountView,
}

impl DbcClaim<'_> {
    pub fn invoke(&self, signers: &[Signer]) -> ProgramResult {
        let mut data = [0u8; 8 + 8 + 8 + 4];
        data[..8].copy_from_slice(&crate::consts::DBC_CLAIM_FEE2_DISC);
        // max_amount_a = 0
        data[16..24].copy_from_slice(&u64::MAX.to_le_bytes());
        // TransferHookAccountsInfo { slices: vec![] } -> u32 len 0
        let metas = [
            InstructionAccount::readonly(self.pool_authority.address()),
            InstructionAccount::readonly(self.config.address()),
            InstructionAccount::writable(self.pool.address()),
            InstructionAccount::writable(self.token_a_account.address()),
            InstructionAccount::writable(self.token_b_account.address()),
            InstructionAccount::writable(self.base_vault.address()),
            InstructionAccount::writable(self.quote_vault.address()),
            InstructionAccount::readonly(self.base_mint.address()),
            InstructionAccount::readonly(self.quote_mint.address()),
            InstructionAccount::readonly_signer(self.fee_claimer.address()),
            InstructionAccount::readonly(self.token_base_program.address()),
            InstructionAccount::readonly(self.token_quote_program.address()),
            InstructionAccount::readonly(self.event_authority.address()),
            InstructionAccount::readonly(self.dbc.address()),
        ];
        let ix = InstructionView { program_id: self.dbc.address(), data: &data, accounts: &metas };
        invoke_signed(
            &ix,
            &[
                self.pool_authority,
                self.config,
                self.pool,
                self.token_a_account,
                self.token_b_account,
                self.base_vault,
                self.quote_vault,
                self.base_mint,
                self.quote_mint,
                self.fee_claimer,
                self.token_base_program,
                self.token_quote_program,
                self.event_authority,
                self.dbc,
            ],
            signers,
        )
    }
}
