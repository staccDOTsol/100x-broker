use pinocchio::Address;

pub const TOKENKEG: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ATA_PROGRAM: Address = Address::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
pub const RAYDIUM_CLMM: Address = Address::from_str_const("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
pub const DBC: Address = Address::from_str_const("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
pub const HOOKED: Address = Address::from_str_const(match option_env!("HOOKED_PROGRAM_ID") {
    Some(s) => s,
    None => "9g7ovqLM7LVzRN2mZCkeCeAZYafK1twhKzTNcqXtirG6",
});
pub const WSOL: Address = Address::from_str_const("So11111111111111111111111111111111111111112");
/// r-freestacc — every 100x market is quoted in it; valued through its stake pool rate.
pub const QUOTE_MINT: Address = Address::from_str_const("pSYRpDqr847kB2nD5ZhjcPsHLV2ZpUxweXm1MwiSTcc");
pub const STAKE_POOL: Address = Address::from_str_const("SzoSoRxsrL9sbFcwpbjbH5bRrzuvFtuytZTeuqZCfQ6");
pub const STAKE_POOL_PROGRAM: Address = Address::from_str_const("SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY");
pub const SP_TOTAL_LAMPORTS: usize = 258;
pub const SP_POOL_TOKEN_SUPPLY: usize = 266;
/// Stake pool instructions the keeper may forward: SOL -> r-fstacc and back, pinned to the vault's accounts.
pub const SP_DEPOSIT_SOL: u8 = 14;
pub const SP_WITHDRAW_SOL: u8 = 16;

/// The hedge: DOWN pot value targets X-exposure / LEVERAGE (power leverage p = 100 on 100x.broker).
pub const LEVERAGE: u128 = 100;
/// 100x.broker's cash-out fee; DOWN is valued at what the pot would actually pay.
pub const REDEEM_FEE_BPS: u128 = 400;
pub const BPS: u128 = 10_000;
pub const SHARE_DECIMALS: u8 = 9;

// hooked Market layout (programs/hooked/src/state.rs)
pub const MARKET_DISC: [u8; 8] = *b"hookmkt1";
pub const MARKET_LEN: usize = 1008;
pub const MKT_BEAR_MINT: usize = 40;
pub const MKT_ORACLE_POOL: usize = 104;
pub const MKT_VAULT_BEAR: usize = 200;
pub const MKT_POOL_BEAR: usize = 264;
pub const MKT_BASE_VAULT_BEAR: usize = 328;
pub const MKT_LAST_TWAP_Q32: usize = 424;
pub const MKT_UNDERLYING_IS_TOKEN0: usize = 489;
pub const HOOKED_TAG_REDEEM: u8 = 2;

// Raydium CLMM PoolState
pub const POOL_DISC: [u8; 8] = [247, 237, 227, 245, 215, 195, 222, 70];
pub const POOL_MINT0: usize = 73;
pub const POOL_MINT1: usize = 105;
pub const POOL_TICK_SPACING: usize = 235;
pub const POOL_SQRT_PRICE: usize = 253;
pub const POOL_TICK_CURRENT: usize = 269;
// Raydium CLMM PersonalPositionState
pub const POS_DISC: [u8; 8] = [70, 111, 150, 126, 230, 15, 25, 117];
pub const POS_NFT_MINT: usize = 9;
pub const POS_POOL: usize = 41;
pub const POS_TICK_LOWER: usize = 73;
pub const POS_TICK_UPPER: usize = 77;
pub const POS_LIQUIDITY: usize = 81;
pub const POS_FEES_OWED_0: usize = 129;
pub const POS_FEES_OWED_1: usize = 137;
pub const POS_MIN_LEN: usize = 145;

// Raydium CLMM instructions the keeper may forward (anchor sighash of global:<name>)
pub const RAY_OPEN_POSITION_T22: [u8; 8] = [77, 255, 174, 82, 125, 29, 201, 46];
pub const RAY_OPEN_POSITION_V2: [u8; 8] = [77, 184, 74, 214, 112, 86, 241, 199];
pub const RAY_INCREASE_V2: [u8; 8] = [133, 29, 89, 223, 69, 238, 176, 10];
pub const RAY_DECREASE_V2: [u8; 8] = [58, 127, 188, 62, 79, 82, 196, 96];
pub const RAY_SWAP_V2: [u8; 8] = [43, 4, 237, 11, 26, 201, 30, 98];
pub const RAY_CLOSE_POSITION: [u8; 8] = [123, 134, 81, 0, 49, 68, 98, 98];
// Meteora DBC
pub const DBC_SWAP2_HOOK_DISC: [u8; 8] = [183, 93, 153, 40, 24, 230, 194, 151];

// Token layouts (Tokenkeg and Token-2022 share the base layout)
pub const TOKEN_ACCOUNT_LEN: usize = 165;
pub const TOKEN_MINT: usize = 0;
pub const TOKEN_OWNER: usize = 32;
pub const TOKEN_AMOUNT: usize = 64;
pub const MINT_SUPPLY: usize = 36;
pub const MINT_DECIMALS: usize = 44;
pub const MINT_LEN: usize = 82;

pub const VAULT_SEED: &[u8; 5] = b"vault";
pub const SHARES_SEED: &[u8; 6] = b"shares";
/// System-owned, zero-data sub-account that holds the vault's SOL (a program-owned PDA with data can't
/// be debited by the System program, and the stake pool / WSOL paths need real SOL transfers).
pub const SOL_SEED: &[u8; 3] = b"sol";

pub const TAG_CREATE_VAULT: u8 = 0;
pub const TAG_DEPOSIT: u8 = 1;
pub const TAG_WITHDRAW: u8 = 2;
pub const TAG_ACT: u8 = 3;
pub const TAG_SETTLE: u8 = 4;
pub const TAG_WRAP: u8 = 5;
pub const TAG_UNWRAP: u8 = 6;
pub const TAG_BIND_POSITION: u8 = 7;

/// Accounts every valuation reads, in this order, right after the instruction's own accounts:
/// market, market vault_bear, bear mint, DBC base vault (bear), vault DOWN ata, CLMM pool,
/// position (or the vault itself when none), vault WSOL ata, vault X ata, vault quote ata, stake pool, vault SOL pda.
pub const VAL_ACCOUNTS: usize = 12;
