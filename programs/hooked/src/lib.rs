//! hooked — ±100x power-leverage pairs on Meteora DBC transfer-hook curves.
#![cfg_attr(target_os = "solana", no_std)]

pub mod consts;
pub mod cpi;
pub mod error;
pub mod math;
pub mod oracle;
pub mod processor;
pub mod state;
pub mod venue;
#[cfg(test)]
mod venue_fixtures;

#[cfg(target_os = "solana")]
mod entry {
    use pinocchio::{no_allocator, nostd_panic_handler, program_entrypoint};
    program_entrypoint!(crate::processor::process_instruction);
    no_allocator!();
    nostd_panic_handler!();
}
