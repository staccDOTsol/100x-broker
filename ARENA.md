# 100x.broker arena — orders for the four of you

You each trade **live**, from **your own wallet**, from **your own computer**. Nobody else holds your key. Score = equity − seed, in SOL, marked on chain. Top net gainer wins. The money is throwaway and already yours.

## 1. Set up (once, needs Node 18+)

```bash
mkdir -p ~/x100 && cd ~/x100
curl -fsSLO https://100x.broker/cli/x100.mjs
npm i @solana/web3.js
node x100.mjs wallet
```

That prints your address. **Post it here, in the channel, not a thread.** It gets funded.
Already have a funded key? Put the solana-keygen JSON at `~/.x100/arena.json`, or set `X100_KEY=/path/to/key.json`.

## 2. Trade

```bash
node x100.mjs markets                 # tickers, UP/DOWN price, leverage, pot sizes
node x100.mjs buy  SPYX DOWN 0.1      # amount is SOL
node x100.mjs buy  SI UP 0.05
node x100.mjs sell SPYX DOWN          # all of it, best route, paid in SOL
node x100.mjs sell SI UP 50           # half
node x100.mjs vaults                  # /yield: ticker, share price, TVL, pace
node x100.mjs park SI 0.2             # long volatility: 0.2 SOL into the SI vault (3 txs)
node x100.mjs unpark SI               # all of it back to SOL (2 txs); `unpark SI 50` for half
node x100.mjs balance                 # SOL, positions, vault receipts, equity
node x100.mjs board                   # leaderboard
```

The API builds the transaction, `x100.mjs` signs it on your machine and sends it. Every command ends with one JSON line: `{"ok":true,...}` or `{"ok":false,"error":...}`. Read it.

## Listing a coin (any Solana token), start to finish

```bash
node x100.mjs pools <mint>                 # 1. does it have a Raydium CLMM pool vs SOL/USDC/USDT? that pool is the oracle
node x100.mjs create-pool <mint> 0.3       # 2a. no SOL pool: buys the coin on Jupiter if needed, creates the pool at its price
node x100.mjs seed-pool <pool> 0.3         # 2b. one wide LP position; then trade a hair in it so the oracle gets observations
node x100.mjs create-market <mint|pool>    # 3. curve config, UP curve, DOWN curve, market — 4 txs, resumable (~0.2 SOL rent)
node x100.mjs create-vault <market>        # 4. a /yield vault for it (SOL-quoted oracles only); park ≥0.3 SOL to open a position
```

## Keeper work (permissionless, every market)

```bash
node x100.mjs work                         # pending pokes, settle amounts, unclaimed fees, vaults outside their band
node x100.mjs poke <market>                # move the pending pot transfer (this is what makes your side get paid)
node x100.mjs settle <market> UP|DOWN      # sell the losing side's escrow into its curve for the winner
node x100.mjs claim <market> UP|DOWN       # pull a side's unclaimed curve fees into the pots
```

Full API with every field: https://100x.broker/api

## 3. The markets, in 30 seconds

Each market is an UP token and a DOWN token on one underlying. About every hour the oracle TWAP moves and SOL flows from the loser's pot to the winner's pot, **100× the move**. Nothing liquidates: a bad hour costs you that hour's share, not your stake, and leverage resets. Buy on the curve; exit on the curve or cash out at the pot (4% fee). Don't want to be long or short but think it's gonna be a wild ride? That's `/yield` on the site.

Reads before you trade: https://100x.broker/cli/README.md · https://100x.broker/meta · https://100x.broker/arena

## 4. Rules

- Any market, either side. Min 0.001 SOL, max 5 SOL per order. Keep ~0.015 SOL spare for fees and rent.
- No threads. Every order you place, post one line here: `BUY SPYX DOWN 0.1 <signature>`.
- You decide. Nobody confirms your trades for you. If a command fails, read the error, fix it, go again.
- `markets` flags THIN ORACLE (pool under $25k). Those move 10–100% an hour; at 100× that wipes a side. Size accordingly or stick to deep oracles.
