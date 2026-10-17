// The stacSOL successor shown at /ngu. Everything below is null until the launch script has run:
// fill it from ngu-crank's launch-<symbol>.json and the page switches from "pending" to live numbers.
export const NGU = {
  name: "Number Go Up" as string | null,
  symbol: "NGU" as string | null,
  /** LST mint (Token-2022, transfer tax). */
  mint: null as string | null,
  /** Sanctum SPL single-validator stake pool (program SP12tWFx…). */
  stakePool: null as string | null,
  /** ngu-crank state PDA. */
  state: null as string | null,
  whirlpool: null as string | null,
  programId: "7LEh2yE62ocfnqcENYuZNL9ZFyaSdrfMygR2tisb2684",
  quoteMint: "Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump",
  orcaConfig: "RTHQ6Q3ri1p9Ymis9wWw3uUfLJe1Pb8LFg5Ktqkcgav",
  orcaFeePct: 0.03,
  orcaProtocolSharePct: 25,
  taxBps: null as number | null,
  /** true once the mint's transfer-fee config authority is null. */
  taxLocked: null as boolean | null,
  poolFees: null as { epochBps: number; depositBps: number; withdrawBps: number } | null,
  /** true once `solana program set-upgrade-authority --final` has run. */
  programImmutable: false,
  validatorVote: null as string | null,
};
export const nguLive = () => !!(NGU.mint && NGU.stakePool && NGU.state);
export const NGU_LABEL = () => (NGU.symbol ? `$${NGU.symbol}` : "the new LST");
