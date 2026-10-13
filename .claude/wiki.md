# hooked / 100x.broker — wiki

## Every site tx compiles with the lookup table `HR1YvAhHBXPkhFFjp2mzaAg5ojnNUQyamU8qzTW4PK7U`
A stranger's SOL→Ape tx (cu + ATA + DepositSol + 2 SDK ATAs + hook swap + claim_fees) is 1234 bytes raw — 2 over the 1232 limit. The house wallet never hit it because its referral account is its own ATA (one fewer key). `toV0()` in `app/src/lib/chain.ts` fetches the table (60 s cache, falls back to plain v0); authority is the keeper, which appends new markets' accounts each loop (`scripts/alt.ts`, `create-alt.ts`, `alt.json`).
**Why:** wallets showed "couldn't be verified / Simulation failed" and nobody but the dev could ever buy. Any new account in the buy path must either be in the table or re-measured.

## SOL buys overshoot the deposit by 1e-6 r-fstacc on purpose
The stake pool rounds its deposit fee up; `depositOut()` rounded down, so a wallet with zero r-fstacc was 1 unit short of the swap's `amountIn` (Token "insufficient funds" inside DBC). `DEPOSIT_DUST = 1_000n` in `app/src/lib/zap.ts` is subtracted from the swap amount; the dust stays in the user's r-fstacc ATA.
**Why:** user's call ("just overshoot it leave some dust"); exact fee math across a fork of the stake pool program is not worth the fragility.

## Repro recipe for "can a stranger trade?"
Fund a fresh keypair from the keeper (0.02 SOL), build the exact ix list the Ticket builds, `simulateTransaction` it, refund. Your own wallet is a bad test: it already has every ATA, holds r-fstacc dust, and is the referral default.
**Why:** both launch-day bugs above were invisible from the dev wallet.

