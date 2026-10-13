use pinocchio::error::ProgramError;

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaultError {
    InvalidVault = 0,
    InvalidMarket,
    InvalidPool,
    InvalidAccount,
    InvalidProgram,
    MissingSigner,
    ZeroAmount,
    MathOverflow,
    NotAllowlisted,
    SettleMissing,
    NoSnapshot,
    SnapshotActive,
    ValueLeaked,
    HedgeWorse,
    PriceSanity,
    PositionMismatch,
    NoShares,
    InvalidTick,
}

impl From<VaultError> for ProgramError {
    fn from(e: VaultError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
