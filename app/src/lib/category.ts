// Asset categories — Memes · Majors · Stonks (stables and everything unclassified fall under All only).
// Dependency-free on purpose: the browser, api/*.ts and tools import this file alone. Nothing here guesses: every rule below is
// either a verified mint, a verified on-chain issuer invariant, a Jupiter tag read from the live API, or a launchpad vanity suffix.
//
// ---- Stonks: tokenized equities / ETFs. What was verified (Oct 2026), and how ----
// Jupiter Tokens API v2 (lite-api.jup.ag/tokens/v2) tags every tokenized stock `stocks` (+ an issuer tag). Issuer invariants were
// read straight off the mint accounts over RPC (Token-2022 mints, base layout + TLV extensions):
//   xStocks (Backed Finance)   1447 mints share  mint_authority 7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj,
//                              freeze_authority JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs and PermanentDelegate
//                              5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq (also the metadata-pointer / TokenMetadata update
//                              authority; metadata URIs on xstocks-metadata.backed.fi). Mints carry the vanity prefix `Xs`
//                              (TSLAx XsDoVf…, SPYx XsoCS1…, NVDAx Xsc9qv…, SPCXx Xs3oZw…); symbols end in a lowercase `x`.
//   Ondo Global Markets        449 mints share  mint_authority 9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD and
//                              freeze_authority 51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK (no permanent delegate; URIs on
//                              app.ondo.finance). Symbols end in `on` (TSLAon KeGv7b…ondo, SPCXon wzAyQT…ondo, DELLon cFDP5S…SLAon):
//                              the vanity suffix varies (`ondo` or the symbol), so only the authorities are structural.
//   PreStocks                  9 mints: mint_authority = freeze_authority = PermanentDelegate = WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc
//                              (URIs on prestocks.com; vanity prefix `Pre`: OPENAI PreweJY…, ANTHROPIC Pren1Fv…).
//   Backpack Securities        75 mints: a fresh mint_authority per token, but freeze_authority = PermanentDelegate = metadata
//                              authority = 2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a on every one checked (SPCX, MU, DJT).
//   Tessera                    3 mints share mint_authority EXvTtxurWBUNNCtLojaN8ZBJFNJPZFSH3szoih9hh7YW and freeze_authority
//                              7n2PNcDXVDMK2m8dyV9cVPNY7p4jM4ZMHv7TzfibEt8o (tOpenAI, tSpaceX, tKalshi).
//   Shift (leveraged stocks)   8 mints, a fresh authority per token: no structural invariant — Jupiter tag only.
// So the invariant is *who controls the mint*: mint_authority / freeze_authority / permanent delegate. `stonkIssuerOfMintAccount`
// reads those three fields off a raw mint account and matches them here; it cannot be faked by a copycat (a pump.fun "TSLAX"
// has no authority at all). Nothing is fetched at build time; the runtime fallback is the Jupiter tag lookup (api/_lib/category.ts).
// Note: Jupiter's documented `GET /tokens/v2/tag?query=stocks` answers 400 "Invalid tag provided" today (only `lst` and `verified`
// resolve); the `verified` list carries every token's tags, so the server reads `stocks` out of that.
//
// ---- Majors: a curated mint allowlist, every address resolved on Jupiter search (symbol → mint as it answered) ----
// ---- Stables: Jupiter's `stable` tag list, all 20 mints as returned ----
// ---- Memes: launchpad vanity suffix (pump / bonk / boop) or a Jupiter `meme` tag; nothing else, no market-cap thresholds ----

export type Category = "stonk" | "major" | "stable" | "meme" | "other";
/** The three the UI filters on; stables and `other` only ever show under All. */
export type Cat = "meme" | "major" | "stonk";
export const CATS: Cat[] = ["meme", "major", "stonk"];
export const CAT_LABEL: Record<Cat, string> = { meme: "Memes", major: "Majors", stonk: "Stonks" };
/** Lower-case plural for copy like "No stonks live". */
export const CAT_PLURAL: Record<Cat, string> = { meme: "memes", major: "majors", stonk: "stonks" };
export const parseCat = (s: string | null | undefined): Cat | null => (s === "meme" || s === "major" || s === "stonk" ? s : null);

