//! dnvault — delta-neutral vaults on top of 100x.broker: LP the underlying against SOL on its Raydium
//! CLMM pool, hedge the X leg with a bucket of −100× DOWN tokens sized to X-exposure / 100, and keep
//! whatever the pool fees pay. Custody + valuation live here; a keeper proposes rebalances as
//! allowlisted CPIs and the program verifies no value leaked and the hedge got no worse.
#![cfg_attr(target_os = "solana", no_std)]

pub mod consts;
pub mod cpi;
pub mod error;
pub mod math;
pub mod processor;
pub mod state;
pub mod value;

#[cfg(target_os = "solana")]
mod entry {
    use pinocchio::{no_allocator, nostd_panic_handler, program_entrypoint};
    program_entrypoint!(crate::processor::process_instruction);
    no_allocator!();
    nostd_panic_handler!();
}
