use {
    crate::{consts::VAULT_SEED, error::VaultError},
    pinocchio::{
        cpi::{Seed, Signer},
        error::ProgramError,
        Address,
    },
};

pub const VAULT_DISC: [u8; 8] = *b"dnvault1";

/// One delta-neutral vault = one 100x market + one CLMM range. PDA seeds:
/// ["vault", market, tick_lower (le i32), tick_upper (le i32)]
#[repr(C)]
pub struct Vault {
    pub disc: [u8; 8],
    pub market: Address,
    pub pool: Address,
    pub x_mint: Address,
    pub down_mint: Address,
    pub share_mint: Address,
    /// Pinned token accounts (the vault's ATAs); valuation only ever reads these.
    pub wsol_ata: Address,
    pub x_ata: Address,
    pub quote_ata: Address,
    pub down_ata: Address,
    /// Raydium personal position + its NFT mint, or all-zero while the vault has no position.
    pub position: Address,
    pub position_nft: Address,
    pub creator: Address,
    /// System-owned sub-account holding the vault's SOL; seeds ["sol", vault].
    pub sol_pda: Address,
    /// Snapshot taken by the first `act` of a transaction, verified by `settle`.
    pub snap_nav: u64,
    pub snap_err_bps: u64,
    pub snap_slot: u64,
    /// DOWN pot share and uncollected position fees (lamports) at the snapshot: what the keeper gets paid on.
    pub snap_d: u64,
    pub snap_fees: u64,
    pub tick_lower: i32,
    pub tick_upper: i32,
    /// Hedge tolerance: settle passes when |D - D*| <= band * D*.
    pub band_bps: u16,
    /// Largest NAV drop one rebalance transaction may cause (fees, spot-vs-TWAP).
    pub max_loss_bps: u16,
    /// Keeper bounty: this share of |ΔD| + harvested fees, paid in SOL to whoever settles.
    pub keeper_bps: u16,
    pub bump: u8,
    pub x_is_token0: u8,
    pub snap_active: u8,
    pub sol_bump: u8,
    /// 1 when the underlying is a Token-2022 mint (its ATA and transfers go through Token-2022).
    pub x_is_t22: u8,
    pub _pad: [u8; 5],
}

impl Vault {
    pub const LEN: usize = core::mem::size_of::<Vault>();

    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Vault, ProgramError> {
        if data.len() != Self::LEN || data[..8] != VAULT_DISC {
            return Err(VaultError::InvalidVault.into());
        }
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Vault) })
    }

    pub fn from_bytes(data: &[u8]) -> Result<&Vault, ProgramError> {
        if data.len() != Self::LEN || data[..8] != VAULT_DISC {
            return Err(VaultError::InvalidVault.into());
        }
        Ok(unsafe { &*(data.as_ptr() as *const Vault) })
    }

    pub fn has_position(&self) -> bool {
        self.position != Address::default()
    }

    pub fn seeds(&self) -> VaultSeeds {
        VaultSeeds {
            market: self.market.to_bytes(),
            lower: self.tick_lower.to_le_bytes(),
            upper: self.tick_upper.to_le_bytes(),
            bump: [self.bump],
        }
    }

    pub fn sol_seeds(&self, vault: &Address) -> SolSeeds {
        SolSeeds { vault: vault.to_bytes(), bump: [self.sol_bump] }
    }
}

pub struct SolSeeds {
    pub vault: [u8; 32],
    pub bump: [u8; 1],
}

impl SolSeeds {
    pub fn seeds(&self) -> [Seed<'_>; 3] {
        [Seed::from(crate::consts::SOL_SEED.as_slice()), Seed::from(self.vault.as_slice()), Seed::from(self.bump.as_slice())]
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn layout() {
        assert_eq!(super::Vault::LEN, 488);
    }
}

pub struct VaultSeeds {
    pub market: [u8; 32],
    pub lower: [u8; 4],
    pub upper: [u8; 4],
    pub bump: [u8; 1],
}

impl VaultSeeds {
    pub fn seeds(&self) -> [Seed<'_>; 5] {
        [
            Seed::from(VAULT_SEED.as_slice()),
            Seed::from(self.market.as_slice()),
            Seed::from(self.lower.as_slice()),
            Seed::from(self.upper.as_slice()),
            Seed::from(self.bump.as_slice()),
        ]
    }
}

pub fn signer<'a>(seeds: &'a [Seed<'a>]) -> Signer<'a, 'a> {
    Signer::from(seeds)
}
