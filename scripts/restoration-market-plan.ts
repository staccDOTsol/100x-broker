// Read-only chain access; generates local market mint/config keypairs and a public deployment manifest.
// No payer key is loaded, no transaction signed or sent. Existing generated keys are reused.
import fs from "fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, marketPda, sideAccounts, type Market } from "./lib";
import { DN_PROGRAM, vaultPda, sharesPda } from "./dn/lib";
import { loadRay, poolCtx } from "./dn/ops";

const directory = process.env.PLAN_DIR ?? "/Users/stacc/tmp/mainnet-salvage-2026-10-20";
const conn = new Connection(process.env.RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
const ray = await loadRay(conn, Keypair.generate()); // SDK identity only; no transaction is built or signed.
const definitions = [
  { symbol: "100XBRO", oldHero: "A82ZLV7Yvt5pmN4ziwjZBmxYKdazZ2vFkG58jFJN3H6G", pool: "A7zB4JfJuEBZMpQLVtNAYMr1KAspaXKQEudwBxWeyz8V", underlying: "Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump" },
  { symbol: "PUMP", oldHero: "GwzRwcPYSojZiNc4tC4eoLSLD7htk3akWA7qtG68zyHh", pool: "45ssPkUQs1ssbeDqxD2mZrMdJYAXF7GyQyhS5xDXuWC5", underlying: "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn" },
  { symbol: "SOL", oldHero: "7379fbMnbbsGThpxLBnTbumhvWenAMCkf5bkh3zCBNwW", pool: "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv", underlying: "So11111111111111111111111111111111111111112" },
  { symbol: "USDC", oldHero: "GLMSWgyzyC8GtAbPjv2qCa5fKzYR3GAxCZJ8E1RZMmbz", pool: "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv", underlying: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
  { symbol: "WBTC", oldHero: "33HifKMSbX7CVyQCh292KrYzGNG2MDEbHcFv1xim59ka", pool: "HCfytQ49w6Dn9UhHCqjNYTZYQ6z5SwqmsyYYqW4EKDdA", underlying: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh" },
];
fs.mkdirSync(`${directory}/private`, { recursive: true, mode: 0o700 });
const markets = [];
for (const def of definitions) {
  if (process.env.ONLY_SYMBOL && def.symbol !== process.env.ONLY_SYMBOL) continue;
  const pool = new PublicKey(def.pool);
  const poolInfo = await conn.getAccountInfo(pool);
  if (!poolInfo || poolInfo.owner.toBase58() !== "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK") throw new Error(`${def.symbol} CLMM pool unavailable`);
  const obs = new PublicKey(poolInfo.data.subarray(201, 233));
  const mint0 = new PublicKey(poolInfo.data.subarray(73, 105));
  const mint1 = new PublicKey(poolInfo.data.subarray(105, 137));
  if (![mint0.toBase58(), mint1.toBase58()].includes(def.underlying)) throw new Error("underlying mismatch");
  const flag = mint0.toBase58() === def.underlying ? 1 : 0;
  const keysPath = `${directory}/private/hooked-${def.symbol.toLowerCase()}-market-keys.json`;
  const saved = fs.existsSync(keysPath) ? JSON.parse(fs.readFileSync(keysPath, "utf8"))
    : { programId: PROGRAM_ID.toBase58(), bull: [...Keypair.generate().secretKey], bear: [...Keypair.generate().secretKey], config: [...Keypair.generate().secretKey] };
  if (saved.programId !== PROGRAM_ID.toBase58()) throw new Error("saved keys use different deployment");
  if (!fs.existsSync(keysPath)) fs.writeFileSync(keysPath, JSON.stringify(saved), { mode: 0o600 });
  const pub = (a: number[]) => Keypair.fromSecretKey(Uint8Array.from(a)).publicKey;
  const m: Market = { key: marketPda(pub(saved.bull), pub(saved.bear), obs, 1, flag), bullMint: pub(saved.bull), bearMint: pub(saved.bear),
    oraclePool: pool, oracleObs: obs, windowSecs: 1, underlyingIsToken0: flag, config: pub(saved.config) };
  const ring = (await conn.getAccountInfo(obs))!.data;
  const latest = ring.readUInt32LE(51 + ring.readUInt16LE(17) * 44);
  const ageSecs = Math.floor(Date.now() / 1000) - latest;
  const up = sideAccounts(m, 0), down = sideAccounts(m, 1);
  let dn: Record<string, unknown> = { program: DN_PROGRAM, supported: false, reason: "DN requires a non-SOL underlying paired with SOL" };
  if (def.underlying !== "So11111111111111111111111111111111111111112") {
    const ctx = await poolCtx(conn, ray, pool);
    const spacing = poolInfo.data.readUInt16LE(235);
    const starts = Object.values(ctx.tickCache as Record<string, { startTickIndex: number }>).map((t) => Number(t.startTickIndex)).sort((a, b) => a - b);
    if (!starts.length) throw new Error(`${def.symbol} has no initialized CLMM tick arrays`);
    const lower = starts[0], upper = starts[starts.length - 1] + 60 * spacing - spacing;
    const vault = vaultPda(m.key, lower, upper);
    dn = { program: DN_PROGRAM, supported: true, vault, shareMint: sharesPda(vault), lower, upper,
      bandBps: 1500, maxLossBps: 300, keeperBps: 100, depositSol: "0" };
  }
  markets.push({ ...def, keysPath, program: PROGRAM_ID, market: m.key, bullMint: m.bullMint, bearMint: m.bearMint,
    config: m.config, oracleObs: obs, windowSecs: 1, underlyingIsToken0: flag, latestObservation: latest, oracleAgeSecs: ageSecs,
    readyForTwoObsCreation: ageSecs <= 3600, upPool: up.pool, downPool: down.pool, upVault: up.vault, downVault: down.vault,
    seedQuoteTotal: "0", validationBuyQuoteEach: "0",
    dn });
}
const previousPath = `${directory}/hooked-restoration-markets.json`;
const previous = process.env.ONLY_SYMBOL && fs.existsSync(previousPath) ? JSON.parse(fs.readFileSync(previousPath, "utf8")) : null;
if (previous && (previous.program !== PROGRAM_ID.toBase58() || previous.dnProgram !== DN_PROGRAM.toBase58())) throw new Error("previous manifest uses a different deployment");
const merged = previous ? [...previous.markets.filter((m: { symbol: string }) => !markets.some((n) => n.symbol === m.symbol)), ...markets] : markets;
const out = { checkedAt: new Date().toISOString(), program: PROGRAM_ID, dnProgram: DN_PROGRAM, markets: merged };
fs.writeFileSync(`${directory}/hooked-restoration-markets.json`, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
