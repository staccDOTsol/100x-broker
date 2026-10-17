use pinocchio::Address;

pub const TOKENKEG: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
pub const DBC: Address = Address::from_str_const("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/// Every market is quoted in r-freestacc (SPL Token, so the hook can move it).
pub const QUOTE_MINT: Address = Address::from_str_const("pSYRpDqr847kB2nD5ZhjcPsHLV2ZpUxweXm1MwiSTcc");
pub const RAYDIUM_CLMM: Address = Address::from_str_const("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
pub const RAYDIUM_CPMM: Address = Address::from_str_const("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
pub const METEORA_DAMM_V2: Address = Address::from_str_const("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const METEORA_DLMM: Address = Address::from_str_const("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
pub const USDC: Address = Address::from_str_const("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
pub const USDT: Address = Address::from_str_const("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");

/// `Market.oracle_kind`: which venue the two oracle slots (`oracle_obs`, `oracle_pool`) point at.
/// 0 is the pre-existing Raydium CLMM observation ring; every market created before kinds existed is 0.
pub const KIND_RAYDIUM_CLMM: u8 = 0;
/// oracle_obs = pool.pool_base_token_account, oracle_pool = pool.pool_quote_token_account (token0 = base).
pub const KIND_PUMPSWAP: u8 = 1;
/// oracle_obs = token_0_vault, oracle_pool = token_1_vault.
pub const KIND_RAYDIUM_CPMM: u8 = 2;
/// both slots = the DAMM v2 Pool (token0 = token_a, price from sqrt_price).
pub const KIND_METEORA_DAMM_V2: u8 = 3;
/// both slots = the LbPair (token0 = token_x, price from active_id / bin_step).
pub const KIND_METEORA_DLMM: u8 = 4;
pub const KIND_MAX: u8 = 4;

/// Power leverage applied to every rebalance. Fixed for all markets.
pub const LEVERAGE: u128 = 100;
/// Fee taken on redemption, stays in the vaults (see FUNDING_SHARE_BPS).
pub const REDEEM_FEE_BPS: u128 = 400;
/// Share of the mechanism's cut of every fee sent to the smaller vault.
pub const FUNDING_SHARE_BPS: u128 = 9_000;
pub const BPS: u128 = 10_000;

/// Every fee the program collects (swept DBC trading fees, redemption fee) splits three ways.
pub const MECH_BPS: u128 = 6_000;
pub const BURN_BPS: u128 = 3_000;
pub const DEV_BPS: u128 = 1_000;
/// r-freestacc account of the dev wallet 331nEB… (ATA, must exist).
pub const DEV_ATA: Address = Address::from_str_const("6Jrrws5TmFTb4eCa63A4yNnaSCC62yvvHYspK3KW4SEd");
/// The memecoin the burn pot buys. Baked at build time: HOOKED_MEME_MINT=<CA> cargo build-sbf. Unset = burns disabled.
pub const MEME_MINT: Address = Address::from_str_const(match option_env!("HOOKED_MEME_MINT") {
    Some(s) => s,
    None => "11111111111111111111111111111111",
});
pub const PUMP: Address = Address::from_str_const("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const PUMPSWAP: Address = Address::from_str_const("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
/// Pump Fees program: owns `SharingConfig` (creator-fee split) and `fee_config`.
pub const PUMP_FEES: Address = Address::from_str_const("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
pub const WSOL: Address = Address::from_str_const("So11111111111111111111111111111111111111112");
/// r-freestacc's Sanctum stake pool: rate = total_lamports / pool_token_supply.
pub const STAKE_POOL: Address = Address::from_str_const("SzoSoRxsrL9sbFcwpbjbH5bRrzuvFtuytZTeuqZCfQ6");
/// Sanctum's SPL-stake-pool fork that owns STAKE_POOL (same instruction set/indices as SPL stake pool).
pub const STAKE_POOL_PROGRAM: Address = Address::from_str_const("SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY");
/// SPL stake pool `DepositSol` (verified on live SzoSo… txs: tag 14, 9 data bytes, 10 accounts).
pub const SP_DEPOSIT_SOL: u8 = 14;
/// StakePool: account_type u8, 3 pubkeys, withdraw bump, validator_list, then these.
pub const SP_RESERVE_STAKE: usize = 130;
pub const SP_POOL_MINT: usize = 162;
pub const SP_MANAGER_FEE: usize = 194;
pub const SP_TOTAL_LAMPORTS: usize = 258;
pub const SP_POOL_TOKEN_SUPPLY: usize = 266;
/// Bounty paid over the venue's own sell quote to whoever brings MEME to burn.
pub const BURN_BONUS_BPS: u128 = 300;
/// One burn call may spend at most this share of the pot; calls are rate limited.
pub const MAX_BURN_SHARE_BPS: u128 = 500;
pub const BURN_COOLDOWN_SECS: i64 = 60;
pub const PUMP_FEE_BPS: u128 = 100;
pub const PUMPSWAP_FEE_BPS: u128 = 30;
// pump.fun BondingCurve (pump-public-docs idl/pump.json, Anchor/Borsh; verified on the live SOL-quoted
// $100XBRO curve Fq52En… and the pump-coin-quoted curve 1ELNXj…, both 166 bytes):
// disc 8 | virtual_token_reserves u64 | virtual_quote_reserves u64 | real_token_reserves | real_quote_reserves |
// token_total_supply | complete bool | creator 32 | is_mayhem_mode bool | is_cashback_coin bool |
// quote_mint 32 (all-zero = SOL) | creator_fee_bps u64 | can_edit_creator_fee bool | is_holder_reward bool |
// creator_fee u64 | protocol_fees u64 | depth u8 | initial_virtual_quote_reserves u64 |
// post_complete_base_out u64 | post_complete_quote_in u64
pub const BC_DISC: [u8; 8] = [23, 183, 248, 55, 96, 216, 172, 96];
pub const BC_VIRTUAL_TOKEN: usize = 8;
pub const BC_VIRTUAL_SOL: usize = 16;
pub const BC_COMPLETE: usize = 48;
pub const BC_CREATOR: usize = 49;
pub const BC_QUOTE_MINT: usize = 83;
pub const BC_CREATOR_FEE_BPS: usize = 115;
pub const BC_DEPTH: usize = 141;
/// Full create_v2-era layout; every coin paired with a pump coin is at least this long.
pub const BC_LEN_V2: usize = 166;

// Pump Fees SharingConfig (idl/pump_fees.json; verified on live 11FDP3Dj…, 1024 bytes):
// disc 8 | bump u8 | version u8 | status u8 (1 = Active) | mint 32 | admin 32 | admin_revoked bool |
// shareholders Vec<{address 32, share_bps u16}> (u32 len prefix)
pub const SC_DISC: [u8; 8] = [216, 74, 9, 0, 56, 140, 93, 75];
pub const SC_STATUS: usize = 10;
pub const SC_MINT: usize = 11;
pub const SC_ADMIN: usize = 43;
pub const SC_ADMIN_REVOKED: usize = 75;
pub const SC_SHAREHOLDERS_LEN: usize = 76;
pub const SC_SHAREHOLDERS: usize = 80;
pub const SC_SHAREHOLDER_SIZE: usize = 34;
pub const SC_MAX_SHAREHOLDERS: usize = 10;

/// PumpSwap `sell_v2` (idl/pump_amm.json): 17 accounts, data = disc | base_amount_in u64 | min_quote_amount_out u64.
pub const PS_SELL_V2_DISC: [u8; 8] = [93, 246, 130, 60, 231, 233, 64, 178];
/// `init_user_volume_accumulator` (same IDL). Payer creates ["user_volume_accumulator", user].
pub const PS_INIT_USER_VOLUME_DISC: [u8; 8] = [94, 6, 202, 115, 255, 96, 232, 183];
/// Second seed of PumpSwap `sell_v2`'s `fee_config` PDA, under PUMP_FEES.
pub const PS_FEE_CONFIG_SEED: [u8; 32] = [
    12, 20, 222, 252, 130, 94, 198, 118, 148, 37, 8, 24, 187, 101, 64, 101, 244, 41, 141, 49, 86, 213, 113, 180, 212, 248, 9, 12, 24, 233, 168, 99,
];

/// `Launch.mode`: the Launch PDA is a 9_000 bps shareholder next to the lister's 1_000 bps, so boost burns
/// 1/9 and sells 8/9 of what it holds (net 10 % lister / 10 % burn / 80 % vault).
pub const LAUNCH_MODE_SHARED: u8 = 0;
/// `Launch.mode`: the Launch PDA receives 100 %; boost pays the lister 10 %, burns 10 %, sells 80 %.
pub const LAUNCH_MODE_FULL: u8 = 1;
/// Lister's share of creator fees (bps) in either mode.
pub const LAUNCH_LISTER_BPS: u16 = 1_000;
/// boost is a no-op below this many MEME base units (griefing floor).
pub const BOOST_DUST: u64 = 1_000;
pub const LAUNCH_SEED: &[u8; 6] = b"launch";
pub const LAUNCH_SOL_SEED: &[u8; 10] = b"launch-sol";
// PumpSwap Pool: disc 8 | bump 1 | index u16 | creator 32 | base_mint | quote_mint | lp_mint | base_ata | quote_ata | ...
pub const PS_CREATOR: usize = 11;
pub const PS_BASE_MINT: usize = 43;
pub const PS_QUOTE_MINT: usize = 75;
pub const PS_BASE_ATA: usize = 139;
pub const PS_QUOTE_ATA: usize = 171;
/// Anchor `account:Pool` (shared by PumpSwap and Meteora DAMM v2; the owner check tells them apart).
pub const PS_POOL_DISC: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
/// Through `lp_supply`; live pools are 211..=301 bytes depending on when the program last wrote them.
pub const PS_POOL_MIN_LEN: usize = 211;
/// `virtual_quote_reserves` i128: boost liquidity PumpSwap adds to the quote vault when pricing
/// (`price = (quote_vault + virtual_quote_reserves) / base_vault`). Absent (= 0) on accounts shorter
/// than PS_VIRTUAL_QUOTE + 16 that the program wrote before the field existed.
pub const PS_VIRTUAL_QUOTE: usize = 245;

// Raydium CP-Swap PoolState (raydium-cp-swap programs/cp-swap/src/states/pool.rs, LEN = 637):
// disc 8 | amm_config | pool_creator | token_0_vault | token_1_vault | lp_mint | token_0_mint | token_1_mint | ...
pub const CP_POOL_DISC: [u8; 8] = [247, 237, 227, 245, 215, 195, 222, 70];
pub const CP_POOL_LEN: usize = 637;
pub const CP_TOKEN_0_VAULT: usize = 72;
pub const CP_TOKEN_1_VAULT: usize = 104;
pub const CP_TOKEN_0_MINT: usize = 168;
pub const CP_TOKEN_1_MINT: usize = 200;

// Meteora DAMM v2 Pool (damm-v2 programs/cp-amm/src/state/pool.rs, 1112 bytes):
// disc 8 | pool_fees 160 | token_a_mint | token_b_mint | token_a_vault | token_b_vault | whitelisted_vault | padding 32 |
// liquidity u128 | padding u128 | protocol_a_fee | protocol_b_fee | dead_liquidity_fee_checkpoint | padding 8 |
// sqrt_min_price u128 | sqrt_max_price u128 | sqrt_price u128 (Q64.64, sqrt(token_b per token_a)) | ...
pub const DAMM_POOL_DISC: [u8; 8] = PS_POOL_DISC;
pub const DAMM_POOL_LEN: usize = 1112;
pub const DAMM_TOKEN_A_MINT: usize = 168;
pub const DAMM_TOKEN_B_MINT: usize = 200;
pub const DAMM_SQRT_PRICE: usize = 456;

// Meteora DLMM LbPair (dlmm-sdk idls/dlmm.json v0.12.0, 904 bytes):
// disc 8 | StaticParameters 32 | VariableParameters 32 | bump_seed 1 | bin_step_seed 2 | pair_type 1 | active_id i32 |
// bin_step u16 | status 1 | require_base_factor_seed 1 | base_factor_seed 2 | activation_type 1 |
// creator_pool_on_off_control 1 | token_x_mint | token_y_mint | reserve_x | reserve_y | ...
pub const DLMM_PAIR_DISC: [u8; 8] = [33, 11, 49, 98, 181, 101, 177, 13];
pub const DLMM_PAIR_LEN: usize = 904;
pub const DLMM_ACTIVE_ID: usize = 76;
pub const DLMM_BIN_STEP: usize = 80;
pub const DLMM_TOKEN_X_MINT: usize = 88;
pub const DLMM_TOKEN_Y_MINT: usize = 120;
/// SPL token account `amount` (same offset under Tokenkeg and Token-2022).
pub const TOKEN_AMOUNT: usize = 64;
pub const BURN_SEED: &[u8; 4] = b"burn";
pub const BURN_STATE_SEED: &[u8; 10] = b"burn-state";

/// Own TWAP checkpoints extend the Raydium ring (100 obs) so the window can exceed its span.
pub const CKPT_COUNT: usize = 32;
pub const CKPT_SPACING_SECS: u32 = 150;

// Instruction tags (first byte). The transfer-hook Execute uses its 8-byte interface discriminator.
pub const EXECUTE_DISC: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];
pub const TAG_CREATE_MARKET: u8 = 0;
pub const TAG_POKE: u8 = 1;
pub const TAG_REDEEM: u8 = 2;
pub const TAG_SETTLE_BEGIN: u8 = 3;
pub const TAG_SETTLE_END: u8 = 4;
pub const TAG_CLAIM_FEES: u8 = 5;
pub const TAG_INIT_BURN: u8 = 6;
pub const TAG_BURN_MEME: u8 = 7;
pub const TAG_REGISTER_LAUNCH: u8 = 8;
pub const TAG_BOOST: u8 = 9;

// Meteora DBC (v0.2.1)
pub const DBC_SWAP2_HOOK_DISC: [u8; 8] = [183, 93, 153, 40, 24, 230, 194, 151];
pub const DBC_CLAIM_FEE2_DISC: [u8; 8] = [84, 191, 71, 50, 9, 162, 55, 193];
/// Hook pools are `TransferHookPool` accounts (same PoolState layout as VirtualPool).
pub const DBC_POOL_DISC: [u8; 8] = [237, 219, 184, 23, 42, 189, 169, 35];
pub const DBC_POOL_LEN: usize = 424;
pub const DBC_POOL_BASE_MINT: usize = 136;
pub const DBC_POOL_BASE_VAULT: usize = 168;
pub const DBC_POOL_QUOTE_VAULT: usize = 200;
pub const DBC_POOL_SQRT_PRICE: usize = 280;

// Raydium CLMM ObservationState (packed): disc 8 | initialized 1 | recent_epoch 8 | index u16 | pool 32 | [Observation; 100]
// Observation: block_timestamp u32 | tick_cumulative i64 | padding [u64; 4]
pub const RAY_OBS_DISC: [u8; 8] = [122, 174, 197, 53, 129, 9, 165, 132];
pub const RAY_OBS_INDEX: usize = 17;
pub const RAY_OBS_POOL: usize = 19;
pub const RAY_OBS_RING: usize = 51;
pub const RAY_OBS_SIZE: usize = 44;
pub const RAY_OBS_NUM: usize = 100;

// Token layouts (Tokenkeg and Token-2022 share the base layout)
pub const TOKEN_ACCOUNT_LEN: usize = 165;
pub const MINT_SUPPLY: usize = 36;
pub const T22_ACCOUNT_TYPE: usize = 165;
pub const T22_TLV_START: usize = 166;
pub const T22_EXT_TRANSFER_HOOK: u16 = 14;

pub const MARKET_SEED: &[u8; 6] = b"market";
pub const VAULT_SEED: &[u8; 5] = b"vault";
pub const META_SEED: &[u8; 19] = b"extra-account-metas";

/// ExtraAccountMetaList for Execute: market(w), observation(r), vault_bull(w), vault_bear(w), token program(r),
/// oracle pool(r). Markets created before the pool was added have 5 entries; the hook treats the pool as optional.
/// Kind-1 (PumpSwap) markets have a 7th entry: the PumpSwap `Pool`, read for `virtual_quote_reserves`.
pub const EXTRA_METAS: usize = 6;
pub const EXTRA_METAS_PUMPSWAP: usize = 7;
pub const fn meta_list_len(extras: usize) -> usize {
    8 + 4 + 4 + 35 * extras
}
/// A ring that has not recorded anything for this long is treated as dead (some Raydium pools never advance
/// theirs); the market then samples the pool's own tick on every rebalance and builds its TWAP from that.
pub const RING_STALE_SECS: u32 = 3600;
pub const RAY_POOL_TICK_CURRENT: usize = 269;
