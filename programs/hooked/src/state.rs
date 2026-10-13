use {
    crate::{
        consts::{CKPT_COUNT, CKPT_SPACING_SECS, MARKET_SEED},
        error::HookedError,
    },
    pinocchio::{
        cpi::{Seed, Signer},
        error::ProgramError,
        AccountView, Address,
    },
};

pub const MARKET_DISC: [u8; 8] = *b"hookmkt1";
pub const SIDE_BULL: u8 = 0;
pub const SIDE_BEAR: u8 = 1;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Ckpt {
    pub ts: u32,
    pub _pad: u32,
    pub tick_cumulative: i64,
}

/// One ±LEVERAGE pair on one underlying. PDA seeds:
/// ["market", bull_mint, bear_mint, oracle_obs, window_secs(le u32) ++ underlying_is_token0(u8)]
#[repr(C)]
pub struct Market {
    pub disc: [u8; 8],
    pub bull_mint: Address,
    pub bear_mint: Address,
    pub quote_mint: Address,
    pub oracle_pool: Address,
    pub oracle_obs: Address,
    pub vault_bull: Address,
    pub vault_bear: Address,
    pub pool_bull: Address,
    pub pool_bear: Address,
    pub base_vault_bull: Address,
    pub base_vault_bear: Address,
    pub escrow_bull: Address,
    pub escrow_bear: Address,
    /// TWAP tick (Raydium tick, token1 per token0) in Q32 at the last rebalance.
    pub last_twap_q32: i64,
    /// Price fraction each side's curve still owes to settle (Q63; 1.0 = nothing owed).
    pub keep_bull_q63: u64,
    pub keep_bear_q63: u64,
    pub settle_target_sqrt: [u8; 16],
    pub settle_vault_pre: u64,
    pub settle_amount: u64,
    pub window_secs: u32,
    pub last_obs_ts: u32,
    pub bump: u8,
    pub underlying_is_token0: u8,
    pub settling: u8,
    pub settle_side: u8,
    pub ckpt_head: u8,
    /// consts::KIND_*; was the first padding byte, so every pre-existing market reads 0 = Raydium CLMM.
    pub oracle_kind: u8,
    pub _pad: [u8; 2],
    pub ckpts: [Ckpt; CKPT_COUNT],
}

impl Market {
    pub const LEN: usize = core::mem::size_of::<Market>();
    /// Byte offset of `oracle_kind` (pinned so the layout cannot drift under existing accounts).
    pub const ORACLE_KIND_OFFSET: usize = 493;

    /// # Safety
    /// Caller holds a mutable borrow of `data` for the lifetime of the reference.
    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut Market, ProgramError> {
        if data.len() != Self::LEN || data[..8] != MARKET_DISC {
            return Err(HookedError::InvalidMarket.into());
        }
        // Account data is 8-byte aligned by the runtime; Market has align 8.
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut Market) })
    }

    pub fn from_bytes(data: &[u8]) -> Result<&Market, ProgramError> {
        if data.len() != Self::LEN || data[..8] != MARKET_DISC {
            return Err(HookedError::InvalidMarket.into());
        }
        Ok(unsafe { &*(data.as_ptr() as *const Market) })
    }

    pub fn mint(&self, side: u8) -> &Address {
        if side == SIDE_BULL { &self.bull_mint } else { &self.bear_mint }
    }
    pub fn vault(&self, side: u8) -> &Address {
        if side == SIDE_BULL { &self.vault_bull } else { &self.vault_bear }
    }
    pub fn pool(&self, side: u8) -> &Address {
        if side == SIDE_BULL { &self.pool_bull } else { &self.pool_bear }
    }
    pub fn base_vault(&self, side: u8) -> &Address {
        if side == SIDE_BULL { &self.base_vault_bull } else { &self.base_vault_bear }
    }
    pub fn escrow(&self, side: u8) -> &Address {
        if side == SIDE_BULL { &self.escrow_bull } else { &self.escrow_bear }
    }
    pub fn keep_mut(&mut self, side: u8) -> &mut u64 {
        if side == SIDE_BULL { &mut self.keep_bull_q63 } else { &mut self.keep_bear_q63 }
    }

    pub fn newest_ckpt(&self) -> Ckpt {
        self.ckpts[(self.ckpt_head as usize + CKPT_COUNT - 1) % CKPT_COUNT]
    }

    pub fn push_ckpt(&mut self, ts: u32, tick_cumulative: i64) {
        let newest = self.newest_ckpt();
        if newest.ts != 0 && ts < newest.ts.saturating_add(CKPT_SPACING_SECS) {
            return;
        }
        let i = self.ckpt_head as usize % CKPT_COUNT;
        self.ckpts[i] = Ckpt { ts, _pad: 0, tick_cumulative };
        self.ckpt_head = ((i + 1) % CKPT_COUNT) as u8;
    }

    pub fn seeds(&self) -> MarketSeeds {
        let mut params = [0u8; 5];
        params[..4].copy_from_slice(&self.window_secs.to_le_bytes());
        params[4] = self.underlying_is_token0;
        MarketSeeds {
            bull: self.bull_mint.to_bytes(),
            bear: self.bear_mint.to_bytes(),
            obs: self.oracle_obs.to_bytes(),
            params,
            bump: [self.bump],
        }
    }
}

