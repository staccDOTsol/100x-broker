// The stacSOL successor shown at /ngu. Everything below is null until the launch script has run:
// fill it from ngu-crank's launch-<symbol>.json and the page switches from "pending" to live numbers.
export const NGU = {
  /** Off until the pool is deep enough to publish the contract address. */
  showAddresses: false,
  name: "Number Go Up" as string | null,
  symbol: "NGU" as string | null,
  /** LST mint (Token-2022, transfer tax). */
  mint: "8wZuSE7bRc43QLR1eWEtK7HtqYjTEUxwMmqqNoZciyrB" as string | null,
  /** Sanctum SPL single-validator stake pool (program SP12tWFx…). */
  stakePool: "5gQ7vYwwFm4Jy6uBtnuiQnCXNWD66baqetnwCKq4fWGo" as string | null,
  /** ngu-crank state PDA. */
  state: "6AJL4GoAoJBj4QjCFZzGCaTHzke66mvsPzzymHaDu1F7" as string | null,
  whirlpool: "cmjPwV9UZ2NetwqzLybsmQkNMCMUktnNnEP3t4YQaNU" as string | null,
  programId: "7LEh2yE62ocfnqcENYuZNL9ZFyaSdrfMygR2tisb2684",
  /** The not-a-presale: send SOL here, NGU is minted straight back to the sender (ngu-crank scripts/presale.cjs). */
  presaleAddress: "ELBz61oKyZKrkC6XZ99cs8yHjkLYA7uBJV5Cc6LLStRU" as string | null,
  /** The cranker's fee payer on Fly ("clanker"): every crank and epoch sync it sends is signed by this wallet. */
  crankWallet: "5VN8tZBpY65MJ3CiQnHbWdV79uRNJziZHdzrMnYkdLqD" as string | null,
  quoteMint: "Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump",
  orcaConfig: "RTHQ6Q3ri1p9Ymis9wWw3uUfLJe1Pb8LFg5Ktqkcgav",
  orcaFeePct: 0.03,
  orcaProtocolSharePct: 25,
  taxBps: 690 as number | null,
  /** true once the mint's transfer-fee config authority is null. */
  taxLocked: false as boolean | null,
  poolFees: { epochBps: 0, depositBps: 100, withdrawBps: 0 } as { epochBps: number; depositBps: number; withdrawBps: number } | null,
  /** true once `solana program set-upgrade-authority --final` has run. */
  programImmutable: false,
  validatorVote: null as string | null,
};
export const nguLive = () => !!(NGU.mint && NGU.stakePool && NGU.state);
export const NGU_LABEL = () => (NGU.symbol ? `$${NGU.symbol}` : "the new LST");
