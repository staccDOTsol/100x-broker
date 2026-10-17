# 2-observation TWAP on every venue: program spec

Status: spec (2026-10-16). Implemented but **not deployed**: "2-obs markets never sample" (section below), which covers the
kind-0 part of step 1 and the refusals in step 5. The venue accumulators for kinds 2 and 4 are still spec. Owner's rule: a market's TWAP spans at most 2 observations. The only job of
the TWAP is to defeat atomic price pushes, meaning a push and revert inside one transaction or one Jito bundle.

## What exists today

`window_secs` is fixed per market (it is in the PDA seeds). A rebalance reads one of two ways:

- **Ring read** (kind 0 with a live Raydium CLMM ring): `end` = the ring's newest stored observation. `start` = the newest
  ring point or checkpoint at or before `end.ts − window_secs`. Raydium writes an observation during a swap using the tick
  from *before* the swap, and skips the write when no time has passed. A push and revert in one bundle therefore leaves no
  trace. **With `window_secs = 1` this is already a true 2-obs read: `start` is the previous ring point.** New markets on
  live rings now default to 1 (`defaultWindowSecs` in `app/src/lib/chain.ts`, `scripts/create-market.ts`).
- **Sampled read** (kinds 1–4, and kind 0 once its ring has been silent for `RING_STALE_SECS`): `sampled_end` = the newest
  point extended by **the pool's live tick × elapsed**. That live tick can be set by an earlier instruction in the same
  transaction.

### Exposure on the sampled read today, before any window change

The live tick's weight in the TWAP is `elapsed / (end.ts − start.ts)`, where `elapsed` is the time since the newest stored
point. Checkpoints are written at most every 150 s, so `elapsed` reaches 150 s on a busy market and more on a quiet one.

Attack, all in one bundle: push the pool, `poke` (the rebalance pays the losing pot), `redeem` the winning side, revert.

| live-tick weight | push | TWAP move | losing pot paid at 100× |
|---|---|---|---|
| 150 / 3960 = 3.8 % | 10 % (953 ticks) | 36 ticks | 30 % |
| 150 / 3960 = 3.8 % | 50 % | 154 ticks | 79 % |
| 1000 / 3960 = 25 % (quiet market) | 10 % | 238 ticks | 91 % |
| `window_secs = 1`: 100 % | 1 % | 100 ticks | 63 % |

The push costs about two swap fees on the size needed to move the pool, because the revert recovers the slippage. A 10 %
push on a constant-product pool takes about 4.9 % of the quote reserve, so with 50 SOL of quote the attack costs about
0.012 SOL. Kinds 1 and 2 price from raw vault balances, so a plain token transfer into a vault also moves the price, at the
cost of the amount donated.

None of the 12 live markets is kind 1–4 today. The router (`api/_lib/legs.ts`) and `/new` list on any venue, so new
listings on PumpSwap, CPMM or Meteora pools are exposed from their first block.

On kind 0 the table needs a ring that does **not** record the push. A Raydium swap that moves the tick stores an observation
first (pre-swap tick, at most one per 15 s), so after an hour of silence the push itself makes the ring fresh and the poke
reads the ring. This was checked on a fork of the deployed program on 2026-10-16: WBTC ring stale for 4340 s, then a
2 SOL push swap and a poke in one tx. The ring wrote in that tx, the TWAP took the pre-swap tick, and the push moved it 0 ticks.
The sampled read is reachable on kind 0 only when the pool's tick moves while its ring stays silent (a dead ring).

### Why "end at the newest stored checkpoint" is not enough on its own

Today a checkpoint is written from the same sample (`sample()` → `push_ckpt(end)`), so the live tick is already baked in.
Reading it one call later delays the attack by one call but does not stop it. Sampling the current price can never be
bundle-safe: the program sees one instant, and the attacker owns that instant. The safe source is an accumulator **the
venue writes itself**, using the price from before each trade.

## Venue accumulators

