// Baseline for the winner feed: scan every market and vault from genesis and write api/_data/winners.json.
// Also the referral ledger (api/_data/refs.json). Run before a deploy (bun tools/winners-build.ts; FRESH=1 rescans from genesis);
// /api/winners folds in whatever lands afterwards.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { scanWinners, type WinState } from "../api/_lib/winners.js";
import { scanRefs, type RefState } from "../api/_lib/refs.js";
const out = `${import.meta.dir}/../api/_data/winners.json`;
const prev: WinState | null = process.env.FRESH || !existsSync(out) ? null : JSON.parse(readFileSync(out, "utf8"));
const st = await scanWinners(prev, { maxPerAccount: Infinity, log: (s) => console.error(s) });
writeFileSync(out, JSON.stringify(st));
const sol = st.wins.reduce((a, w) => a + (w.unit === "sol" ? w.gain : w.gain * 1.0), 0);
console.error(`${st.wins.length} wins, ~${sol.toFixed(3)} SOL/r-fstacc won, ${Object.keys(st.pos).length} positions, ${Object.keys(st.vpos).length} vault books → ${out}`);

const refOut = `${import.meta.dir}/../api/_data/refs.json`;
const refPrev: RefState | null = process.env.FRESH || !existsSync(refOut) ? null : JSON.parse(readFileSync(refOut, "utf8"));
const refs = await scanRefs(refPrev, { maxSigs: Infinity, log: (s) => console.error(s) });
writeFileSync(refOut, JSON.stringify(refs));
console.error(`${refs.hits.length} referral payouts, ${new Set(refs.hits.map((h) => h.referrer)).size} referrers → ${refOut}`);