/** Verified stablecoin mints (Jupiter tag `stable`, read live). */
export const STABLES: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": "USDG",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD",
  USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: "USD1",
  DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT: "USDe",
  JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD: "JupUSD",
  CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH: "CASH",
  "5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E": "hyUSD",
  HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr: "EURC",
  "6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG": "USX",
  USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: "USDS",
  "9ckR7pPPvyPadACDTzLwK2ZAEeUJ3qGSnzPs8bVaHrSy": "USDu",
  DUSDt4AeLZHWYmcXnVGYdgAzjtzU5mXUVnTMdnSzAttM: "DUSD",
  USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX: "USDH",
  "7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT": "UXD",
  "9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u": "FDUSD",
  AUSD1jCcCyPLybk1YnvPWsHQSrZ46dxwoMniN4N2UEB9: "AUSD",
  "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih": "wYLDS",
  EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o: "DAI",
};

/** Curated majors (mint → the symbol Jupiter resolves it to). Wrapped BTC/ETH/BNB, SOL and its LSTs, and the big Solana-native
 *  non-meme protocol tokens Jupiter marks `strict`/`verified` with `defi`/`infra` tags. Jupiter's own `major` tag (SOL, ETH, WBTC ×2,
 *  xBTC, zBTC, LBTC, zenBTC) and `lst` tag are also honoured at runtime when tags are available. */
export const MAJORS: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: "cbBTC", // Coinbase Wrapped BTC
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "WBTC", // Wrapped BTC (Portal)
  "5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ": "WBTC", // Wrapped BTC (Sollet), Jupiter `major`
  "6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU": "TBTC", // Threshold Bitcoin
  CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn: "xBTC", // OKX Wrapped BTC
  zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg: "zBTC",
  LBTCgU4b3wsFKsPwBn1rRZDx5DoFutM6RPiEt1TPDsY: "LBTC", // Lombard Staked BTC
  "9hX59xHHnaZXLU6quvm5uGY2iDiT3jczaReHy6A6TYKw": "zenBTC",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH", // Ether (Portal)
  "9gP2kCy3wA1ctvYWQk75guqXuHfrEomqydHLtcTCqiLa": "BNB", // Binance Coin (Portal)
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL",
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: "bSOL",
  jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v: "JupSOL",
  "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm": "INF",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY",
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: "JTO",
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: "PYTH",
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: "ORCA",
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: "RENDER",
  hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux: "HNT",
  "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ": "W",
};

export type StonkIssuer = {
  id: "xstocks" | "ondo" | "prestocks" | "backpack" | "tessera";
  name: string;
  /** Jupiter issuer tag. */
  tag: string;
  mintAuthority?: string;
  freezeAuthority?: string;
  permanentDelegate?: string;
  /** Vanity prefix on the mint address, when the issuer uses one. */
  mintPrefix?: string;
  /** Brand string the issuer puts in every TokenMetadata `name`. */
  nameMark: RegExp;
};
export const STONK_ISSUERS: StonkIssuer[] = [
  {
    id: "xstocks", name: "xStocks (Backed)", tag: "xstocks",
    mintAuthority: "7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj", freezeAuthority: "JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs", permanentDelegate: "5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq",
    mintPrefix: "Xs", nameMark: /\bxstock\b/i,
  },
  {
    id: "ondo", name: "Ondo Global Markets", tag: "ondo",
    mintAuthority: "9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD", freezeAuthority: "51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK",
    nameMark: /\(ondo tokenized\)/i,
  },
  {
    id: "prestocks", name: "PreStocks", tag: "prestocks",
    mintAuthority: "WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc", freezeAuthority: "WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc", permanentDelegate: "WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc",
    mintPrefix: "Pre", nameMark: /\bprestocks\b/i,
  },
  {
    id: "backpack", name: "Backpack Securities", tag: "backpack",
    freezeAuthority: "2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a", permanentDelegate: "2cVYpagTt7ZGc3mmTXBa7fAznUtx5DUu6aCq8uVDaf4a",
    nameMark: /backpack securities/i,
  },
  {
    id: "tessera", name: "Tessera", tag: "tessera",
    mintAuthority: "EXvTtxurWBUNNCtLojaN8ZBJFNJPZFSH3szoih9hh7YW", freezeAuthority: "7n2PNcDXVDMK2m8dyV9cVPNY7p4jM4ZMHv7TzfibEt8o",
    nameMark: /^T-[A-Z]/, // T-OpenAI, T-SpaceX, T-Kalshi; only trusted together with the authorities or the Jupiter tag
  },
];
/** Jupiter tags that mean "tokenized stock": the generic one plus every issuer's own. */
export const STONK_TAGS = new Set(["stocks", "equities", "shift", ...STONK_ISSUERS.map((i) => i.tag)]);
const MAJOR_TAGS = new Set(["major", "lst"]);
const MEME_SUFFIX = /(pump|bonk|boop)$/;

export type TokenLike = { mint: string; symbol?: string | null; name?: string | null; tags?: readonly string[] | null };

