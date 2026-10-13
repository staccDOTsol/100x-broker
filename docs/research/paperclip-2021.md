# Perpetual Pools R&D, 2021 — rundown, provenance, goldmine, who's who

## 1. Rundown

Tracer DAO (built by Lion's Mane → Mycelium, Brisbane) designed **Perpetual Pools** in mid-2021: two tokenised pools, long and short, with a value transfer between them on every oracle update, no margin, no liquidation. The core problem they hit was *volatility decay* (they argued it was really a *dilution* problem). From 21 Jul to 25 Oct 2021 the `#paperclip` Discord channel was the external R&D room with **Paperclip**, a side-VC/quant shop staffed by people whose day jobs were at **FTX**. No FTX cheque is documented, but FTX talent spending its off-hours on your mechanism is the classic "we didn't invest, but this is in our top prios" tell: treat FTX as a de facto strategic backer, cap table or not. Paperclip built the Python/Colab sim; Tracer's two-person R&D team (Lachlan Webb, Ryan Garner) plus Jarett (hired 20 Jul 2021 as the R&D-to-dev bridge) fed it data and argued the mechanism. The channel ends with the decision to ship the base protocol *without* a decay fix and "let someone else come in and build in a solution to vol decay on top." Pools launched on Arbitrum; v2 shipped Aug 2022; Tracer merged into Mycelium Aug 2022; Mycelium wound down Oct 2023.

**What this means for us.** 100x.broker's UP/DOWN pots with a TWAP oracle are a pool swap with the TWAP fix Ryan proposed on 4 Aug 2021. dnvault `/yield` is the "dual-hold farmer" they modelled, and the Yearn-vault idea in Lachlan's July 2021 doc, verbatim. Our 10 % entry fee is their mint fee; their own math says it boxes the secondary price between the pot and the curve. Jarett's "two pools… it's literally tracer on solana" message to Lachlan (19 Apr 2022) is the origin receipt.

## 2. Provenance

| Source | What | Where |
|---|---|---|
| Discord `#paperclip` (guild 808906099172442122, channel 867562813865197579) | 399 msgs, 2021-07-21 → 2021-10-25, 11 authors; 29 attachments (ETH/LTC csvs, sim charts) | `~/Desktop/paperclip.json` + `paperclip.json_Files/` (DiscordChatExporter 2.48.0) |
| TG "Lachlan Webb (LordSoprano)" | 702 msgs, 2021-07-10 → 2022-11-25 | Drive `tg/Lachlan.txt`, `chat_1705/messages.html` |
| TG "0xsol/soma/whatever" | 443 msgs, 1–6 May 2022 | Drive `tg/0xsol_soma_whatever.txt`, `chat_1749/messages.html` |
| TG "CMM", "Steve", "Bullish on Redacted Princes", "Crypto Trader" | 2020–2022 | Drive `chat_1323`, `chat_0662`, `chat_1738`, `chat_1815` |
| "Tracer <> Paperclip: Agenda/To-do List (29 June)" | Lachlan's brief to Paperclip | gdoc `1gbcbpZMSA4d4and5zVqiiDHJwPoHDVroev-80O12YPM` |
| "Suggested Mint/Burn Fee rate to mitigate Volatility Decay" | fee table | gsheet `1NhRF5gX4Oqd8DtkOxzp1rriNculsfD8ohVcjgtLjMzc` |
| "Leverage Decay Problem" (Lachlan, 2021-07-14) | dilution example + 3 solutions | gdoc `1mg81fCK6iQWlB65pu8t2ALeLNWuzQflLsQsFKtkEPDY` |
| "Volatility Decay – Solutions" (Jack \| Pier Two, 2021-07-16) | 3 allocation options, Jarett's + Paperclip's comments | gdoc `1yJrA2pfx4f6kVV2pK-V7R7_7_G7usmS73o9UU3dA87I` |
| "Pool Swaps and Derivative Theory" (Ryan Garner) | the whitepaper | Drive docx `1hXNWP0goP-F1sIwa1uc1AIdiFlejb9bR` |
| Price-data sheet (Jarett, ccxt pulls) | ETH/LTC 1 h / 4 h buckets | gsheet `1i9jowA0OgHgJ4ck3SAAK91qxgDSuw2h6rzrBqOP5tfg` |
| Colab sims | imdimsim `1Z83hrwlLrdGJLHxc9ZCgOCnVKq79mhTb`, JD `1cua-3fk7Z7ViYXgnBcZYxFBAFRJEwahI` | need Google auth |
| Notion (tracerdao): Rebalancing-Rate, Optimizing-Burn-Fee, Argument-for-Yield-Bearing-Collateral, Paperclip-Call-22-07-21; mycelium-eth Leverage-Decay; tracerdao Volatility-Decay-Documentation | now empty shells | — |
| Public | Stockhead / Dealroom / Preqin (June 2021 raise); Blockworks (Hayes advises Mycelium Perp Swaps, Aug 2022); Delphi (Pools on Arbitrum) | links at bottom |

Dead ends: two sheets Lachlan linked (`1savJc…`, `1WbRO0…`) are no longer shared; Notion pages render empty; Colabs need auth. Zero mentions of Hayes/BitMEX/Arthur in `#paperclip`; the string "FTX" appears there only as a backtest data source and one Alameda aside, because the FTX people in the room were posting as Paperclip.

## 3. Goldmine (quotes, chronological by theme)

### 3.1 The fee that cancels volatility decay
> **ryangarner · 2021-07-23** — "the more often the agreement is executed, the less of a mint/burn fee is needed to counteract volatility decay. 0.3% for 15 mins / 0.77% for 1 hour / 1% for 4 hours … charge double the above fee but only apply it to burning: 0.6% … 15 mins / 1.54% … 1 hour / 2% … 4 hours"

> **ryangarner · 2021-07-23** — "When leverage is increased, the burn fee would need to increase almost linearly … a 5 power leverage token with execution every 15 mins would require a burn **only** fee of just under 3%"

> **imdimsim · 2021-07-22** — "With a Mint/Burn fee of 8% we get performance matching the naive expectation which (I think) is saying that this is the fee required to offset volatility decay."

> **Jarett → Lachlan, TG 2021-07-21** — "Appears to be proportional to leverage, akin to paying a fee equal to notional value. Also appears to be slightly less than proportional. 4 leverage would be 3.08 but is actually 2.875"

Fee sheet: 1p 0.77 % ETH / 0.73 % BTC · 2p 1.54 / 1.42 · 4p 2.88 / 2.65.

> **ryangarner · 2021-07-30** — "just having rebalance once per day even if there is high leverage … would only have volatility decay of like 5-10% per year per leverage."

### 3.2 Burn-only fee boxes the secondary price
> **ryangarner · 2021-07-23** — "if a token is expected to be redeemed at current prices for 100 DAI, and there is a 2% burn fee, then the token price will not trade lower than 0.98 because if it falls below this, there is risk free arbitrage … the pool tokens will trade between mint price and burn price at all times."

> **imdimsim · 2021-07-26** — "if we charge a fee on minting we would just bound the market price of the pool tokens to within the range of (MP − a, MP + a + fee) … If we charged on burning it would just be (MP − a − fee, MP + a)"

> **imdimsim · 2021-07-26** — "there's no barriers to come in, but barrier to go out, so there's a natural force for the TVL to grow over time"

### 3.3 Skew is funding
> **lordsoprano · 2021-07-22** — "the skew imbalance will be on a random walk with a mean of a 1.004 skew … Probably akin to perps, it will be fine that it drifts around this mean"

> **patrickm · 2021-07-27** — "We're trying to draw an analogy to the Perpetual Swap funding rate — Perpetual Pool rebalancing rate"

> **ryangarner · 2021-08-04** — "What skew leads to 10% per year lost solely to skew for a long holder? My simulations predict 0.4% at 1 leverage and 0.55% at 5 leverage."

### 3.4 "L + S = 2" — the fees-cover-decay test
> **imdimsim · 2021-07-28** — "at a certain point we are basically just charging people a higher than normal fee and it becomes very profitable to be in the pools. How profitable it is is basically the excess of what LONG + SHORT is greater than 2 by"

> **lordsoprano · 2021-07-28** — "When LONG+SHORT <2: volatility decay is not being adequately compensated for via fees; >2: overcompensated; =2: appropriately compensated. BUT, doesn't this mean that the maximum LONG or SHORT token can ever reach is 1.99999?"

> **ryangarner · 2021-07-28** — "Really there are only 2 options for our target [never any decay / on average cancel decay] … 2 options for method [fixed fee from sims / variable fee — complicated and its attack surface would be a risk]"

### 3.5 The delta-neutral farmer (this is /yield)
> **staccoverflow · 2021-07-22** — "if I can get it to work I might push forward with my idea about more fees = farmin' pools. Just to measure the kind of APY one might expect."

> **Lachlan's doc, 2021-07-14, "Solution 1: Yearn Vault Strategy"** — "it's zero sum, so the losses from the leverage have to go somewhere … i) deposit capital into a yearn vault ii) yearn vault buys both long and short tokens iii) when value transfer occurs, the yearn vault sells some of the winning token, and deposits it into the losing pool. iv) Then, repeat."

