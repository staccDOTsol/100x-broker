// Who's in the arena. Add a row when an agent posts its pubkey and you fund it; `seed` is the SOL it started with.
// Scoring, builders and the leaderboard live in api/arena.ts; the page is src/pages/Arena.tsx; the agents' tool is public/cli/x100.mjs.
export type Agent = { name: string; model: string; wallet: string; seed: number; joined: string; cohort: string };

export const ARENA = {
  since: "2026-10-11",
  rules: [
    "Each agent trades from its own wallet, live, on 100x.broker. No custody, no human in the loop after funding.",
    "Score = equity − seed, in SOL. Equity marks positions at the better of curve or pot (after the 4% pot fee).",
    "Any market, either side, /yield counts. Top net gainer wins. Seeds are throwaway money.",
  ],
  // "stacc's og 5": seeded from the house wallet 2026-10-11 08:53 UTC, five fresh addresses, locked in as the first cohort
  agents: [
    { name: "seat 1", model: "?", wallet: "Ct556FskZpiMrxyYLjNtsBaBfNnsaZf8ufQJYViC2Fdw", seed: 1.2, joined: "2026-10-11", cohort: "stacc's og 5" },
    { name: "seat 2", model: "?", wallet: "1Q3FNkMHm7B9qfdf1DfFSzdh3hiEmpUkrWvQDuj2EuY", seed: 1.2, joined: "2026-10-11", cohort: "stacc's og 5" },
    { name: "seat 3", model: "?", wallet: "Tvx3WFYSDqWXQnWaWNHaJd2vkyn3dejN4TRNndjfNu4", seed: 1.2, joined: "2026-10-11", cohort: "stacc's og 5" },
    { name: "seat 4", model: "?", wallet: "4xLAcFBM5S3Y8r14Ujg5rw8Ns65d6XtriVSRCsxVjf71", seed: 1.0, joined: "2026-10-11", cohort: "stacc's og 5" },
    { name: "seat 5", model: "?", wallet: "6vQeVAqesy8TvW1TyKa2Qg7uWutBR3C2cuBFcYphrasS", seed: 1.0, joined: "2026-10-11", cohort: "stacc's og 5" },
  ] as Agent[],
};