/** Category from what is known about a token. Mint-only calls classify from the allowlists and launchpad suffixes; pass the
 *  Jupiter `tags` and the on-chain metadata `name` when you have them for the rest. Unknown → `other`, never a guess. */
export function categoryOf(t: TokenLike): Category {
  const mint = t.mint;
  if (STABLES[mint]) return "stable";
  if (MAJORS[mint]) return "major";
  const tags = t.tags ?? [];
  if (tags.includes("stable")) return "stable";
  if (tags.some((g) => STONK_TAGS.has(g))) return "stonk";
  if (tags.some((g) => MAJOR_TAGS.has(g))) return "major";
  if (MEME_SUFFIX.test(mint)) return "meme";
  if (tags.some((g) => g === "meme" || g.startsWith("pump") || g.startsWith("bonk") || g.startsWith("boop"))) return "meme";
  if (issuerByName(t)) return "stonk";
  return "other";
}

/** An issuer whose brand mark is in the token's on-chain name — and whose vanity prefix, when it has one, is on the mint.
 *  Tessera's `T-` mark is too generic to count on its own. */
export function issuerByName(t: TokenLike): StonkIssuer | null {
  const name = t.name ?? "";
  if (!name) return null;
  for (const i of STONK_ISSUERS) {
    if (i.id === "tessera") continue;
    if (!i.nameMark.test(name)) continue;
    if (i.mintPrefix && !t.mint.startsWith(i.mintPrefix)) continue;
    return i;
  }
  return null;
}

// ---- structural check: who controls the mint ----
// SPL Token / Token-2022 mint layout: [0..4) mint_authority COption tag (u32 LE, 1 = Some) [4..36) mint_authority
// [36..44) supply [44] decimals [45] is_initialized [46..50) freeze_authority tag [50..82) freeze_authority.
// Token-2022 pads the base to 165 bytes, writes account type 1 (Mint) at 165, then TLV extensions (u16 type, u16 len, data)
// from 166. PermanentDelegate is extension type 12 with a 32-byte delegate.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) throw new Error("bad base58");
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of s) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}
const keyCache = new Map<string, Uint8Array>();
const keyBytes = (k: string) => {
  let b = keyCache.get(k);
  if (!b) keyCache.set(k, (b = b58decode(k)));
  return b;
};
const eq32 = (d: Uint8Array, off: number, key: string) => {
  if (d.length < off + 32) return false;
  const k = keyBytes(key);
  for (let i = 0; i < 32; i++) if (d[off + i] !== k[i]) return false;
  return true;
};
const u16 = (d: Uint8Array, o: number) => d[o] | (d[o + 1] << 8);
const u32 = (d: Uint8Array, o: number) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const PERMANENT_DELEGATE = 12;

/** Offset of the PermanentDelegate pubkey inside a Token-2022 mint, or -1. */
function permanentDelegateOffset(d: Uint8Array): number {
  if (d.length <= 166 || d[165] !== 1) return -1;
  let o = 166;
  while (o + 4 <= d.length) {
    const type = u16(d, o), len = u16(d, o + 2);
    if (type === 0) break; // uninitialized padding
    if (type === PERMANENT_DELEGATE && len === 32 && o + 4 + 32 <= d.length) return o + 4;
    o += 4 + len;
  }
  return -1;
}

/** The issuer whose authorities control this mint account, from the raw account bytes (any token program), or null. Every
 *  authority the issuer is known for must match: a matching mint authority alone is accepted only for issuers that reuse one
 *  (xStocks, Ondo, PreStocks, Tessera); Backpack is recognised by its shared freeze authority + permanent delegate. */
export function stonkIssuerOfMintAccount(d: Uint8Array): StonkIssuer | null {
  if (d.length < 82) return null;
  const hasMintAuth = u32(d, 0) === 1;
  const hasFreeze = u32(d, 46) === 1;
  const pd = permanentDelegateOffset(d);
  for (const i of STONK_ISSUERS) {
    if (i.mintAuthority && !(hasMintAuth && eq32(d, 4, i.mintAuthority))) continue;
    if (i.freezeAuthority && !(hasFreeze && eq32(d, 50, i.freezeAuthority))) continue;
    if (i.permanentDelegate && !(pd >= 0 && eq32(d, pd, i.permanentDelegate))) continue;
    return i;
  }
  return null;
}

/** Category on a MarketView-shaped row (`category` is set by loadMarketView / the server); `other` when absent. */
export const catOfView = (v: { category?: Category }): Category => v.category ?? "other";
/** Does a row belong under this filter? `null` is All. */
export const inCat = (c: Category, cat: Cat | null) => cat === null || c === cat;
