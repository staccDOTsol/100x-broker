// The pump.fun SDK, server side. Its ESM build (dist/esm/index.js) ships without "type": "module", so Vercel's Node loads it as
// CommonJS and /api/pumps crashed on every call. The server takes the SDK's CommonJS build instead. The browser bundle swaps
// this file for pumpsdk.browser.ts (alias in vite.config.ts), which imports the ESM build as usual.
// written as `const require = createRequire(...)` + a literal require() so Vercel's file tracer (nft) bundles the SDK and its deps
import { createRequire } from "module";
type Sdk = typeof import("@pump-fun/pump-sdk");
const require = createRequire(import.meta.url);
const sdk = require("@pump-fun/pump-sdk") as Sdk;
export const { OnlinePumpSdk, PumpSdk, bondingCurvePda, creatorVaultPda, feeSharingConfigPda, getBuyTokenAmountFromSolAmount } = sdk;
export type { BondingCurve, FeeConfig, Global, ResolvedQuoteMint, SharingConfig } from "@pump-fun/pump-sdk";