| kind | venue | accumulator | consistent newest point | 2-obs safe |
|---|---|---|---|---|
| 0 | Raydium CLMM | `ObservationState` ring, `tick_cumulative`, at most one write per 15 s | ring[index] `(block_timestamp, tick_cumulative)` | yes, while the ring records |
| 2 | Raydium CPMM | `ObservationState` at `PoolState.observation_key`: 100 × `{block_timestamp u64, cumulative_token_0_price_x32 u128, cumulative_token_1_price_x32 u128}`, then `last_update_timestamp u64` | `(last_update_timestamp, observations[observation_index].cumulative_token_0_price_x32)` | yes (source-verified) |
| 4 | Meteora DLMM | `Oracle` at `LbPair.oracle`: samples `{cumulative_active_bin_id i128, created_at u64, last_updated_at u64}` | newest sample `(last_updated_at, cumulative_active_bin_id)` | likely; one fact unverified (below) |
| 1 | PumpSwap | none (`(quote_vault + virtual_quote) / base_vault`) | none | **no** |
| 3 | Meteora DAMM v2 | none (`sqrt_price`) | none | **no** |

**CPMM**, verified against raydium-cp-swap `states/oracle.rs`, `states/pool.rs` and `instructions/swap_base_input.rs`:
- `get_swap_params` prices the pool from the fee-free vault amounts before the swap: `token_0_price_x32 = token1 × 2^32 /
  token0`. That is token1 per token0, the program's tick convention.
- `observation_state.update(now, price)` runs after the transfers but with that pre-swap price. It adds
  `price × (now − last_update_timestamp)` and returns early when `now − last_update_timestamp == 0`.
- Landmine: within 15 s of an observation's creation the cumulative is updated in place but its `block_timestamp` is not.
  The only consistent pair is `(last_update_timestamp, observations[observation_index].cumulative)`. Older entries pair
  an updated cumulative with their creation time, so never read them.
- The cumulative is u128 with wrapping overflow ("the remaining 64 bits are used to store overflow data"). Take differences
  with `wrapping_sub` on the low 64 bits. They are exact while one interval's `price_x32 × dt < 2^64`.

**DLMM**: the layout comes from dlmm-sdk `ts-client/src/dlmm/helpers/oracle/wrapper.ts` (32-byte header, then 32-byte
samples). The SDK repo has no program source, so one fact is unverified: does a swap integrate the active bin from
**before** the swap? The SDK extrapolates the newest sample with the current `active_id` when it reads, and the program
must never do that. A fork test is required before kind 4 gets 2-obs: run push → poke → revert in one transaction and
check that the cumulative shows zero seconds at the pushed bin.

## Program change

A market is in **2-obs mode** when `window_secs < CKPT_SPACING_SECS` (150). Markets at 600 s or more keep today's code
path unchanged, which covers all 12 live markets. No migration is needed, because `window_secs` is in the seeds.

In 2-obs mode, `rebalance` reads like this:

1. `end` = the venue's newest consistent point from the table above. There is **no live-tick extension in any branch**.
   - kind 0: `oracle::latest(ring)`. A stale ring means **no move**. Remove the sampling fallback for 2-obs markets.
   - kind 2: read `PoolState.observation_key` from the pool. Check the observation account's owner and `pool_id`, then read
     `last_update_timestamp` and the price cumulative at `observation_index`.
   - kind 4: read `LbPair.oracle` and check its owner. Take the newest sample by `last_updated_at`.
     `tick_cumulative = cumulative_active_bin_id × log_1.0001(1 + bin_step / 10^4)`, computed like `venue::pool_tick`.
   - kinds 1, 3: unreachable, because `create_market` rejects them (below).
2. `if end.ts <= m.last_obs_ts { return }` stays as it is. The TWAP only moves when the venue has written a new point.
3. `start` = the previous point this market consumed. Store it on **every** rebalance with a variant of `push_ckpt` that
   skips the 150 s spacing. With `window_secs = 1`, `window_start` then returns exactly that point.
4. TWAP:
   - kinds 0 and 4: `twap_q32(start, end)` as today.
   - kind 2: mean price `(end.cum − start.cum) / (end.ts − start.ts)` in Q32, then tick = `log_1.0001` of it using
     `venue::log2_q64`. Kind-2 checkpoints in 2-obs mode hold the **price** cumulative's low 64 bits in `tick_cumulative`.
     Document this on `Ckpt`; it is only valid because a market never changes mode.
