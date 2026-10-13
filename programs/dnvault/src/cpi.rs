//! Minimal CPI builders: SPL Token / Token-2022 (shared layouts), System, and generic forwarding.

use pinocchio::{
    cpi::{invoke_signed, invoke_signed_with_bounds, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::{CreateAccount, Transfer};

fn amount_ix(tag: u8, amount: u64) -> [u8; 9] {
    let mut d = [0u8; 9];
    d[0] = tag;
    d[1..].copy_from_slice(&amount.to_le_bytes());
    d
}

/// Transfer (3): source(w), destination(w), authority(s)
pub fn transfer(program: &AccountView, from: &AccountView, to: &AccountView, authority: &AccountView, amount: u64, signers: &[Signer]) -> ProgramResult {
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
pub fn mint_to(program: &AccountView, mint: &AccountView, to: &AccountView, authority: &AccountView, amount: u64, signers: &[Signer]) -> ProgramResult {
    let data = amount_ix(7, amount);
    let metas = [
        InstructionAccount::writable(mint.address()),
        InstructionAccount::writable(to.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    let ix = InstructionView { program_id: program.address(), data: &data, accounts: &metas };
    invoke_signed(&ix, &[mint, to, authority], signers)
}

/// Burn (8): account(w), mint(w), owner(s) — owner signed the outer transaction.
pub fn burn(program: &AccountView, account: &AccountView, mint: &AccountView, owner: &AccountView, amount: u64) -> ProgramResult {
    let data = amount_ix(8, amount);
    let metas = [
        InstructionAccount::writable(account.address()),
        InstructionAccount::writable(mint.address()),
        InstructionAccount::readonly_signer(owner.address()),
    ];
    let ix = InstructionView { program_id: program.address(), data: &data, accounts: &metas };
    invoke_signed(&ix, &[account, mint, owner], &[])
}

/// SyncNative (17): account(w)
pub fn sync_native(program: &AccountView, account: &AccountView) -> ProgramResult {
    let data = [17u8];
    let metas = [InstructionAccount::writable(account.address())];
    let ix = InstructionView { program_id: program.address(), data: &data, accounts: &metas };
    invoke_signed(&ix, &[account], &[])
}

/// CloseAccount (9): account(w), destination(w), owner(s)
pub fn close_account(program: &AccountView, account: &AccountView, dest: &AccountView, owner: &AccountView, signers: &[Signer]) -> ProgramResult {
    let data = [9u8];
    let metas = [
        InstructionAccount::writable(account.address()),
        InstructionAccount::writable(dest.address()),
        InstructionAccount::readonly_signer(owner.address()),
    ];
    let ix = InstructionView { program_id: program.address(), data: &data, accounts: &metas };
    invoke_signed(&ix, &[account, dest, owner], signers)
}

/// InitializeMint2 (20): mint(w); data = decimals, mint_authority, freeze_authority option (none)
pub fn initialize_mint2(program: &AccountView, mint: &AccountView, authority: &Address, decimals: u8) -> ProgramResult {
    let mut data = [0u8; 35];
    data[0] = 20;
    data[1] = decimals;
    data[2..34].copy_from_slice(authority.as_array());
    data[34] = 0;
    let metas = [InstructionAccount::writable(mint.address())];
    let ix = InstructionView { program_id: program.address(), data: &data, accounts: &metas };
    invoke_signed(&ix, &[mint], &[])
}

/// TransferChecked (12) on a transfer-hook mint: source(w), mint, destination(w), authority(s), then the
/// resolved hook accounts exactly as the client passed them (hook program + extra metas + validation).
pub fn transfer_checked_hooked(
    program: &AccountView,
    from: &AccountView,
    mint: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    extras: &[AccountView],
    amount: u64,
    decimals: u8,
    signers: &[Signer],
) -> ProgramResult {
    const MAX: usize = 24;
    if extras.len() + 4 > MAX {
        return Err(ProgramError::MaxAccountsDataAllocationsExceeded);
    }
    let mut data = [0u8; 10];
    data[0] = 12;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    data[9] = decimals;
    let mut metas: [InstructionAccount; MAX] = core::array::from_fn(|_| InstructionAccount::readonly(from.address()));
    metas[0] = InstructionAccount::writable(from.address());
    metas[1] = InstructionAccount::readonly(mint.address());
    metas[2] = InstructionAccount::writable(to.address());
    metas[3] = InstructionAccount::readonly_signer(authority.address());
    let mut views = [from; MAX];
    views[1] = mint;
    views[2] = to;
    views[3] = authority;
    for (i, e) in extras.iter().enumerate() {
        metas[4 + i] = if e.is_writable() { InstructionAccount::writable(e.address()) } else { InstructionAccount::readonly(e.address()) };
        views[4 + i] = e;
    }
    let n = 4 + extras.len();
    let ix = InstructionView { program_id: program.address(), data: &data, accounts: &metas[..n] };
    invoke_signed_with_bounds::<MAX, _>(&ix, &views[..n], signers)
}

/// Forward an instruction to `program` over a contiguous slice of accounts; `signer_addr` is signed
/// for with `signers`, every other account keeps the privileges it had in the outer transaction.
pub fn forward(program: &AccountView, accounts: &[AccountView], data: &[u8], signer_addr: &Address, signers: &[Signer]) -> ProgramResult {
    const MAX: usize = 48;
    if accounts.len() > MAX || accounts.is_empty() {
        return Err(ProgramError::MaxAccountsDataAllocationsExceeded);
    }
    let mut metas: [InstructionAccount; MAX] = core::array::from_fn(|_| InstructionAccount::readonly(signer_addr));
    for (i, a) in accounts.iter().enumerate() {
        let signer = a.is_signer() || a.address() == signer_addr;
        metas[i] = match (a.is_writable(), signer) {
            (true, true) => InstructionAccount::writable_signer(a.address()),
            (true, false) => InstructionAccount::writable(a.address()),
            (false, true) => InstructionAccount::readonly_signer(a.address()),
            (false, false) => InstructionAccount::readonly(a.address()),
        };
    }
    let ix = InstructionView { program_id: program.address(), data, accounts: &metas[..accounts.len()] };
    invoke_signed_with_bounds::<MAX, _>(&ix, accounts, signers)
}

/// Like `forward`, but two program-derived addresses sign (the vault and its SOL sub-account).
pub fn forward2(program: &AccountView, accounts: &[AccountView], data: &[u8], signer_a: &Address, signer_b: &Address, signers: &[Signer]) -> ProgramResult {
    const MAX: usize = 48;
    if accounts.len() > MAX || accounts.is_empty() {
        return Err(ProgramError::MaxAccountsDataAllocationsExceeded);
    }
    let mut metas: [InstructionAccount; MAX] = core::array::from_fn(|_| InstructionAccount::readonly(signer_a));
    for (i, a) in accounts.iter().enumerate() {
        let signer = a.is_signer() || a.address() == signer_a || a.address() == signer_b;
        metas[i] = match (a.is_writable(), signer) {
            (true, true) => InstructionAccount::writable_signer(a.address()),
            (true, false) => InstructionAccount::writable(a.address()),
            (false, true) => InstructionAccount::readonly_signer(a.address()),
            (false, false) => InstructionAccount::readonly(a.address()),
        };
    }
    let ix = InstructionView { program_id: program.address(), data, accounts: &metas[..accounts.len()] };
    invoke_signed_with_bounds::<MAX, _>(&ix, accounts, signers)
}

pub fn create_pda_account(from: &AccountView, to: &AccountView, lamports: u64, space: usize, owner: &Address, signers: &[Signer]) -> ProgramResult {
    CreateAccount { from, to, lamports, space: space as u64, owner }.invoke_signed(signers)
}

pub fn system_transfer(from: &AccountView, to: &AccountView, lamports: u64) -> ProgramResult {
    Transfer { from, to, lamports }.invoke()
}

pub fn system_transfer_signed(from: &AccountView, to: &AccountView, lamports: u64, signers: &[Signer]) -> ProgramResult {
    Transfer { from, to, lamports }.invoke_signed(signers)
}