> **ryangarner · 2021-07-29** — "If literally all minting and burning activity were done by a group of people who always perfectly cancel out any price risk staying perfectly delta neutral … then 100% of the burn fee will be only paid by the delta neutral farmers, and they in turn will pass it on to the long traders via higher APR/skew."

> **ryangarner · 2021-07-29** — "if 50% of the burning activity is done by parties that require being delta neutral … then my prediction is that 50% of the volatility decay will get passed onto long traders in the form of APR."

> **imdimsim · 2021-07-29** — "the fees extracted from the fee payers have to go somewhere, which is what is supposed to offset volatility decay. By extracting fees from the system, it can't net in the same result as if there wasn't any fees paid."

> **imdimsim · 2021-08-02** — "the profit for the basis farmer will be a non-linear relation which depends on where you set the delta … set profit>0 then rearrange to get delta as a function of mint/burn fee"

> **lordsoprano · 2021-07-30** — "the seminal question now is 'how do we construct a mechanism that short-term traders pay to reimburse long-term traders, while also not disincentivising delta-neutral farmers'"

> **Alex | Mycelium (via Ryan) · 2021-07-29** — "would this not require delta neutral farmers to frequently rebalance, and thus incur the same mint/burn fees themselves? Has anyone checked to see whether it is actually possible to profit from a delta neutral position while incurring these fees?"

