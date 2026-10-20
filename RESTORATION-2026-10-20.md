# 100x restoration, 20 October 2026

This restores the original r-freestacc UP/DOWN curves, 100× power response, redemption and fee splits, burn bounty, and DN vault implementation. It does not create margin perps, USDC collateral, funding-rate payments, or liquidation engines.

## Deployment identities and artifacts

| Component | Fresh program ID | Binary bytes | SHA-256 |
|---|---|---:|---|
| Hooked | `3ZACDHNMHhuZkPYZQZwyXYoJCxJr8kK8yUzGoqt5FbeH` | 129584 | `9ad9af07c67895e3c92c5d4bda125f5d81acfe1e11a7ea2d58fdfc2e7c18f76f` |
| DN vault | `HQ7oEm6WqZVmA8PSZVXC1mX28Xnbhq3kky4QhFixdNzC` | 90912 | `bce1b1be9ef0c0a7aea210fbbe0f4e48549bdc8980a0ebfad9cc92bec5834ce5` |

Artifacts are in `/Users/stacc/tmp/mainnet-salvage-2026-10-20/hooked-build`. Program keypairs and generated market keys are in the sibling `private` directory with mode 0600. Original files and binaries are preserved in `restore-backups/hooked-core`. The DN binary was compiled with `HOOKED_PROGRAM_ID` set to the fresh Hooked ID; Hooked was compiled with the original `HOOKED_MEME_MINT=Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump`.

The old Hooked and DN programs are closed. Fresh programs cannot sign for the old program's PDAs, restore old UP/DOWN transfer hooks, redeem old vault balances, or seize old DN positions. Old positions remain historical holdings. The fresh market manifest generates new mints and accounts, not migrated claims.

## Account creation recipes

The public manifest is `/Users/stacc/tmp/mainnet-salvage-2026-10-20/hooked-restoration-markets.json`. Refresh it with `RPC=<direct mainnet RPC> bun restoration-market-plan.ts` from `scripts/`. This reads the original oracle pools, preserves generated keys and writes no on-chain state.

For each ready manifest entry, with a funded payer and deployed Hooked program:

```sh
cd /Users/stacc/hooked/scripts
export HOOKED_PROGRAM_ID=3ZACDHNMHhuZkPYZQZwyXYoJCxJr8kK8yUzGoqt5FbeH
export DN_PROGRAM_ID=HQ7oEm6WqZVmA8PSZVXC1mX28Xnbhq3kky4QhFixdNzC
export PAYER=/Users/stacc/hooked.json
# RPC must permit transactions; DAS_RPC must support getAsset.
RPC="$RPC" DAS_RPC="$DAS_RPC" MARKET_KEYS="<entry.keysPath>" \
  ORACLE_POOL="<entry.pool>" UNDERLYING="<entry.underlying>" WINDOW_SECS=1 bun create-market.ts
RPC="$RPC" bun init-burn.ts
```

`create-market.ts` creates the DBC hook config, UP/DOWN pools and mint accounts, escrow ATAs, and Hooked market. It does not make purchases or seed the pots. Generated key files are bound to the fresh program ID, preventing accidental reuse of old mint keys.

For PUMP, WBTC or the USDC/SOL sibling DN accounts, after the corresponding market exists:

```sh
RPC="$RPC" ALT_AUTHORITY=/Users/stacc/hooked/scripts/keeper.json \
  bun dn/create-vault.ts "<entry.market>" 1500 300 100
RPC="$RPC" bun alt-sync.ts
```

This creates DN state, shares, SOL PDA, and token accounts and extends the existing keeper's ALTs. It does not deposit investment capital, make a swap, or open an LP position. DN uses the widest currently initialized tick-array range, so refresh the manifest before creation. The native SOL-underlying market does not fit DN's requirement for a non-SOL underlying paired with SOL. The separate USDC-underlying sibling on that same oracle pool does: it restores the original SOL Yield route and inverse SOL swap quotes. SOL-long selects its DOWN side; SOL-short selects its UP side.

