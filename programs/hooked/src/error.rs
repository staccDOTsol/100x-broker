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
    /// register_launch/boost: the Launch account is not the PDA for (market, side), or its stored
    /// market/side disagree with the accounts passed.
    InvalidLaunch,
    /// register_launch: a Launch already exists for this (market, side).
    LaunchExists,
    /// register_launch: the pump BondingCurve is not owned by pump, has the wrong discriminator/length,
    /// or is not quoted in MEME_MINT.
    InvalidLaunchCurve,
    /// register_launch: `BondingCurve.creator` is neither the signer nor the coin's SharingConfig PDA.
    InvalidLaunchCreator,
    /// register_launch: the SharingConfig is malformed, not final, or its shareholders do not match `mode`.
    InvalidSharingConfig,
    /// boost: a token account passed is not (mint, owner) the instruction requires.
    InvalidLaunchTokenAccount,
}

impl From<HookedError> for ProgramError {
    fn from(e: HookedError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