### 3.6 Where the fee goes
> **imdimsim · 2021-07-24** — "the protocol is basically extracting ~3% of the mint/burn volume to 'cover' the volatility decay losses … we can divert the fees extracted, solely for volatile periods where the price is choppy and long term holders are getting rekt."

> **imdimsim · 2021-07-24** — "at 3p leverage, 2m TVL and 3% Mint/Burn fee, the total volume of Mints/Burns are almost at $1b."

> **ryangarner · 2021-07-30** — "Minting any amount of either pool gives you a coupon good for 24 hours that gives you an exemption from burn fees up to that amount … 90% coupon … effectively extends the exemption to 10 days"

> **Ryan's doc** — fee destination should be "an ethereum address … composable"; or "an airdrop type system. Anyone can tell the contract they want their reimbursement, and the smart contract can easily look up how long they have held the token"

### 3.7 Frequency, gas, TVL
> **ryangarner (via lordsoprano) · 2021-07-24** — "10 AUD to upkeep the pools: @15 mins 350k/yr · @1 hour 88k/yr · @4 hours 22k/yr … @15 mins > 3.5 million TVL · @1 hour > 880,000 · @4 hours > 220,000"

> **lordsoprano · 2021-07-29** (spec) — "if an annual fee of 2% is desired, and an oracle price update and fund movement is triggered weekly, then the fee parameter set in the contract would be 0.02 / 52 = ~0.00038"

> **ryangarner · 2021-07-29** — "A high frequency of pool execution means more money needs to be collected in total per year to offset volatility decay. Since its divided over more intervals it seems smaller, but it is actually bigger."

### 3.8 TWAP not spot; heartbeat not price-trigger
> **ryangarner · 2021-08-04** — "In the existing time based simulations, it just used the price at the moment of execution. What if average of the time since last value transfer was used instead? … This should notably reduce VD because its smoothing the price."

> **ryangarner · 2021-08-03** — "Doing price move triggered execution will cause execution to be more frequent during highly volatile times … I predict volatility decay will be the same, and more likely higher with the price triggered execution"

> **ryangarner · 2021-08-03** — "the key tradeoff regarding number of executions per year is that reducing volatility decay increases the impact of leverage reduction during big moves."

> **imdimsim · 2021-08-01** — "volatility decay is a function of realised volatility (area under the graph of volatility) … do less frequent transfers (by time) and/or do them after the price has moved significantly … use a momentum value transfer function"

### 3.9 The decision
> **lordsoprano · 2021-08-01** — "it's fine to just build the base protocol without a solution to mitigate against dilution effect, and then just let the market price vol decay into their interactions w the protocol … let someone else come in and build in a solution to vol decay on top of our base layer."

> **Lachlan → Jarett, TG 2021-07-21** — "i'm still not clear we have 'volatility decay' in the sense that paperclip think we do; i think we have like a dilution problem"

> **imdimsim · 2021-07-29** — "map out the markets (primary, secondary, external) and the agents within these markets (arbitrageurs, market makers, basis farmers, traders, LPs)"

### 3.10 Ryan's whitepaper, the keepers
- Impossible trinity of derivatives: hard peg / no capital controls / rate control — pick two. Pool swaps sacrifice the peg.
- **Power leverage** `b = a·(y/x)^p` — "identical to the equity in a traditional leveraged portfolio that rebalances at every instant with no slippage"; times-leverage drifts to zero.
- **Polarized leverage**: bias gains vs losses instead of a funding rate; 0.4 % skew ≈ 11 % APR at 1×, 0.55 % ≈ 70 % at 5p.
- 20-minute pending pool to kill oracle front-running; "limit imbalance" orders instead of limit price.
- Deposit a yield token (aDAI at 11 %) and the skew cost nets to ~0 for longs, 22 % for shorts.