5. `create_market`: allow 2-obs mode only for kinds 0, 2 and 4. Reject kind 0 when the ring is stale at creation, and
   reject kinds 1 and 3 outright. Seed `last_obs_ts`, `last_twap_q32` and the first checkpoint from the venue's point
   (for kind 2 a TWAP needs two points: seed the checkpoint, and set the TWAP from the first interval on the next read).
6. Account lists: kind 2 needs the CPMM observation account and kind 4 the DLMM oracle account. Both go in the market's
   ExtraAccountMetaList and in the optional trailing accounts of poke, redeem and settle_begin, the same way the oracle
   pool was added (`EXTRA_METAS`).

### Implemented: 2-obs markets never sample (2026-10-16, not deployed)

`oracle::is_two_obs(window_secs)` is `window_secs < CKPT_SPACING_SECS`. `oracle::samples(ring, m, now)` is the one routing
test, used by both `rebalance` and `create_market`: sample only when the ring is stale **and** the market is not 2-obs.

- `rebalance`, kind 0, 2-obs: always the ring read, whether or not the pool is passed or the ring is stale. A stale ring
  returns the point already consumed, so `end.ts <= last_obs_ts` and nothing moves. No sample is taken and no checkpoint is
  pushed. The first new stored observation is consumed as usual, and the whole move since the last one settles in one step.
- `rebalance`, kinds 1–4, 2-obs: no move. `create_market` refuses these markets, and none exist on chain.
- `create_market`, 2-obs: kinds 1–4 and a stale kind-0 ring fail with `TwoObsNeedsLiveRing` (0x1022). The check runs
  before any account is created.
- Markets with a window of 150 s or more: unchanged, and they still sample dead rings.
- Tests: `oracle.rs` `two_obs_boundary` and `two_obs_stale_ring_waits_for_the_ring`; fork e2e `scripts/e2e-2obs-stale.ts`.

## Off-chain mirrors (same change)

- `twapNow` / `sampledTwapQ32` in `app/src/lib/chain.ts`, `api/_lib/og.ts` and `scripts/keeper.ts`: a 2-obs read for
  previews, what-ifs and OG sparklines.
- `defaultWindowSecs`: return 1 for kinds 2 and 4 once the upgrade is live.
- `/new`: enable the "2 obs" chip for those venues. Router: no change beyond the helper.
- Keeper: a poke on a 2-obs market moves funds only when the venue wrote a new point, so sampled markets no longer need
  the 150 s "sample" pokes.

## Tests

- `oracle.rs` unit tests:
  - CPMM: an in-place update within 15 s must read `(last_update_timestamp, cum)`, never `(block_timestamp, cum)`.
  - CPMM: wrapping across 2^64.
  - DLMM: cumulative → ticks for bin steps 1, 25 and 100.
  - Kind 0: a stale ring in 2-obs mode means no move. (done: `two_obs_stale_ring_waits_for_the_ring`)
- Fork e2e for each of kinds 0, 2 and 4: a bundle of swap push → poke → redeem → swap revert must transfer 0. On kind 4
  this is the fork test that settles the open DLMM question.
- `create_market` rejects kinds 1 and 3, and a stale kind-0 ring, when `window_secs < 150`.

## Deploy

1. Program upgrade with `scripts/deploy-mainnet.sh`; the owner runs it, extending by ≥ 10240 bytes if the binary grows.
2. Republish the IDL with the new accounts.
3. Then flip `defaultWindowSecs` for kinds 2 and 4.

## Owner decision: PumpSwap and DAMM v2

These venues keep no price history, so no 2-obs read on them can be atomic-safe. Options:

1. Stop listing on them. The router and `/new` use the best CPMM, CLMM or DLMM pool for the coin, or refuse when none exists.
2. Keep listing with a long window. This leaves the exposure in the table above.
3. Create a Raydium CLMM pool for the coin (arena `create-pool` + `seed-pool`) and use it as the oracle. That is
   atomic-safe, but a thin new pool is cheap to hold off across slots.
