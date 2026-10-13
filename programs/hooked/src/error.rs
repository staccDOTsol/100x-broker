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
}

impl From<HookedError> for ProgramError {
    fn from(e: HookedError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
