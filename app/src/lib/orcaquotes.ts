// The "good quotes" an Orca launch can pair against, beyond $100XBRO (always first). Majors with Pyth feeds and deep Solana
// liquidity. Decimals and token program are read from chain by api/launch.ts, never trusted from here. The launch lookup table
// (scripts/orca-admin.mjs alt) lists these mints so a pool against any of them fits in one transaction.
export const QUOTE_100XBRO = "Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump";
export const GOOD_QUOTES: { mint: string; symbol: string }[] = [
  { mint: QUOTE_100XBRO, symbol: "100XBRO" },
  { mint: "So11111111111111111111111111111111111111112", symbol: "SOL" },
  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC" },
  { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT" },
  { mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", symbol: "JitoSOL" },
  { mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", symbol: "mSOL" },
  { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP" },
  { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK" },
  { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", symbol: "WIF" },
  { mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", symbol: "JTO" },
  { mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", symbol: "PYTH" },
  { mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", symbol: "RAY" },
  { mint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", symbol: "cbBTC" },
  { mint: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", symbol: "ETH" },
];
/** Accounts every Orca launch transaction touches but never invokes: kept in the launch lookup table. */
export const ORCA_STATIC = [
  "11111111111111111111111111111111", // system
  "SysvarRent111111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "3axbTs2z5GBy6usVbNVoqEgZMng3vZvMnAoX29BFfwhr", // Orca position metadata update authority
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];
