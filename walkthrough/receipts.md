# 100x.broker walkthrough receipts (local mainnet fork)

| scene | action | result | signature |
|---|---|---|---|
| swap | swap 0.25 SOL → USDC: Swap | ok | `YjUW86o1XPLjxNLZiJJecJbSDD7MbmZjrhzNCfPrSbg1jEncbRofMPTXBgyE2yb7AbsdeDuEAxH7XtpbwwV8nMK` |
| swap | swap 0.25 SOL → USDC: 100× UP $USD Coin (long USD Coin + short SOL) | ok | `63jV8wgZGfPAXZiov4ryW14kAhJ47xYr7c56fykDtWyRcSdWFfYdGAyJt4121YP9FbbaADhyV8QjQnGs2snQS5Xr` |
| market | ape UP $PUMP 0.05 SOL | ok | `2GHmmLrmqgjeZpxd4VTDaBbX6A9cvdkS6fu9QnLZYoCr3JwjEMA79n9xPyK42fL8JCrQ85AN4jrbBdQgZGVWyTaT` |
| market | sell 50% UP $PUMP | ok | `5xWbMKs1z2GkMPovdC17CYEZcVZ3r62tZXsUYSgQGYQqQRVtuVKTtEu4tTcrXk8bJfqECPAgu42MkFrBc1RSBfmK` |
| wrap | wrap PUMPUP → SPL twin | ok | `3D84kDSk2VZFmiWSyD7vjaXFbdoyq7nUWsy4VkEvUz1Yzt6Cke66WHynam8RKYx1is7XVgX1rYPhh9WtwVPc8SoH` |
| wrap | unwrap twin → PUMPUP | ok | `3eoY1sd9R5fDwJcZ9dDa35ev6v96dPXYusuoTxrM71f96vVmLUnjF5ihd2U8U5zZswhMrsaNTLZH7dNhkTQ1soFs` |
| yield | park 0.2 SOL in $PUMP vault: Park SOL, mint receipts | ok | `2c2GJhtQDvHxtY3xWneBpKPayvLCriCK3YUWduP1WDYrLjDFhKXEC26i5VvCSYvTpGm9RXoPxnv3mhKoNS7bwjvB` |
| yield | unpark 100% of $PUMP vault: Unpark in kind | ok | `4XKEG447Yw9f3LQY8mnc7hzckjiQWCPteFAGKzCRjey2xi9zcb8Rj9i5YFHXhRVzjaari5j34eQKYEWRsjuZVxbx` |
| yield | unpark 100% of $PUMP vault: Turn it all back into SOL | ok | `5KRrhBXZftLwoNzmqq4YsW1eMgnCiXidwWNKGvEUjojYjinoU3QdYHzzSjgEjWRWbjGnsZz3U1KLTDMCDwBvyEnp` |
| yield | unpark 100% of $PUMP vault: 0/20 → STACCIndex (0.35 USDC) | ok | `3t3geNazcrHQXvpQUJYZXVJNJwCnvVK3TH23wefUKfYv6awWHyEjHBWQhLr2eqKh9GbCnk3kTvsBHaLvLt1vr8NK` |
| swapbag | sell UP $USD Coin from the swap bag | ok | `3gbYVHk6wtc5g9EsZr7ryXD8qFV2xMvyaAvqwdQjfAQPvZe2Yg6a2ZrRuNoSJhPSVc6nt93QEGa8wfq5rBiKNGq5` |
| list | list $BONK: Curve config | ok | `64zHNJLtZJgv7WFMS8kYga5be4SivRqodgMUPtE4bNkdQMaKv1sKLggfLCiBkdX4m7nBEa9MpBbpAL6WJinJcZvS` |
| list | list $BONK: UP curve | ok | `3BzbJXbTtDy5aqMgZhgVBzbJkckqRrSFuh8ZcHy2cZ14dEpMe6WQtwZp9BRFUqRDNo4YpTs9q33zBLo6N21ZDJuu` |
| list | list $BONK: DOWN curve | ok | `kkBU9Ws9DfELFsgeFNMaYe65LCedDHn8cdYYbNd32JxFCXaat7fSRSLU3rm3cT3SWSVMWxKofaRjveUt9yUU69Z` |
| list | list $BONK: Market + vaults | ok | `5hPsbVMGZaK54nAcMY9chr2USXMFYbqq2TavaDTpiN8MSJMkLKbXtKPGqj7SNd6oqittTPFG8CCaEU4FgET3r8nH` |