/// Owned copy of the market PDA seeds so the market account can be released before a CPI.
pub struct MarketSeeds {
    pub bull: [u8; 32],
    pub bear: [u8; 32],
    pub obs: [u8; 32],
    pub params: [u8; 5],
    pub bump: [u8; 1],
}

impl MarketSeeds {
    pub fn seeds(&self) -> [Seed<'_>; 6] {
        [
            Seed::from(MARKET_SEED),
            Seed::from(&self.bull),
            Seed::from(&self.bear),
            Seed::from(&self.obs),
            Seed::from(&self.params),
            Seed::from(&self.bump),
        ]
    }
}

pub fn signer<'a, 'b>(seeds: &'b [Seed<'a>; 6]) -> Signer<'a, 'b> {
    Signer::from(seeds)
}

pub fn token_amount(view: &AccountView) -> Result<u64, ProgramError> {
    let data = view.try_borrow()?;
    token_amount_bytes(&data)
}

pub fn token_amount_bytes(data: &[u8]) -> Result<u64, ProgramError> {
    if data.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

pub fn read_address(data: &[u8], offset: usize) -> Result<&[u8; 32], ProgramError> {
    data.get(offset..offset + 32)
        .and_then(|s| s.try_into().ok())
        .ok_or(ProgramError::InvalidAccountData)
}

pub fn read_u128(data: &[u8], offset: usize) -> Result<u128, ProgramError> {
    data.get(offset..offset + 16)
        .map(|s| u128::from_le_bytes(s.try_into().unwrap()))
        .ok_or(ProgramError::InvalidAccountData)
}

pub const BURN_DISC: [u8; 8] = *b"hookbrn1";

/// Global buy-and-burn pot bookkeeping. PDA ["burn-state"]; the pot itself is the PDA ["burn"] token
/// account owned by this PDA.
#[repr(C)]
pub struct BurnState {
    pub disc: [u8; 8],
    pub bump: u8,
    pub vault_bump: u8,
    pub _pad: [u8; 6],
    pub last_ts: i64,
    pub total_burned: u64,
    pub total_paid: u64,
}

impl BurnState {
    pub const LEN: usize = core::mem::size_of::<BurnState>();
    pub fn from_bytes_mut(data: &mut [u8]) -> Result<&mut BurnState, ProgramError> {
        if data.len() != Self::LEN || data[..8] != BURN_DISC {
            return Err(HookedError::InvalidBurnAccounts.into());
        }
        Ok(unsafe { &mut *(data.as_mut_ptr() as *mut BurnState) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The on-chain markets (e.g. GwzRwcPYSojZiNc4tC4eoLSLD7htk3akWA7qtG68zyHh, 1008 bytes, read
    /// 2026-10-13) were written with the pre-kind layout: three pad bytes at 493..496, all zero.
    /// `oracle_kind` must be exactly the first of them so they all read as kind 0.
    #[test]
    fn market_layout_is_unchanged() {
        assert_eq!(Market::LEN, 1008);
        assert_eq!(core::mem::align_of::<Market>(), 8);
        let m = unsafe { core::mem::zeroed::<Market>() };
        let base = &m as *const Market as usize;
        assert_eq!(&m.oracle_pool as *const Address as usize - base, 104);
        assert_eq!(&m.oracle_obs as *const Address as usize - base, 136);
        assert_eq!(&m.last_twap_q32 as *const i64 as usize - base, 424);
        assert_eq!(&m.window_secs as *const u32 as usize - base, 480);
        assert_eq!(&m.last_obs_ts as *const u32 as usize - base, 484);
        assert_eq!(&m.bump as *const u8 as usize - base, 488);
        assert_eq!(&m.underlying_is_token0 as *const u8 as usize - base, 489);
        assert_eq!(&m.ckpt_head as *const u8 as usize - base, 492);
        assert_eq!(&m.oracle_kind as *const u8 as usize - base, Market::ORACLE_KIND_OFFSET);
        assert_eq!(&m._pad as *const [u8; 2] as usize - base, 494);
        assert_eq!(&m.ckpts as *const _ as usize - base, 496);
    }

    #[test]
    fn zeroed_pad_reads_as_raydium_clmm() {
        let mut bytes = [0u8; Market::LEN];
        bytes[..8].copy_from_slice(&MARKET_DISC);
        let m = Market::from_bytes(&bytes).unwrap();
        assert_eq!(m.oracle_kind, crate::consts::KIND_RAYDIUM_CLMM);
        let mut bytes2 = bytes;
        bytes2[Market::ORACLE_KIND_OFFSET] = 3;
        assert_eq!(Market::from_bytes(&bytes2).unwrap().oracle_kind, 3);
    }
}