## Exit router (Sell tab)
Sells up to `curveCapacity()` (tokens between the curve's launch sqrt price and current) on the curve, redeems the remainder at the pot in the same tx; takes whole-pot redeem instead when that pays more. Buy/sell/redeem all append `claim_fees` so curve fees are swept on every trade.
**Why:** "it should never ever be in a state where I cannot sell" — a drained curve throws Insufficient Liquidity on its own.

## Feed classifier gap
`/api/feed` recognises buys/sells/redeems/settles/pokes/listed/burns by top-level program ix. Standalone `claim_fees` txs don't appear (the DBC claim is a CPI).
**Why:** don't chase "missing" claim events; by design.

## Per-wallet feed is indexed off the wallet's own token accounts
`/api/feed?w=<wallet>` (`walletFeed`) pulls `getSignaturesForAddress` for the wallet's UP/DOWN ATAs on every market (+ its $100XBRO ATA for burns) and classifies those txs. Filtering the global feed by actor does NOT work: it only holds the last ~60 events and the keeper's chores push a human's trades out within the hour.
**Why:** the bag page showed "no moves" for the wallet that made every trade.

## Token images go through `/api/icon`
Helius' image CDN 429s under even light load; `/api/icon` caches a 128 px copy with IPFS gateway fallbacks. Satori OG cards: no `double` borders, childless divs need `display:flex`.
**Why:** blank icons/OG cards on first launch.

## Price precision
`usdPrice()`/`price()` = 6 digits (6 decimals ≥ 1, 6 sig figs < 1) for anything that is a price; `usd()` = money, 2 dp.
**Why:** user-fixed ("to 6 precisions (both cases)").

## Keeper knobs (Fly app `hundredx-keeper`, machine `869292ce792378`)
`MIN_BURN_LST=50000`, restock buys ≥ 0.01 SOL via PumpPortal at slippage 99, WithdrawSol at 97 % of the quote, `KEEP_SOL=0.02`. Dockerfile copies files by name — add any new `scripts/*.ts` import there or the machine crash-loops and Fly leaves it **stopped** (needs `fly machine start`).
**Why:** happened on the alt.ts deploy; a stopped keeper means no burns/settles/pokes.

## The bag: `/me` (connected wallet) and `/p/:wallet` (anyone's)
`app/src/pages/Portfolio.tsx` + `lib/portfolio.ts` (one `getMultipleAccountsInfo` over every UP/DOWN ATA + SOL + r-fstacc + $100XBRO). Worth = per position `max(curve, pot-after-fee)`. Actions on your own bag: Exit / Cash out at pot per side, Exit everything (two-click arm), sweep loose change (WithdrawSol of r-fstacc dust), Make them pay / Sweep tips for markets you hold, flex (bag + position OG cards), copy bag + referral links. Feed `actor=` prop filters the global feed; every wallet short-address on the site links to `/p/:wallet`. OG tags via `vercel.json` rewrite `/p/:wallet` → `/api/page?owner=`.
**Why:** users asked where their positions are; the market page only showed one market's book.

## Exit router lives in `app/src/lib/exit.ts`
`planExit` / `exitIxs` / `redeemIxs` / `potQuote` / `curveQuote` are shared by the Ticket and the bag page. SOL payout is skipped (proceeds stay as loose change) when `withdrawOut(min) > withdrawCapacity(pool)`.
**Why:** two copies of the router would drift; the pot-vs-curve choice is the "never stuck" guarantee.

## dnvault — delta-neutral LP vaults (program `2ZbjE44nSh3AmpREg4sdNMViBLAzAEtFKYDn1XdqMzEj`, `programs/dnvault`)
Custody + on-chain valuation + "keeper proposes, program verifies": `act` forwards an allowlisted CPI (Raydium CLMM open/increase/decrease/swap/close, DBC hook swap on the bear pool, hooked `redeem` side 1, stake pool DepositSol/WithdrawSol pinned to the vault's accounts) signed by the vault PDA and its SOL sub-account; the first `act` of a tx snapshots NAV/hedge/D/fees and introspects for a `settle` later in the same tx; `settle` enforces NAV ≥ snap × (1 − max_loss_bps) and hedge error ≤ band (or no worse), then pays the caller `keeper_bps` of |ΔD| + harvested fees. Hedge target `D* = X exposure / 100` of the DOWN pot; X valued at the market's own TWAP, position composition at pool spot. Withdraw is in kind (SOL, WSOL, X, DOWN via transfer_checked with hook accounts, and `decrease_liquidity_v2` straight to the user). Vault layout in `scripts/dn/lib.ts`/`app/src/lib/dn.ts` (488 bytes).
**Why:** the user's spec — tokenized receipt vaults whose share price is the yield, permissionless incentivized keeper, never stuck.

## dnvault landmines
(1) WSOL/X token accounts and the position NFT are owned by the **SOL sub-account** (`["sol", vault]`, system-owned, zero data) — Raydium's `open_position` makes the rent payer the token owner and a program-owned PDA with data can't pay rent; DOWN and r-fstacc stay under the vault. (2) Any action that creates X exposure must carry its hedge in the same tx or `settle` fails with 0xd. (3) A fresh tick array costs 0.072 SOL rent — vaults use the widest *already-initialized* range (`create-vault.ts`), not full range. (4) PUMP is Token-2022 → `x_is_t22` picks the token program and X leaves via `transfer_checked`. (5) The DOWN curve is usually at floor, so hedge pot-share costs ~half its NAV to buy — fine for the vault, but `max_loss_bps` must still allow swap fee + position rent (~0.4 % on 1 SOL). (6) `scripts/dn/fork-upgrade.ts` hot-swaps programdata on surfpool but the program cache doesn't reload — restart the fork and deploy via the loader with the authority key instead.
**Why:** each cost a failed e2e run; the fork e2e (`SHIFT=n RPC=fork bun dn/e2e.ts`) covers deposit → swap+hedge → open → in-kind withdraw → NAV-priced deposit.

## Mainnet vault #1: PUMP/SOL `H9RwxG2ftmSCGBWjrmLaAdFYHxNb8DzfrfEhcQ7JPD1T`
Shares `4S13mUdnk8q1xMTsrzjCfzjs6DogVAsMxZycoC3JCZzF`, SOL sub-account `db2FVUpK2ye1CVJPDuwokqLAKqt5u65RXPD4GJkN1CQ`, range 25800..33590 on `45ssPkUQ…`, band 1500 / max loss 300 / keeper 100 bps. Seeded with 1 SOL from the dev wallet 2026-10-10; keeper (`scripts/dn/keeper.ts`, same Fly machine via `start.sh`) deployed it: position `CU9tsWZBnhejBgZP21WUJC1StqAHnq6ZL2nnEVSWXSEj`. `/yield` on the site; `/api/raypool` proxies Raydium's fee APR; "projected" = pool day APR × deployed share (a wide range earns below pool average — "sustained" is the honest number).
**Why:** the first real vault; its ALT accounts live in `HR1Y…`.

## IDLs live on-chain via Program Metadata (seed "idl", zlib) for both programs
`idl/hooked.json`, `idl/dnvault.json` are hand-written Anchor-0.30-format IDLs (1-byte discriminators, the hook Execute uses the SPL transfer-hook discriminator). Republish with `bunx @solana-program/program-metadata write idl <program> idl/<name>.json -k ~/hooked.json --rpc <helius> --compression zlib`. Pinocchio programs can't host an Anchor IDL account (that needs the program's own IDL instruction handler).
**Why:** explorers/Codama read program metadata; the user asked for published IDLs.

## Stable/stable markets: USDC/USDT `6mv4asxkEEUHoEC1VxoGpygwRexqYqFim5ehMGtFNHQo` (oracle `BZtgQEyS…`, USDC = token0), PYUSD/USDT `EF8ChwcbTLxku4tPRRKzP31sw2CDCBTsprcYwSiursKJ` (`BrBs4u…`), TUSD/USDT `7g6syeNQYFgjLYPBXyMjf8tMgAaQvj1XcvpGJuWMk5e7` (`Gs34mz…`)
`create-market.ts` picks the underlying as "the non-SOL side", so on a stable/stable pool it is mint0 priced in mint1. PYUSD and TUSD run in sampling mode (dead rings, see the oracle fallback entry); the first mainnet hooked buy on PYUSD (`2gfrL8pt…`) confirmed the 6-entry meta list resolves and the hook samples. `create-market.ts` needs `DAS_RPC` (Helius) when `RPC` is a fork. The USDC and USDT markets launched on day one are priced in **SOL** (oracle pools `3ucNos…`, `3nMFwZ…`), i.e. inverse-SOL at 100×, not calm — the board and market pages now show `TICKER / QUOTE` and a ⇄ flip (`inverted` in `hooks/price.tsx`, persisted as `inv`) so a USDC/SOL market reads as SOL's price in USDC.
**Why:** "long/short stables, ez money" only makes sense when the quote is another stable; on stable/stable a 1-tick (1 bp) TWAP move transfers ~1% of the losing pot, and the only edge is being the smaller pot (it receives 54% of every fee); there is no funding at all, but 4%+4% round trip must be covered by other people's volume.

## Oracle fallback: dead Raydium rings are self-sampled (hooked v3, 2026-10-10)
Some active Raydium CLMM pools never advance their observation ring (PYUSD/USDT `BrBs4u…`, TUSD/USDT `Gs34mz…`: one June entry, swapped daily via a router). When the ring's newest point is older than `RING_STALE_SECS` (3600) **and** the oracle pool account is passed, `rebalance` builds the end point itself: newest known cumulative (ring or own checkpoint) + `tick_current × elapsed`, pushes it as a checkpoint, and takes the TWAP over the window from those. New markets' ExtraAccountMetaList has 6 entries (pool appended, `EXTRA_METAS = 6`); poke/redeem/settle_begin accept the pool as an optional trailing account; old 5-entry markets just never enter sampling mode. The keeper pokes sampled markets every 150 s ("sample …") because the TWAP only advances when someone rebalances. `create_market` on a dead ring seeds `last_twap` from the pool tick. Client mirrors: `twapNow(obs, ckpts, window, {now, tick})` in `app/src/lib/chain.ts` and `scripts/keeper.ts`.
**Why:** a one-slot price push is worth `elapsed/window` of the TWAP, so sampling keeps the 66-min protection; spot would let anyone drain a pot with a round-trip swap at p = 100.

## Known soft spots
Dev wallet `331nEB…` (upgrade authority) sits near 0.065 SOL — keep ≥ 0.1. 100XBRO's Raydium CLMM is ~0.5 SOL deep so its TWAP swings hard and both curves hit floor fast; pots still hold value.
**Why:** sitrep items the user asked to track.

## 1-click zaps for the vaults (`/api/dnzap` + `app/src/lib/zapdn.ts`, 2026-10-10)
The server only *plans* (`app/api/_lib/dnplan.ts`, needs `HELIUS_RPC_URL`): zap-in = [deposit] → [wrap + act(Raydium swap half) + act(stake-pool DepositSol) + act(DBC DOWN buy) + settle(user)] → [open/increase position + bind + settle(user)]; the user signs all of them in one `signAllTransactions` prompt and the browser sends them in order, so the user is the keeper for their own deposit and takes the bounty. Zap-out = tx1 in-kind withdraw, tx2 (signed blind, before tx1 lands) sells 98% of the pro-rata X estimate on Raydium, closes WSOL, exits the DOWN via the exit router, unstakes the quote. `RESERVE` 0.03 SOL stays idle, `MIN_DEPLOY` 0.02 SOL below which the plan is deposit-only. Wallets preview later txs against pre-tx1 state and may flag them "may fail"; the ticket copy says so. `scripts/dn/zap-e2e.ts` runs both directions on the fork (ALL PASS).
**Why:** the user asked for 1-click park/unpark; keeping the keypairs client-side keeps the server unprivileged, and the 98% factor is what makes a blind-signed tx2 safe against NAV drift between planning and landing.

## Board themes: `STABLES`/`themeOf` in `app/src/pages/Board.tsx`
Buckets are derived, not stored: stable base + USDC/USDT quote → "stable/stable"; stable base + SOL quote → "inverse SOL"; everything else "coins". Add a ticker to `STABLES` when listing a new stable.
**Why:** a USDC/SOL market is 100× SOL inverse, not a calm market; the filter exists so the stable/stable play is findable and the inverse-SOL ones aren't mistaken for it.

## Deploy/infra rules learnt the hard way
`scripts/deploy-mainnet.sh` must `ExtendProgram` by ≥ 10240 bytes (smaller extends are rejected). Fly `fly.toml` needs `[processes] keeper = "bash start.sh"` (`wait -n` is bash-only) and `DN_PROGRAM_ID` in env, else the dn keeper crashes reading `target/deploy`. Vercel Web Analytics is not enabled on project `prj_XJGwmPI1q3fxW8VQyoogSqm4IVZT` (team `team_LbpAcKa6PadmX6etv9XUYw3c`), so traffic questions need another source. `vercel.json` `memory` is ignored on Active CPU billing (harmless warning).
**Why:** each of these cost a failed deploy or a crash loop once.

## Market page is written for noobs first (2026-10-10)
Tabs are Buy / Sell / Cash out with a one-line helper; the quote shows "Leverage right now" plus a ±0.1% consequence line and, on Buy, a what-if strip (−1% / flat / +1% → your pot cash-out, via `whatIf` in `app/src/lib/exit.ts`, which mirrors the program's 1 − 1.0001^(−100·ticks) transfer) and the curve sell-back price. A dismissible primer sits above the ticket (localStorage `primer`); the keeper chores panel is a collapsed `<details>`. The DN vault widget (`DnWidget`, lookup `vaultsForMarket` memcmp offset 8) sits under the ticket on every market.
**Why:** Telegram feedback ("easier for noobs"); the one actionable gap was that nothing told a buyer what happens to their money.

## `/m/` and `/p/` HTML must never be CDN/browser-cached across deploys
`api/page.ts` injects OG tags into the live SPA shell (fetched from `/`). It used to send `s-maxage=60, stale-while-revalidate=600`; after a deploy, a stale cached page still referenced the previous build's `assets/index-<hash>.js`, which 404s → rewrite to index.html → "module script … text/html" → blank market pages for up to 10 min. Now `public, max-age=0, must-revalidate`.
**Why:** asset hashes change every build and old assets are not served under the alias; any cached shell is a blank page.

## dnvault deploy landmines (found 2026-10-10 on the first user zaps)
(1) Size Raydium liquidity from 99% of the balances and pass the full balances as amountMax — the pool ticks between planning and landing and `IncreaseLiquidityV2` fails `PriceSlippageCheck` (0x1781) over a single lamport (`dnplan.ts`, `ops.ts openPositionIxs`, `keeper.ts addLiquidity`). (2) After a confirmed tx, read the vault's token balances with `minContextSlot` = that tx's slot (`keeper.ts looseBalances`): Helius' load balancer serves a node a second behind and the next tx is sized on stale numbers (token error Custom 1). (3) The hedge's stake-pool DepositSol is paid from the SOL sub-account; when only WSOL is loose the keeper unwraps first (`unwrap` closes the WSOL ATA, so the tx re-creates it before `wrap`). (4) The keeper folds loose WSOL + X into the position every pass regardless of `MIN_DEPLOY`; a half-done deploy otherwise strands them.
**Why:** each of these left a user's park half-deployed once.

## Curve debt ("in the hole") is relative to the current price
`owed = 1 − keepQ63/2^63`; settle sells minted tokens until the curve's sqrt price hits `current × sqrt(keep)`, clamped at the launch floor. So a fresh buy on a side that owes 99% is collected 99% of its price the moment it trades above the floor — the buyer's SOL funds the other pot. The ticket now warns when `owed > 1%` and the sell-back estimate is `max(pot share at post-buy supply, paid × 0.92 × keep)` (`exit.ts sellBackEstimate`). "Make them pay" on the bag page usually fails because the keeper settles within seconds; the toast now carries the simulation's reason.
**Why:** this is the single biggest noob trap on the site and nothing used to say so.

## Share cards and X's cache (2026-10-10)
`/api/og` renders market, position (`m`+`side`+`owner`, with the owner's realized/unrealized/return from `api/_lib/pnl.ts`), vault (`v`, optional `ref`), bag (`owner`) and a site card (no params); market/position/vault cards carry a sparkline from the oracle observation ring + checkpoints (`seriesFromMarket`). `/yield/:vault` is server-rendered by `api/page.ts` like `/m/` and `/p/`; a `ref` on any of them appends "Shared by …" and, with `side`, turns the market image into the sharer's position card. **X caches an unfurl by page URL and never re-reads it**, so `shareUrl()` stamps every shared link with `s=<5-minute bucket>`; busting the image URL alone does nothing for X (Telegram/Discord refetch fine). Position shares put the row's P&L in the tweet text too.
**Why:** the first vault tweets went out while `/api/og` still 400'd without a market, and X kept that blank card for the URL forever.

## Referral dashboard: `/api/ref?w=` reads the chain
Referral income = the stake pool's DepositSol referral fee (50% of the 0.1% SOL deposit fee) paid to the referrer's r-fstacc ATA; the API scans that ATA's history (needs `maxSupportedTransactionVersion: 1`, the user's history has v1 txs) for DepositSol ixs where account 6 is the ATA and the funder isn't the owner. The dev 10% cut lands in the same ATA (`DEV_ATA` = dev wallet's r-fstacc ATA), i.e. the bag page's "loose change".
**Why:** "where's my dev cut / my ref money" — same account, sweepable to SOL from the bag page.

## The DOWN hedge is asymmetric: coverage, not just error bps (2026-10-10)
A DOWN token loses at 100× when the coin pumps (its pot pays a slice of itself) but wins only a slice of the **UP** pot when the coin dumps, so with D sized to E/100 the vault covers a pump ~100% and a dump only UP_pot/DOWN_pot of the way. `hedgeCoverage()` in `app/src/lib/dn.ts` exposes `{up, down, balance}`; the yield badge reads "sized · N bps · covers ↑x ↓y", `LopsidedNote` warns under 80% either way, and the OG vault card shows the same. The program's band/err_bps check is balanced-book sizing and stays as is. Concavity (1 − e^(−100Δ)) is second-order because the keeper re-centres within the band and the TWAP moves in small steps; the realized residual is the "since launch" share price, so that tile is labelled realized and projected is labelled "if the last 24 h of pool fees repeat".
**Why:** Grok's review (4/10 → 6/10 once this shipped) was right that "hedged · 18 bps" hid the directional gap on a one-wallet book; the fix is to show coverage live and let usage balance the pots, which the empty-side payout is designed to do.

## Vaults #2 and #3 (2026-10-11): SOL/USDC `84AzR3LMXcWYgRubwobaUS9CfNU9xUVGCuDf1Yh2ZVKf`, SpaceX `B98eFQdghPDgbbcKGGLPKTE4ubU3UyrzB5wHaqrddADK`
USDC vault sits on the USDC/SOL market `38K7j6RR…` (Raydium SOL/USDC CLMM `3ucNos4N…`, $7.8M TVL, 20–50% fee APR), seeded 0.5 SOL; range −22440..−21661, spacing 1. SpaceX: new market `Hfp2YofFW5ZTr7MY8LbHasD5Xz2GqDrBSVNWXNgoxj8p` (UP `BfiGir…`, DOWN `8mhpTL…`) on xStocks SPCX `SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb` (Token-2022) vs the SPCX/WSOL CLMM `7tJVK2uE…` ($179k TVL, $126k/day, 0.6% fee, ~150% fee APR); vault range 64800..82740 spacing 60, seeded 0.15 SOL. HYPE has no honest Solana pool: every "HYPE" CLMM on DexScreener is a spoof (billions of fake liquidity, hundreds of dollars of volume). Market creation cost ~0.04 SOL, vault creation ~0.01, both from the dev wallet.
**Why:** the blue-chip and the tokenized-stock vaults are the answer to "memecoin only"; HYPE is not on the menu until a real bridge pool exists.

## Hedge starvation and the day-one dip
`hedgeDelta` returns 0 when the whole DOWN pot is smaller than D* (the pot can't hedge the exposure), so a vault whose market's DOWN pot got cashed out sits at err 10000 bps until the pot refills (a tip, or anyone buying DOWN). The hedge is bought on the DOWN curve but valued at pot share after 4%, so on a thin book a deploy books an immediate NAV dip (USDC vault: −3.4% on day one) that is the curve-vs-pot gap, not a loss at the curve. `LopsidedNote` says both. Cashing out 97% of a side's DOWN leaves the 4% fee to the remaining holder (the vault's D quintupled, then the keeper sold it down to zero and had nothing to buy).
**Why:** all three happened within one hour of the first real user flow; without the UI text they look like bugs.

## Hedging a DOWN side nobody holds: buy dust, cash out most of it in the same tx
The program scores the hedge as |d − d*| / d* and `settle` refuses anything worse than the snapshot, so on a market where circulating DOWN is 0 a plain buy (vault becomes 100% of the pot, pot ≫ d*) scores 40,000 bps and is rejected, while doing nothing scores 10,000. `keeper.ts hedgeIxs` therefore buys 1e9 raw of DOWN and, in the same `act` tx, redeems `t·(pot − d*)/(0.96·pot)` of it so the pot itself lands on d* (the redeem fee stays in the pot the vault now owns). `hedgeDelta` has the matching sole-holder sell branch (`held === circ`). It needs the DOWN pot to be ≥ d* first, which a 0.01–0.02 SOL tip to the market's pots provides (`depositSolIx` + transfer r-fstacc to the UP/DOWN vault accounts at market offsets 168/200). Also: the fold-loose step right after an open-position tx can hit `nft_account … AccountNotInitialized` on a lagging node; it succeeds on the next pass.
**Why:** every fresh market starts with zero DOWN holders, so every new vault's first deploy hits this.

## Raydium pools with farming rewards need reward accounts on every decrease (2026-10-11)
`decrease_liquidity_v2` rejects with 6030 `InvalidRewardInputAccountNumber` unless the remaining accounts carry `[reward vault (w), recipient ATA (w), reward mint (r)]` for every active reward (pool state: 3 × 169-byte reward infos from offset 397; state at +0, mint at +57, vault at +89). SOL/USDC `3ucNos…` has one (RAY, to 2026-05-26); PUMP and SPCX pools have none. Fixed in `app/src/lib/dn.ts withdrawIxs` (parses the pool, creates the user's reward ATA idempotently) and `scripts/dn/ops.ts decreaseIx`/`rewardAtas` (keeper harvest pre-creates the sub-account's reward ATAs). `scripts/dn/move.ts <from> <to> <sol>` moves SOL between vaults from a wallet: unpark in kind → sell X, unwrap, cash out DOWN, unstake → park.
**Why:** the first unpark from the USDC vault failed on this; every blue-chip pool is likely to have a farm.

## Lookup tables are a keeper-owned set, discovered on chain (2026-10-11)
`HR1YvAhHBXPkhFFjp2mzaAg5ojnNUQyamU8qzTW4PK7U` filled to 256 the moment the SI vault landed, so there is no single ALT any more. `scripts/alt.ts` has `listAlts(conn, authority = keeper EGa3ng…)` (gPA on the ALT program, memcmp authority at byte 22, live = deactivation_slot u64::MAX) and `ensureAlts(conn, keeperKp, wanted)` (fill tables with room in 20-address chunks, then create a new table and keep going). The hooked keeper calls `ensureAlts` every loop for global + market accounts; `dn/ops.ts vaultAlt`/`vaultAccounts` do the vault side; `bun alt-sync.ts` does everything at once (created `27hak3EqFEAVp98eDci1FWV1EVBs87Efp7kMJ8ZEkm7X`). The site (`app/src/lib/chain.ts lookupTables`) and the dn keeper load the whole set the same way and cache 60 s; `compileToV0Message(tables)` only references tables an ix actually uses, so passing all of them costs nothing.
**Why:** a full table silently breaks every new market/vault (txs >1232 bytes); a registry would need a redeploy per table, the authority key does not.

## New markets 2026-10-11: SPYx `ECZiaQYbpZDRzs927Vz1U3xdDbMDhgQBxpCoFfjhUzCj` (oracle SPYx/WSOL CLMM `BS9uyG…`, $1.0M), USO `6c5V6uTyFeTbXJFrmSWvieZMuPaDCpZzGDUtZKP4vkbF` (Backpack USO `USNv3N…`, oracle USO/SOL CLMM `Am6L7q…`, $70k), SI `9LAcY3v4EBG8dkKtHvh7ynJGzvGFp5cTQqzGuowaSgCG`
A market costs ~0.04 SOL (`RPC=… PAYER=~/hooked.json DAS_RPC=<helius> ORACLE_POOL=<clmm> bun create-market.ts`). Vaults: USO `Ew9Z6M4YEWU2ohdPhtV8TNUjTbamP31357Jz9hhMSbbg`, SI `68NpjKvvEuGkFg4iFh7N5yES5hryHnVcLFTY4sVttzvc` (`ALT_AUTHORITY=keeper.json bun dn/create-vault.ts <market>`, ~0.012 SOL). `scripts/punt.ts <market> UP|DOWN <sol>` buys a side from a script (stake first, then the hooked swap on the lookup tables — the swap alone is ~1.1 KB, `send()` adds its own compute budget so never prepend `cu()`, and the SDK repeats its ATA creates so dedupe). `dn/unpark.ts <vault> <fraction>` + `dn/finish-unpark.ts` take receipts back to SOL (the finish step must recreate the WSOL ATA; the previous unpark closed it).
**Why:** SI has no real CLMM pool, so we made one — `ATwrVQsD1mAEQsR5WFoNuomTtWUNTaxmbpzUT3teWZNe`, Raydium config index 1 (0.25 %, spacing 60), price copied from PumpSwap, seeded 24k SI + 0.25 SOL over ×2 each way (`bun si-pool.ts`; MINT/SEED_SOL/RANGE/POOL env). That pool IS the SI oracle: ~0.5 SOL of depth, so it is pushable; the vault swaps inside it too, which is why the SI vault stays tiny (0.09 SOL) — deposits move their own price.

## Raydium SDK on a brand-new CLMM pool
`clmm.getPoolInfoFromRpc` throws `Object.values requires that input parameter not be null` until the pool has a tick array (and the Raydium API has indexed it, a minute or two). Seed with `api.fetchPoolById` + `api.fetchPoolKeysById` + `openPositionFromBase`, ticks from `log1.0001(price·10^(decB−decA))` snapped to spacing, amounts from the v3 formulas (`si-pool.ts` step 3). `TickUtils` is exported as `TickUtil` from the CJS bundle and `getPriceAndTick` returned NaN on API pool info. `poolCtx` (keeper, create-vault) works once the pool has liquidity.
**Why:** the first three seeding attempts died on these, one after another.

## Vault hedge needs a DOWN pot ≥ ~10× d* to be buyable
USO vault: LP deployed but "hedge needs 0.0588 SOL, only 0.0197 free" with D* 0.00208 and a 0.006 pot — the pot share it must buy (35 % of circ) walks the curve. A 0.022 SOL tip to the DOWN pot (tip script pattern, 95 % DOWN) fixed it in one loop (err 182 bps). Rule of thumb when launching a vault on a fresh market: tip pots so DOWN pot ≳ 10 × nav/200 before the first deposit. The dn keeper's `deploy()` also returns silently unless idle > RESERVE 0.03 + MIN_DEPLOY 0.05 + hedge.spend.
**Why:** "deploy failed" shows up as either a hedge-starved loop or total silence; both are sizing, not bugs.

## BABY100X sweeper (`scripts/sweep.ts`, in the hooked keeper loop after `burn()`)
Dev's 10 % lands in DEV_ATA `6Jrrws…` (delegated u64::MAX to the keeper). `sweepDev`: WithdrawSol from DEV_ATA as delegate → SOL → PumpPortal buy $100XBRO → pump `buy_exact_quote_in_v2` on BABY `CqCnyVWYSUapVhiB2u8kM6kKVYirLegumw84rm4spump` (curve `DstBGx…`, quoted in 100XBRO, both Token-2022) → Token-2022 burn. PumpPortal cannot build quote-token buys (`UnsupportedQuoteMint` 6063); Anchor `Program.fetchIdl` at runtime builds it; `sharing_config` is a PDA under the fee program `pfeeUx…` that may be empty. In-memory `carry` so a failed BABY buy retries; `MIN_SWEEP_LST` 2_000_000. Test: `bun sweep.ts baby 1000000000` (tx `47jSHk…` bought 7,033 BABY). Site copy now says "10 % buys BABY100X and burns it".
**Why:** the owner gave the whole dev share to the community coin; the balance readback after the buy needed a retry loop or it burned 0.

## /meta is the curated board (`app/src/meta.ts`), with its own live OG card
`META[]` rows (market, ticker, headline, thesis, side UP|DOWN|VAULT, vault?, tag) render `/meta` (Decide pattern, one button per row, `?side=0|1` preselects a side on the market page). `/meta` is rewritten to `/api/page?meta=1`; its og:image is `/api/og?meta=1&s=<5-min bucket>` → `metaCard()` reading `readMarketCard` per pick. Nav link "spicy". The owner's pitch line sits on the lander, /yield lede, market primer, site card and /meta.
**Why:** narrative markets are set by hand and change daily; one file, one redeploy.

## Oracle landmine: a market on a brand-new CLMM pool reads a wrong TWAP for its first 66 minutes (found 2026-10-11, SI)
`oracle.rs` mixes two cumulative bases: the market's own checkpoints start at 0 at `create_market`, the pool's observation ring starts at 0 at its *first observation* (first swap/position, here 6 min later). `window_start` falls back to "oldest point available" while the window is not yet full, so start = checkpoint (base A) and end = ring (base B) → TWAP = 28,859 for a pool at tick 45,800. It self-heals once `latest.ts − window` passes the ring's first point (start and end then share a base) — for SI that is 01:32:48 + 3960 s ≈ 02:39 UTC — but only when a new ring observation exists (the end is a *stored* observation; swaps create them) and someone pokes. Until then the dnvault on that market cannot deploy (`HedgeWorse`, program values the fresh X at the bad TWAP). `scripts/si-kick.ts` = two dust swaps through `dn/ops.swapIx` with a fake vault `{solPda: me, wsolAta, xAta}`; `scripts/si-nudge.sh` = sleep-until, kick, poke. The dn keeper's `deploy()` now sizes the first hedge to the program's TWAP view (`skew` clamp 0.05–20×), harmless when the oracle is sane.
**Why:** launching a market and a vault on a pool we created the same hour is a path nobody had walked; a program fix (anchor checkpoints to the ring's base, or refuse a TWAP whose start and end come from different bases) is the real cure.

## Unpark scripts used to cash out EVERY DOWN token in the wallet (fixed 2026-10-11 03:00)
`dn/unpark.ts` / `dn/finish-unpark.ts` redeemed the wallet's whole DOWN balance after an in-kind unpark, so the owner's own 0.08 SOL SI DOWN punt (and the 0.03 USO DOWN) got cashed out at a near-empty pot (~0.004 SOL back). `unpark.ts` now redeems only the delta it withdrew; `finish-unpark.ts` still sweeps everything by design (it is the "turn all of this into SOL" tool) — never run it on a wallet that holds a DOWN position it wants to keep.
**Why:** a hedge leg and a directional bet are the same mint; only the before/after delta tells them apart.

## Outage 2026-10-11 ~01:35–03:45 UTC: every SI trade from the site failed "transaction too large" (1648 > 1232 bytes)
Cause: `api/rpc.ts` allowlists `getProgramAccounts` to our own programs, so the client's new lookup-table scan (ALT program, memcmp authority @22) was refused and the client fell back to the single full table — markets whose accounts live only in the second table (SI, anything newer) compiled uncompressed. A stranger hit it and DM'd the error. Fix: the proxy allows exactly that filtered scan (`altScan` in rpc.ts); `config.ALT_FALLBACK` lists known tables for when the scan fails; verified by a real 0.01 SOL SI UP buy from a browser burner. Lesson: any new RPC method/program the client needs must be added to the proxy allowlist in the same deploy, and "tx too large" on one market = that market's accounts are not in a table the client loaded.
**Why:** the keeper, scripts and site all read tables the same way now, but only the site goes through the proxy.

## Burner wallet is a real adapter, not a shim
`src/lib/burner.ts` subclasses `BaseMessageSignerWalletAdapter`; key lives in `localStorage["burner:v1"]`, `readyState: Loadable`. Its own `connect()` is deferred 1200 ms because the child effect fires before the provider's listener is attached — the click "did nothing" without the delay.
**Why:** yoey-style first-timers have no wallet; a one-click burner is the funnel. Don't "simplify" the delay away.

## Vercel Web Analytics wiring
`main.tsx` calls `inject()`; `bits.tsx` tracks `connect`, `hooks.ts done()` tracks `tx` with a label. Query from the CLI: `vercel api /v1/query/web-analytics/...` with teamId `team_LbpAcKa6PadmX6etv9XUYw3c`, project `prj_XJGwmPI1q3fxW8VQyoogSqm4IVZT` (the MCP tool 403s; enabling analytics is dashboard-only).
**Why:** the user asks "funnel?" often; this is the only source of visitor → connect → tx numbers.

## Small vaults cannot open positions
Position rent (~0.006 SOL incl. re-created WSOL ATA) vs `max_loss_bps` 300 means a vault needs NAV ≳ 0.3 SOL before `deploy()` passes; the program's 3% guard also vetoes swaps that would move a thin pool. Keeper `deploy()` has a resume path (opens with loose X) and a `skew` hedge clamp 0.05–20× to match the program's TWAP view. `MIN_DEPLOY_SOL=0.02` in `scripts/fly.toml`.
**Why:** the SI vault sat at 0.126 SOL "deployed" and looked broken; it was rent math, not a bug. max_loss is immutable per vault.

## Board/Yield step lists use their own classes
`.howto` (Board 3-card grid, `li > b` label) and `.yield-steps` (/yield) — the generic `.steps` grid is the zap ticket's and splits words at card width.
**Why:** reusing `.steps` was the "what the fuck is this formatting" bug twice.

## Cosmetic: `lev` caps at >10,000×; PUMP vault "drifting" means sell-below-min-size
`format.ts lev()` prints `>10,000×` past the cap (OG card too). A PUMP vault showing "drifting" is a hedge delta smaller than the min sell size — not a leak.
**Why:** both have been reported as bugs.

## Creator-browser CI (kekloldyormarket/creator-browser-ci)
Org was billing-locked until a $200 prepay (solcard via PayPal); startup_failure = billing, not YAML. Hosted larger runners `creator-linux-16` / `creator-windows-16` (runner group 3) + `macos-15-large`; ~$0.04–0.08/runner-min, ~$0.30/min with all five targets. Apple jobs must `xcode-select` Xcode 26.3 (macOS 26 SDK modulemaps, Swift 6.2 for brave-ios) — commit e97a2e9. Windows jobs must install Windows SDK 10.0.28000 (Chromium pins it; runner image has 26100) — commit 4bfa1ed. Fork `staccDOTsol/brave-core`: 100x wiring a226b24, `HUNDREDX_DEFAULT_REF` = house wallet 6946fd5, pnpm-at-workspace-root 708dd77. The creator economy quotes in SOL/Sanctum LST, **not** r-fstacc.
**Why:** each of these cost a full runner cycle to discover.

## Tracer / Mycelium lineage (what the receipts actually support)
`~/Desktop/paperclip.json` = #paperclip (Jul–Oct 2021, 399 msgs): user built the ccxt data rig for the perpetual-pools sim and posted "more fees = farmin' pools… measure the APY" (2021-07-22) — the /yield idea. FTX appears only as a backtest data source. Zero Arthur/Hayes mentions in that channel; the Oct 2023 "Arthur rumour spike" message is elsewhere and is a rumour. User's own TG (Aug 2022) says they "worked with tracer/mycelium when they were onboarding hayes" — first-person claim only. DiscordChatExporter lives at `~/dce`.
**Why:** public copy may say "built with the Tracer/Mycelium team, fee-pools idea became /yield"; it must not assert a Hayes endorsement or name his anon handle.

## IDLs are hand-written and nothing in the repo consumes them
`idl/hooked.json` / `idl/dnvault.json` are Anchor-format IDLs for pinocchio programs (no `#[program]`, no `anchor build`). App and scripts hand-encode instructions (`app/src/lib/hooked.ts`, `scripts/lib.ts`); a grep for `hooked.json` matches the **keypair** `~/hooked.json`, not the IDL. Verified 2026-10-11 against source: tags/discriminators, account order and counts (incl. trailing optional `oracle_pool` and dnvault's 12 `VAL_ACCOUNTS`), arg layouts, signer flags, error tables, struct sizes (Market 1008, BurnState 40, Vault 488) all match the Oct 10 21:10/21:53 UTC deploys. Neither program has an on-chain anchor IDL account.
**Why:** "are the IDLs current" has to be answered by diffing against `processor.rs`/`state.rs`, not by rebuilding; the BurnState entry once shipped with an empty discriminator and `disc` as a field (fixed to `hookbrn1`).

## Arena / agent API (2026-10-11): `api/arena.ts` + `public/cli/x100.mjs` + `/arena`
Server builds **unsigned** txs (`tx` or ordered `txs`), agents sign locally with a solana-keygen JSON at `~/.x100/arena.json`. Kinds: buy, sell, park, unpark, finish, create-pool (Jupiter buy + Raydium CLMM create), seed-pool, create-market (progressive: config → curves → market, `keys` to resume; the DBC SDK reads the config on chain before it builds a curve), create-vault, poke, settle, claim. Reads: `?list`, `?vaults`, `?who`, `?pools=<mint>`, `?keeper=1`, board. Swagger at `/api` (`api/index.ts`, rewrite `/api` → `/api/index`; `/((?!api(/|$)).*)` is an invalid Vercel pattern). Registry + cohorts in `src/arena.ts`. Server imports `src/lib/*` — those modules now use explicit `.js` import suffixes and `config.ts` guards `import.meta.env`/`window`, because Vercel functions run as native ESM (no bundling of extensionless imports). Positions are marked at the exit router (`planExit`), not marginal price × units: a settled curve (owed=1, reserve≈0) marks a fresh buy near zero and that is the truth.
**Why:** the Dot agents could run commands but their vendors refused "custody/live trading"; a CLI that signs on their own machine was the shape that got through. The marking choice came from agents complaining the board under/over-valued bags.

## Helius upstream rate-limits bursts (429) — everything that reads the chain must retry
Seen 39/50 request-log lines as 429 on `/api/rpc` with ~110 visitors/80 min; `web3.Connection` retries some calls, the stake-pool read and `getBalance` did not. `api/arena.ts` wraps them in `retry()`, loads markets 3 at a time, caches 60 s, serves activity counts stale. Keeper list (`?keeper=1`) must not call `settleAmount` per market (30 s timeout) — it reports `owed` fractions instead.
**Why:** the plan is the bottleneck, not the code; a bigger Helius tier or a second upstream is the real fix.

## 100XBRO UP got settled to zero on 2026-10-11 09:06–09:09 UTC
Two agents put ~0.75 SOL into 100XBRO UP; the hourly TWAP moved >1% against UP; the house keeper's settle sold escrow into the UP curve and moved the whole reserve to the DOWN pot; outsider `55WtrTBF…` redeemed DOWN for 0.71 SOL at 09:12. Working as designed (100× on a thin memecoin). README copy was wrong ("not your whole stake") and is fixed.
**Why:** anyone reading the board will think the marks are broken; they are not.

## Market views are served as one shared snapshot: `GET /api/markets` (api/_lib/views.ts, src/lib/views.ts)
Board/Meta/arena read the edge-cached snapshot (10 s) and fall back to the chain only if it fails; `POLL_MS` is 10 s. Encoding tags bigints `{$b}`, PublicKeys `{$p}`, bytes `{$u}`. **Landmine:** `JSON.stringify` calls `toJSON` before the replacer sees a value, so `PublicKey` arrives as a string — tag from `this[key]` (the holder's raw value), not from `val`. The first deploy got this wrong and the Board threw `toBase58 is not a function` for every visitor until the fix.
**Why:** every open tab did ~80 RPC calls through `/api/rpc` every 6 s; with ~100 visitors/hour that is what 429'd the Helius upstream for everyone (and likely failed outsiders' trades). One server load per 10–30 s now feeds all tabs.

## `/api/rpc` retries 429s and falls back to a second upstream
Three tries against `HELIUS_RPC_URL` with 250/500/750 ms backoff, then `RPC_FALLBACK_URLS` (comma list; default public mainnet-beta); the response carries `x-rpc-upstream: fallback` when it did. Burst test went from 4/10 429s to 0/15.
**Why:** browser web3 gives up on 429s fast and whole pages (vault page) rendered "Couldn't load"; the proxy is the one place every tab's reads pass through, so it is where the smoothing belongs. The real fix is still a bigger Helius tier.

## /yield headline is the realized pace, compounded (owner's rule)
When a vault has ≥1 h of positive share-price history, the big APY tile is `(1+change)^(year/age)`, printed as a power of ten past a billion percent (`fmtMult`), with the simple rate, the doubling time (`doubling()`), and the pool-fee projection as the footnote. The owner said five times that under-selling the compounding is wrong; do not "fix" this back to the fee projection. The realized line also splits the change into fees (pool rate pro-rated) and hedge.
**Why:** marketing voice is the owner's call; the fee/hedge split keeps it honest without burying the number.

## RPC routing (2026-10-11): FluxRPC for live state, Helius for history — `api/rpc.ts`
Env: `FLUX_RPC_URLS` (comma list, two Developer-plan keys alternated per request), `HELIUS_RPC_URL`, optional `RPC_FALLBACK_URLS` (default publicnode + mainnet-beta). Historical methods (getSignaturesForAddress, getTransaction, getBlockTime, getAsset) go Helius → Flux → public; everything else Flux → Helius → public. Single cacheable reads are answered from a per-instance window cache (2 s for account reads, 1.5 s blockhash, 60 s DAS/rent) with in-flight coalescing; the caller's JSON-RPC `id` is rewritten back onto cached bodies. Response headers `x-rpc-upstream` / `x-rpc-cache` tell you what happened. Server-side `conn` (config.ts) prefers the first Flux URL. The Fly keeper's `RPC` secret is the second Flux key.
**Why:** Helius alone 429'd under ~100 visitors/hour; Flux's plan is metered by bandwidth (1 TB/mo), not requests. Never print the keys; the dashboard paste lives only in chat.

## Creator-browser native CI: the two source errors behind runs #11–#18 (2026-10-11)
Fork `staccDOTsol/brave-core` 841becf fixes both. (1) `creator_detection` transpile_web_ui failed on win/mac/ios at 6946fd5: `creator_context.ts` imports `creator_economy/common/hundredx.ts` but the target's `imports_from` didn't list that folder; `verify-webpack-srcs` rejects any import outside `imports_from` ("error occured cross-referencing import_paths folders"). (2) linux/android at 04f4382 died at ~97% on `chromium_src/chrome/browser/speech/chrome_speech_recognition_manager_delegate.cc`: `if (!BUILDFLAG(ENABLE_BRAVE_SPEECH_TO_TEXT)) {…return;}` makes the rest unreachable → `-Werror,-Wunreachable-code`. Compile-time buildflag gates in chromium_src must be `#if`, never `if (BUILDFLAG(...))`. Runs that took ~3h were not hangs: a full Component build is ~3h15m on `creator-linux-16` (≈61k ninja steps for linux, 65k android). `macos-15-large` (Intel 12-core, 10 jobs) managed only ~16.7k of 77k steps in 2h22m (≈90 steps/min once into C++) — a full mac build projects to >10h, past GitHub's 6h job cap.
**Why:** both errors only surface hours into a $0.08–0.12/min runner; and the mac projection decides whether a hosted Intel runner can ever go green.

## "Enshrined" hook program = immutable, verified on chain
Raydium allowlist PRs (cp-swap #81, clmm #203) define an enshrined transfer-hook program as one whose upgrade authority is None (ProgramData authority tag 0) or that lives under a non-upgradeable loader; `create_support_hook_program` checks this on chain. There is deliberately no close/un-enshrine instruction. A per-mint SupportMintAssociated entry never excuses an active hook.
**Why:** the user's definition of enshrine ("set upgrade authority none, u cant unenshrine"); an earlier draft with a close instruction contradicted immutability and was removed.

## Raydium PR hygiene
Six PRs: cp-swap #81, clmm #203, sdk-V2 #182 (cpmm) and #183 (clmm), ui-v3-public #19 (cpmm) and #20 (clmm). Commits authored solely by staccDOTsol, no AI trailer or mention in bodies; PR text never cites Tom or Telegram DMs. Each SDK/UI PR is mergeable on its own: the shared files (sdk `src/common/transferHook.ts`, ui `src/utils/transferHook.ts` + token api + swap badge) are byte-identical across the pair. UI PRs still need an SDK version bump once a release containing #182/#183 exists.
**Why:** explicit user instructions during the 2026-10-11 session; the pairing invariant is invisible from any single branch.

## 0/20 rule mechanics (100x.broker -> STACCIndex raise)
No floor (MIN_SHARE_LAMPORTS = 1). UP/DOWN exits use the user's realized gain from the feed (n=200 basis); vault unparks use the vault's lifetime yield, by the user's choice, not the user's entry. On unvault the 0/20 leg is its own 3rd transaction because tx2 exceeded 1232 bytes. The tally (/api/backed) detects the memo tag "100x.broker 0/20" or a Jupiter swap in the same tx as the fund ix. Markets listed after the hook upgrade have 6 ExtraAccountMetaList entries (oracle pool); older ones 5, so the client reads the list from chain.
**Why:** each of these was a silent-skip bug the user had to catch on chain; the oracle-pool extra caused 0xa261c2c0 on unpark.

## Vault hedge haircut (why USO vault showed −1.33% hedge drag)
The keeper bought DOWN hedges on the curve at any price; the vault marks them at pot value after the 4% fee. On a crowded DOWN book (UP pot ~$0.30 vs DOWN $31) that is an instant haircut per nudge, larger than a day of LP fees (24%/yr on $58 ≈ 4¢/day). Guard added 2026-10-12: HEDGE_MAX_HAIRCUT_BPS (default 2500) skips the buy and the deploy stays parked. Vault fee income only beats the 8% round trip at real volume; the hedge is a cost center until the UP pot exists.
**Why:** the user asked "how is it not earning"; the numbers on the vault page say the fee leg is fine and tiny, the hedge leg is the loss.

## The "owed" trap on 100x.broker markets
A side whose `owed` ≈ 1 has its curve marked to be drained into the other pot at the next settle; a fresh buy there is settled away almost immediately (two 0.02 SOL clips on 2026-10-12 went to ~0 within minutes). Pot ratio alone is not the empty-side signal: use pot + curve reserve, and never enter a side with owed above ~0.1. /api/arena?list=1 now exposes curve_rfstacc, owed, at_floor per side.
**Why:** the bot's first live pass donated to USDC DOWN and PUMP UP before this guard existed.

## Winner feed
/winners + /api/winners. Baseline api/_data/winners.json comes from `bun tools/winners-build.ts` (needs HELIUS_RPC_URL; FluxRPC returns no history). The endpoint folds in new txs per request (400 per account cap) and caches per instance; rebuild the baseline before deploys when it is days old or the first request will be slow.
**Why:** 8k txs all-time is too many to scan per request on Vercel.

## 24h race on /winners (2026-10-12): round 1 = 2026-10-12 23:00 ET → 2026-10-13 23:00 ET (03:00Z), 4/2/1 SOL to 1st/2nd/3rd (7 SOL pot)
`/api/winners` → `race` (`ROUNDS` in `app/api/winners.ts`, edited by hand per round): net realized SOL per wallet in the window (wins minus losses, exits + unparks, r-fstacc at the current rate), ties to the earlier finisher, any actor except `botAddresses()` (keeper + vault PDAs). Losses are now recorded too (`WinState.losses`, kept 8 days). The prize is paid by hand: before paying, re-run `HELIUS_RPC_URL=… bun tools/winners-build.ts` after the round ends and read the final board from that, because a serverless instance only folds ≤400 new sigs per account per pass and can miss trades on a busy market. The dev wallet `331nEB…` is NOT excluded. Referral fees count toward net (api/_lib/refs.ts: DepositSol where referral ≠ destination, ≠ DEV_ATA, ≠ funder, referrer not a bot); as of 2026-10-12 there are zero real referral payouts (all past ones were default/vault/router self-deposits).
**Why:** user's spec "agents and humans, any on-chain actor welcome"; net (not wins-only) so a wallet can't farm green exits while eating bigger red ones.