### 3.11 The 100x.broker origin
> **Jarett → Lachlan, TG 2022-04-19** — "og, it was an idea for lps and lending … then here I realized I needed two pools. lol … now I can't do it, it's literally tracer on solana … liquidity bonding curves, surely, and they're user-defined, it's permissionless. until this doc I don't think anyone has thought about tying two curves together oppositely —> two pools is tcr I'm doomed" · https://twitter.com/STACCart/status/1515888657068175361

> **Lachlan, TG 2022-08-15** (Pools v2 launch week) — "130% apr rn"

## 4. Who's who

| Handle | Who / role | Receipt |
|---|---|---|
| **imdimsim \| 📎** (115 msgs) | Paperclip. Side-VC + quant shop; day jobs at FTX. Built the Colab sim, wrote the agent-map plan. | Lachlan, TG 2021-07-16: "paperclip? — yep / some VC that invested in us / they have day jobs at FTX / and just do this on the side / they are so useful / not just random shit VCs / they're quick guys". Preqin lists "Paperclip Ventures" in the June 2021 round. twitter.com/paperclipdao. |
| **LordSoprano** = Lachlan Webb (72) | Tracer R&D lead. Wrote the agenda doc, the "Leverage Decay Problem" doc, the xls sims. | TG 2021-07-12: "myself and Ryan Garner are the RnD team." |
| **Ryan** = Ryan Garner (24) | The mechanism designer. Author of "Pool Swaps and Derivative Theory": power leverage, polarized leverage, burn-only fee, TWAP fix, coupon idea. | Lachlan: "Ryan is very creative, and can think of these great derivative designs" |
| **Patrick** (46, `Core Team`, Discord Admin) | Tracer/Mycelium founder. Ran the channel; v1 ships with an adjustable fee param; Zeta collab. | 2021-07-26: "we're collabing and chatting with [Zeta] atm – advising on some of our legal/DAO approach too" |
| **JD \| Mycelium** (70), **rogue dealer** (16) | Sims + historical data; forked imdimsim's script. | JD 2021-07-27: "run the entire collection of csvs through the simulation" |
| **Jack \| Pier Two** (2, Discord Admin) | Drafted the NDAs; owns "Volatility Decay – Solutions". Pier Two = Brisbane staking infra. | print_beastwood 2021-09-07: "thanks Jack" |
| **staccoverflow** = Jarett (33) | R&D↔dev bridge from 2021-07-20. ccxt price pipelines; "more fees = farmin' pools… measure the APY"; Option 1 comment in the VD doc. | TG 2021-07-12: "I think I'm onboard :) start 20th" |
| **print_beastwood** (16), **AJ** (4) | Outside connector + Tracer BD. Oct 2021: NDAs for outside quants, "my friends at Celsius … have a bunch of capital", "dinner … with one of the ex partners from 3AC". | 2021-10-24 |
| **Alex \| BFR / Alex \| Mycelium** (1) | Asked the DN-farmer-profitability question. | via Ryan 2021-07-29 |
| **Zeta Markets / Sam Trabucco** | Collab + legal/DAO advice; Trabucco "working with an options protocol called Zeta". | imdimsim 2021-07-26: "Him and Sam 1 basically make Alameda" |
| **Investors (public)** | Framework Ventures led (US$1M USDC), DACM, Apollo Capital, Maven 11; Preqin adds Distributed Global, Efficient Frontier, GSR, Paperclip Ventures, Supernova (unverified). | Stockhead / Dealroom / Preqin |
| **Arthur Hayes** | Public: advised Mycelium "on an ongoing basis" ahead of the Aug 2022 Perpetual **Swaps** launch (Blockworks). Not in the 2021 Pools R&D. | Blockworks |
| **FTX** | No cheque or press line documented. But Paperclip = FTX staff moonlighting, which is the classic "we didn't invest, but this is in our top prios" pattern. De facto strategic backer. Jarett's 2022-08-24 "backed by ftx and Hayes" line to Steve is the honest read of that. | Lachlan TG 2021-07-16; Preqin "Paperclip Ventures" |

Private: the Lachlan/0xsol TG files also contain two Aug 2022 / May 2022 lines touching an anonymous handle. They stay out of anything public.

## Sources
- https://stockhead.com.au/cryptocurrency/australias-tracer-dao-raises-us4-5-for-leveraged-trading-project
- https://app.dealroom.co/companies/tracer_dao
- https://www.preqin.com/data/profile/asset/tracer-dao/524749
- https://blockworks.com/news/bitmexs-arthur-hayes-advises-myceliums-perpetuals-launch
- https://members.delphidigital.io/reports/tracer-brings-perpetual-pools-to-arbitrum
