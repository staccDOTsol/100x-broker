use pinocchio::error::ProgramError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum HookedError {
    InvalidInstruction = 0x1000,
    InvalidMarket,
    InvalidOracle,
    OracleWindowEmpty,
    InvalidMint,
    InvalidPool,
    InvalidVault,
    InvalidEscrow,
    InvalidProgram,
    InvalidPda,
    MissingSigner,
    SettleInProgress,
    NotSettling,
    NothingOwed,
    SettleSandwich,
    EscrowNotEmpty,
    Overshoot,
    NoProceeds,
    ZeroAmount,
    ExceedsCirculating,
    MathOverflow,
    MemeNotSet,
    InvalidVenue,
    BurnCooldown,
    BurnTooLarge,
    InvalidBurnAccounts,
    /// create_market: `oracle_kind` byte outside 0..=4.
    InvalidOracleKind,
    /// create_market: the venue pool's mints are not {underlying, WSOL|USDC|USDT}, or the client's
    /// `underlying_is_token0` disagrees with which side the quote mint is on.
    UnderlyingFlagMismatch,
}

impl From<HookedError> for ProgramError {
    fn from(e: HookedError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
