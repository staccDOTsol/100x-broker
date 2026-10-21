// Read-only recovery inventory. No wallet/keypair is loaded and no transaction is submitted.
// RPC=<mainnet RPC> bun restoration-preflight.ts > recovery-preflight.json
import fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, unpackAccount, unpackMint } from "@solana/spl-token";
import { DBC, DEV_ATA, RFSTACC, STAKE_POOL_ACCT } from "./lib";

const conn = new Connection(process.env.RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
const programs = {
  hooked: "3ZACDHNMHhuZkPYZQZwyXYoJCxJr8kK8yUzGoqt5FbeH",
  dnvault: "HQ7oEm6WqZVmA8PSZVXC1mX28Xnbhq3kky4QhFixdNzC",
  dbc: DBC.toBase58(),
  stakePool: "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY",
  raydiumClmm: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  pump: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  pumpSwap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  war: "Hbu4EByGc17GxHYyiazxDMvtL6VvKxV4aRsZW95uzfu7",
};
const accounts = await conn.getMultipleAccountsInfo(Object.values(programs).map((p) => new PublicKey(p)));
const dependencies = await Promise.all(Object.entries(programs).map(async ([name, address], i) => {
  const a = accounts[i];
  const pd = a?.owner.toBase58() === "BPFLoaderUpgradeab1e11111111111111111111111" && a.data.readUInt32LE(0) === 2
    ? new PublicKey(a.data.subarray(4, 36)) : null;
  const pdInfo = pd ? await conn.getAccountInfo(pd) : null;
  return { name, address, executable: !!a?.executable, programData: pd?.toBase58(), programDataPresent: !!pdInfo,
    usable: !!a?.executable && (!pd || !!pdInfo) };
}));
const [poolInfo, mintInfo, devInfo] = await conn.getMultipleAccountsInfo([STAKE_POOL_ACCT, RFSTACC, DEV_ATA]);
if (!poolInfo || !mintInfo) throw new Error("r-freestacc pool or mint is missing");
const d = poolInfo.data;
let o = 0;
const u8 = () => d[o++];
const u64 = () => { const v = d.readBigUInt64LE(o); o += 8; return v; };
const pk = () => { const v = new PublicKey(d.subarray(o, o + 32)); o += 32; return v; };
const fee = () => { const denominator = u64(); const numerator = u64(); return { numerator, denominator }; };
const optPk = () => u8() ? pk() : null;
const future = () => u8() ? fee() : null;
u8(); const manager = pk(), staker = pk(), stakeDepositAuthority = pk(); u8();
const validatorList = pk(), reserveStake = pk(), poolMint = pk(), managerFeeAccount = pk(), tokenProgram = pk();
const totalLamports = u64(), poolTokenSupply = u64(), lastUpdateEpoch = u64(); o += 48;
const epochFee = fee(), nextEpochFee = future(), preferredDeposit = optPk(), preferredWithdraw = optPk();
const stakeDepositFee = fee(), stakeWithdrawalFee = fee(), nextStakeWithdrawalFee = future(); u8();
const solDepositAuthority = optPk(), solDepositFee = fee(); u8();
const solWithdrawAuthority = optPk(), solWithdrawalFee = fee(), nextSolWithdrawalFee = future();
const [reserveInfo, managerFeeInfo, oracle] = await conn.getMultipleAccountsInfo([
  reserveStake, managerFeeAccount, new PublicKey("45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5"),
]);
const obs = oracle ? new PublicKey(oracle.data.subarray(201, 233)) : null;
const obsInfo = obs ? await conn.getAccountInfo(obs) : null;
const observationTs = obsInfo ? obsInfo.data.readUInt32LE(51 + obsInfo.data.readUInt16LE(17) * 44) : null;
const rent = await conn.getAccountInfo(new PublicKey("SysvarRent111111111111111111111111111111111"));
const rate = Number(rent!.data.readBigUInt64LE(0)), threshold = rent!.data.readDoubleLE(8);
const exactRent = (bytes: number) => Math.floor((128 + bytes) * rate * threshold);
const artifactDir = process.env.ARTIFACT_DIR ?? "/Users/stacc/tmp/mainnet-salvage-2026-10-20/hooked-build";
const costs = Object.fromEntries(["hooked", "dnvault"].map((name) => {
  const bytes = fs.statSync(`${artifactDir}/${name}.so`).size;
  return [name, { bytes, maxLen: bytes, programRent: exactRent(36), programDataRent: exactRent(bytes + 45),
    temporaryBufferRent: exactRent(bytes + 37), retainedRent: exactRent(36) + exactRent(bytes + 45) }];
}));
const mint = unpackMint(RFSTACC, mintInfo, TOKEN_PROGRAM_ID);
const dev = devInfo ? unpackAccount(DEV_ATA, devInfo, TOKEN_PROGRAM_ID) : null;
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(), slot: await conn.getSlot(), dependencies, costs,
  rent: { lamportsPerByte: rate, threshold, rpc165: await conn.getMinimumBalanceForRentExemption(165), sysvar165: exactRent(165) },
  quote: { mint: RFSTACC, decimals: mint.decimals, supply: mint.supply, mintAuthority: mint.mintAuthority, freezeAuthority: mint.freezeAuthority },
  stakePool: { address: STAKE_POOL_ACCT, owner: poolInfo.owner, manager, staker, stakeDepositAuthority, validatorList, reserveStake,
    reserveLamports: reserveInfo?.lamports, poolMint, managerFeeAccount, managerFeeAccountPresent: !!managerFeeInfo,
    tokenProgram, totalLamports, poolTokenSupply, nav: Number(totalLamports) / Number(poolTokenSupply),
    lastUpdateEpoch, currentEpoch: (await conn.getEpochInfo()).epoch, epochFee, nextEpochFee, preferredDeposit, preferredWithdraw,
    stakeDepositFee, stakeWithdrawalFee, nextStakeWithdrawalFee, solDepositAuthority, solDepositFee, solWithdrawAuthority,
    solWithdrawalFee, nextSolWithdrawalFee },
  devFees: dev && { amount: dev.amount, owner: dev.owner, delegate: dev.delegate, delegatedAmount: dev.delegatedAmount },
  pumpOracle: { pool: "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5", observation: obs,
    observationTs, ageSecs: observationTs && Math.floor(Date.now() / 1000) - observationTs },
}, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