The USDC sibling is market `ApFHjfUBa9c37xMdqVuzA9C97H2z8xDAK5PREN8xfFhC`, underlying `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, oracle pool `3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv`, window 1, underlying-is-token0 0. Its generated keys are `private/hooked-usdc-market-keys.json` under the salvage directory. The created DN uses the live initialized range -22800 through -22021, vault `FtogUnZ12W8rekokHonSDCTjrcwqKnosTUaGs6poMhHu`, shares `aCsjBpACEVYaFECRpHXHGdx6mteD9Y6yjGyx1qzHFVi`. The earlier planned range/address was never created; clients discover the actual vault by market. `ONLY_SYMBOL=USDC` on the plan script refreshes only this entry and preserves existing entries. `restoration-usdc-cost.ts` reads current rent, metadata and ALT capacity without signing: measured incremental market 0.039770760 SOL, DN 0.010860880 SOL and ALT 0.003748880 SOL, totaling 0.054380520 SOL before liquidity. Run `alt-sync.ts` after DN creation to include both sides of the sibling market.

The house 100XBRO CLMM ring was approximately 22 hours stale at preparation. A window-1 market must wait for a real venue observation; do not replace the window with a longer sampled-price window. No mainnet trades are authorized by this runbook to refresh that ring.

## Budget and dependencies

At slot 459317607 the rent sysvar was 5080 lamports per byte with threshold 1. Retained program rent is 0.659998680 SOL for Hooked and 0.463544920 SOL for DN. Temporary deploy buffers are respectively 0.659124920 and 0.462671160 SOL; these are transient working capital, not additional retained rent. Use exact binary lengths as `--max-len` and an explicit local buffer keypair to avoid losing track of interrupted deployment buffers.

Measured account rent for a market is 0.039034720 SOL before the production metadata URI/name expansion. Reserve 0.05 SOL per market including fees. DN state plus four ATAs is 0.010901680 SOL; reserve 0.015 SOL per vault plus ALT extensions. Global burn state and pot cost about 0.002341880 SOL. Reserve 0.05 SOL for a new full ALT or equivalent extensions. Seed capital, trading, and DN deposits are distinct from these account-creation costs; the manifest sets all three to zero.

Existing keeper public key `EGa3ng1xcuB5X9tkK7czYczhD4PpAYAJF52Vo9F2Cn7` had 0.207204180 SOL at preparation. It remains the ALT authority and the RFSTACC dev account's delegate. `scripts/fly.toml` now binds both fresh IDs; deploying that worker remains a separate publishing step.

The live r-freestacc mint remains `pSYRpDqr847kB2nD5ZhjcPsHLV2ZpUxweXm1MwiSTcc`, backed by pool `SzoSoRxsrL9sbFcwpbjbH5bRrzuvFtuytZTeuqZCfQ6`. Preparation found about 260.663 SOL in its reserve, NAV 1.002827586, current epoch accounting, no restricted SOL deposit/withdraw authority, and 0.1% SOL deposit and withdrawal fees. DBC, Raydium CLMM, SP12 stake pool, Pump, PumpSwap and independent War program `Hbu4EByGc17GxHYyiazxDMvtL6VvKxV4aRsZW95uzfu7` were executable. The current app's SOL zap uses SP12 directly and has no reference to the closed LST bridge.

Pump coin launch and War use their existing independent programs. Hooked companion-coin launch/boost instructions remain in the rebuilt binary; old companion launch PDAs cannot become new-program PDAs automatically. They require fresh registration where used.

## Verification

All 31 Hooked and six DN Rust unit tests passed. On a localhost Surfpool fork with fresh program IDs:

- New DBC config and both mints/pools, both hook-mediated buys, exact 100× oracle transfer, no-op repeated poke, four-percent redemption, fee splits, atomic settlement, retained unpaid settlement factor at the DBC floor, and overshoot rejection passed.
- Window-1 stale-ring tests kept the market and both pots unchanged after a synthetic live-tick push.
- DN create, SOL deposit, Raydium swap plus DOWN hedge, LP position, half withdrawal in kind, and subsequent deposit at NAV passed.
- The current graduated 100XBRO PumpSwap venue burn reduced both caller balance and mint supply, paid the exact sell quote plus three percent, enforced cooldown and five-percent cap, and allowed the earned RFSTACC bounty to exit to SOL.

Logs are `hooked-rust-tests.log`, `dnvault-rust-tests.log`, `hooked-e2e-window1.log`, `dnvault-e2e.log` and `hooked-burn-current-e2e.log` under the salvage directory.

The test fork uses synthetic balances and oracle fixture changes. Surfpool 1.0 initially exposed an old rent ABI; its local rent sysvar was set to rate 6960, threshold 1, preserving that fork's rent totals while matching Pinocchio 0.11's ABI. No production math was changed to accommodate the test. The public upstream proxy rejects program-account scans for an undeployed fresh ID and test-wallet ALTs; those discovery checks require the updated production allowlist/direct RPC. Exact account ownership checks passed locally. Production transaction simulation and post-deployment discovery remain separate checks.

The keeper's stale-ring preview now matches the program's existing window-under-150 rule. Sampled windows of at least 150 seconds retain their prior implementation. CPMM/DLMM accumulator support discussed in `programs/hooked/TWAP-2OBS.md` is still a specification, not implemented by this restoration.

## Production verification

The replacement programs and fresh PUMP, SOL, WBTC, and USDC/SOL markets were deployed on 20 October 2026. PUMP, WBTC and USDC/SOL DN vaults were created without investment capital. The app preserves closed-program positions as historical holdings, checks canonical upgradeable ProgramData before wallet signing, and uses the new program IDs for active transactions. SOL Yield resolves the USDC/SOL sibling by exact underlying mint and quote direction; its vault is discovered from the new DN program.

Read-only mainnet simulations at slots 459357842–459358161 passed for the complete FTL Composer swap plus both 100× bet halves:

- SOL to WBTC: new Composer swap and a combined WBTC UP / USDC UP transaction (long WBTC, short SOL).
- SOL to USDC: new Composer swap and one merged USDC UP transaction (long USDC and short SOL).
- Bad-beat SOL to WBTC: new Composer swap and a combined USDC DOWN / WBTC DOWN transaction (long SOL, short WBTC).

All owner signatures were absent, no closed program appeared in the transaction account keys, and the plans had no pending listings or unavailable halves. These were simulations; they did not send trades or deposit capital. Evidence is in the salvage directory's `ftl-composer-sol-wbtc-integration.json`, `ftl-composer-sol-usdc-integration.json`, and `ftl-composer-sol-wbtc-bad-beat-integration.json`.

Local app validation passed `npm run build` with explicit replacement production bindings, `node --import tsx scripts/restoration-check.ts`, and `node --import tsx scripts/restoration-legs-check.ts`. The latter checks missing-half reporting, the original SOL inverse directions and budget split, and exact-mint SOL Yield resolution.
