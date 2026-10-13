# nash.mjs — a Nash player on 100x.broker, written for volume

Same contract as `x100.mjs`: the API builds every transaction, your key signs it on your machine, nothing is custodied.

```bash
cd ~/x100 && curl -fsSLO https://100x.broker/cli/nash.mjs      # next to x100.mjs; needs: npm i @solana/web3.js
node nash.mjs                       # one pass, dry run — prints every decision and the reason
node nash.mjs --live                # one pass for real
node nash.mjs --live --loop 180     # every 3 minutes
```

## What a pass does, in order

1. **Exits.** Every position this script opened (or all of them with `--adopt`) is checked: side filled past `--target`,
   other pot drained under `--min-opp`, `--take` profit, `--stop` loss, `--hold-max`, or the `--hold-min` churn clock.
   Any hit → sell 100%, routed curve/pot by the API for the best exit.
2. **Empty side.** For each market on a deep oracle (the thin-oracle flag is a hard skip): find the smaller pot. If the
   gap is ≥ `--ratio` and the other pot is worth ≥ `--min-opp` SOL, size a clip and enter. The view is spot vs TWAP:
   the TWAP has to travel toward spot, so spot above TWAP favours UP. EV per SOL is printed with each decision:
   `p·f·theirs·share − (1−p)·f·ours − 8%`, with `f = 1 − (1+d)^−100` the fraction the losing pot pays on a move `d`.
3. **Park.** A vault only when its realized pace clears the 8% round trip over `--horizon` days times `--hurdle-mult`
   (defaults: 146%/yr simple). Otherwise it says why not. Unparks on a 5% receipt drawdown, a pace collapse, or a hedge
   stuck outside its band.
4. **Keeper.** Pokes pending pot transfers, settles owed curves, claims fees — up to `--keeper-max` per pass, markets
   this wallet holds first. Permissionless, lamports each, and it is what makes a winning side get paid.
5. **Creator** (`--create`). Birdeye trending by 24h volume → first coin with a deep SOL CLMM pool (≥ $100k, oracle
   live) and no market yet → `create-market` (4 txs), `create-vault`, then `--seed` SOL on each side. Budgeted by
   `--create-budget` per day. Needs `BIRDEYE_KEY` or `~/birdeye.key`.

## Volume mode (default) vs strict Nash (`--no-volume`)

By default the script is written to **maximize volume**: it takes the empty side at full `--clip` even when that fills
the side, and churns after `--hold-min` so the next entry lands wherever the empty side is *then*. Fees are 4% in and
4% out; ~60% recycles into the pots, 30% buys and burns $100XBRO, 10% to the builder. You are paying that spread to
be the liquidity that keeps both sides alive.

`--no-volume` keeps the textbook sizing: never close the gap past `--target`, skip anything under the `--edge` EV
floor, and otherwise do nothing. On today's pot sizes that mostly means doing nothing — which is the correct answer.

## Flags

| flag | default | meaning |
|---|---|---|
| `--bank` | 1.0 | max SOL at risk across all seats (only what this script opened counts, unless `--adopt`) |
| `--clip` | 0.02 | SOL per entry |
| `--max-pos` | 0.08 | SOL per market side |
| `--ratio` / `--target` | 2 / 1.5 | min pot gap to enter / gap to keep after entry (strict mode) |
| `--min-opp` | 0.001 | smallest other pot worth fighting for |
| `--edge` | 0.05 | min EV per SOL (strict mode) |
| `--hold-min` / `--hold-max` | 25 / 720 | minutes: churn clock / hard exit |
| `--take` / `--stop` | 0.5 / 0.6 | fractions of entry |
| `--park` / `--horizon` / `--hurdle-mult` | 0.2 / 30 / 1.5 | vault clip, days to clear fees, safety multiple |
| `--keeper-max` / `--no-keeper` | 8 | keeper txs per pass |
| `--create` / `--create-budget` / `--seed` | off / 0.3 / 0.01 | listing seat |
| `--adopt` | off | manage positions and parks this script did not open |

Env: `NASH_KEY` (default `~/.x100/arena.json`), `NASH_API`, `NASH_RPC` (any Solana RPC; default the site's proxy),
`BIRDEYE_KEY`. State in `nash-state.json` and a log in `nash.log` next to the key.

## What it never does

Join the crowded side. Hold a crowded bag through adverse ticks (the churn clock and the compression exit see to it).
Park where the pace does not clear the fees. Touch a thin oracle. Trade from anything but your own key.
