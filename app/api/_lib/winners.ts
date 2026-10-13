// The winner feed: every realized win on 100x.broker, all time (plus every realized loss, so the leaderboards rank net P&L). An UP/DOWN exit (sell or cash-out) that paid more than the
// average cost of the tokens it moved, and a vault unpark that handed back more SOL than the receipts cost to mint.
// State is incremental: a baseline file built offline (tools/winners-build.ts) plus whatever landed since, scanned per request.
import {
  Connection,
  PublicKey,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import {
  allMarkets,
  botAddresses,
  classify,
  marketCtx,
  type Ev,
} from "./feed.js";
import { classify as classifyVault, type DnEv } from "../dnfeed.js";
import { listVaults, type Vault } from "../../src/lib/dn.js";
import { poolState } from "../../src/lib/zap.js";

const DN_PROGRAM = "2ZbjE44nSh3AmpREg4sdNMViBLAzAEtFKYDn1XdqMzEj";
const MEMO_TAG = "100x.broker 0/20";
const FOLLOW_SECS = 900; // an unpark's zap-out lands within minutes of the in-kind withdraw

export type PosBasis = {
  inQ: number;
  tokIn: number;
  outQ: number;
  tokOut: number;
  first: number;
};
export type VaultBasis = { lam: number; shares: number; first: number };
export type Win = {
  sig: string;
  ts: number;
  wallet: string;
  kind: "exit" | "unpark";
  market: string;
  vault?: string;
  ticker: string;
  side?: 0 | 1;
  /** r-fstacc (exits) or SOL (unparks), UI units; `unit` says which */
  unit: "rfstacc" | "sol";
  cost: number;
  out: number;
  gain: number;
  ret: number;
  hold_s: number;
};
export type WinState = {
  v: 1;
  at: number; // unix s of the last scan
  cursor: Record<string, string>; // account -> newest signature already folded in
  pos: Record<string, PosBasis>; // `${market}:${side}:${wallet}`
  vpos: Record<string, VaultBasis>; // `${vault}:${wallet}`
  wins: Win[];
  /** realized exits/unparks that paid less than they cost (gain < 0), same shape as wins; the leaderboards net them against wins */
  losses?: Win[];
};
export const emptyState = (): WinState => ({
  v: 1,
  at: 0,
  cursor: {},
  pos: {},
  vpos: {},
  wins: [],
  losses: [],
});

const conn = () => {
  const u = process.env.HELIUS_RPC_URL;
  if (!u) throw new Error("HELIUS_RPC_URL not configured");
  return new Connection(u, "confirmed");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(f: () => Promise<T>, tries = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await f();
    } catch (e) {
      last = e;
      await sleep(800 * (i + 1));
    }
  }
  throw last;
}

/** Signatures newer than `cursor` for one account, oldest first (so cost basis accumulates in order). */
async function newSigs(
  c: Connection,
  key: PublicKey,
  cursor: string | undefined,
  maxSigs: number,
): Promise<{ sigs: string[]; newest?: string }> {
  const out: string[] = [];
  let before: string | undefined;
  let newest: string | undefined;
  let hit = false;
  while (out.length < maxSigs && !hit) {
    // `until` makes the RPC stop at the cursor itself, so a quiet account answers with an empty page instead of 1000 old rows
    const page = await retry(() =>
      c.getSignaturesForAddress(key, { limit: 1000, before, until: cursor }),
    );
    if (!page.length) break;
    newest ??= page[0].signature;
    for (const s of page) {
      if (s.signature === cursor) {
        hit = true;
        break;
      }
      if (!s.err) out.push(s.signature);
    }
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  return { sigs: out.reverse(), newest };
}
async function parsed(
  c: Connection,
  sigs: string[],
  chunk = 100,
): Promise<(ParsedTransactionWithMeta | null)[]> {
  const out: (ParsedTransactionWithMeta | null)[] = [];
  for (let i = 0; i < sigs.length; i += chunk) {
    const part = sigs.slice(i, i + chunk);
    try {
      out.push(
        ...(await retry(() =>
          c.getParsedTransactions(part, { maxSupportedTransactionVersion: 0 }),
        )),
      );
    } catch (e) {
      if (chunk <= 10) throw e;
      out.push(...(await parsed(c, part, Math.max(10, Math.floor(chunk / 5))))); // the RPC balked at the batch size: go smaller
    }
    if (chunk >= 50 && i + chunk < sigs.length) await sleep(150);
  }
  return out;
}

const lamportDelta = (tx: ParsedTransactionWithMeta, who: string) => {
  const i = tx.transaction.message.accountKeys.findIndex(
    (k) => k.pubkey.toBase58() === who,
  );
  return i >= 0 && tx.meta
    ? tx.meta.postBalances[i] - tx.meta.preBalances[i]
    : 0;
};
const touches = (tx: ParsedTransactionWithMeta, keys: Set<string>) =>
  tx.transaction.message.accountKeys.some((k) => keys.has(k.pubkey.toBase58()));
const isMemo020 = (tx: ParsedTransactionWithMeta) =>
  tx.transaction.message.instructions.some(
    (ix) =>
      "parsed" in ix &&
      (ix as ParsedInstruction).program === "spl-memo" &&
      String((ix as ParsedInstruction).parsed ?? "").includes(MEMO_TAG),
  );

/** SOL that reached the wallet from an unpark: the in-kind withdraw itself plus the wallet's own positive-SOL follow-up txs that
 *  turn the legs back into SOL (DOWN exit on the vault's market, Raydium swap, stake-pool withdraw). The 0/20 leg is skipped:
 *  that SOL left the wallet as a gift, it was still won. Another vault op or a fresh buy never counts. */
async function unparkProceeds(
  c: Connection,
  tx1: ParsedTransactionWithMeta,
  actor: string,
  v: Vault,
): Promise<number> {
  let lamports = lamportDelta(tx1, actor);
  const ts = tx1.blockTime ?? 0;
  const legs = new Set([
    v.market.toBase58(),
    v.downMint.toBase58(),
    v.xMint.toBase58(),
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    "SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY",
  ]);
  const dn = new Set([DN_PROGRAM]);
  const sigs: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < 5; page++) {
    const list = await retry(() =>
      c.getSignaturesForAddress(new PublicKey(actor), { limit: 100, before }),
    );
    if (!list.length) break;
    let past = false;
    for (const s of list) {
      const t = s.blockTime ?? 0;
      if (t <= ts) {
        past = true;
        break;
      }
      if (!s.err && t <= ts + FOLLOW_SECS) sigs.push(s.signature);
    }
    if (past || list.length < 100) break;
    before = list[list.length - 1].signature;
  }
  if (!sigs.length) return lamports;
  for (const tx of await parsed(c, sigs)) {
    if (!tx || !tx.meta || tx.meta.err) continue;
    if (tx.transaction.message.accountKeys[0].pubkey.toBase58() !== actor)
      continue;
    if (touches(tx, dn) || isMemo020(tx) || !touches(tx, legs)) continue;
    const d = lamportDelta(tx, actor);
    if (d > 0) lamports += d;
  }
  return lamports;
}

/** Fold everything newer than the state's cursors into it. `maxPerAccount` bounds one pass (the baseline passes Infinity). */
export async function scanWinners(
  prev: WinState | null,
  opts: { maxPerAccount?: number; log?: (s: string) => void } = {},
): Promise<WinState> {
  const st: WinState = prev
    ? {
        ...prev,
        cursor: { ...prev.cursor },
        pos: { ...prev.pos },
        vpos: { ...prev.vpos },
        wins: [...prev.wins],
        losses: [...(prev.losses ?? [])],
      }
    : emptyState();
  const max = opts.maxPerAccount ?? 3000;
  const c = conn();
  const [markets, vaults, bots] = await Promise.all([
    allMarkets(),
    listVaults(),
    botAddresses(),
  ]);
  st.losses ??= [];
  const losses = st.losses;
  const seen = new Set([...st.wins, ...losses].map((w) => w.sig));

  for (const key of markets) {
    const k = key.toBase58();
    try {
      const { sigs, newest } = await newSigs(c, key, st.cursor[k], max);
      if (sigs.length) {
        const ctx = await retry(() => marketCtx(key));
        const txs = await parsed(c, sigs);
        const evs = txs
          .map((t) => (t ? classify(t, ctx) : null))
          .filter((e): e is Ev => !!e);
        for (const e of evs) {
          if (e.side === undefined || bots.has(e.actor)) continue;
          if (e.kind !== "buy" && e.kind !== "sell" && e.kind !== "redeem")
            continue;
          const pk = `${e.market}:${e.side}:${e.actor}`;
          const b =
            st.pos[pk] ??
            (st.pos[pk] = {
              inQ: 0,
              tokIn: 0,
              outQ: 0,
              tokOut: 0,
              first: e.ts,
            });
          const q = Number(e.quote ?? 0) / 1e9;
          const t = e.tokens ?? 0;
          if (e.kind === "buy") {
            b.inQ += q;
            b.tokIn += t;
            b.first = Math.min(b.first, e.ts);
            continue;
          }
          if (b.tokIn > 0 && t > 0) {
            const cpt = b.inQ / b.tokIn;
            const cost = Math.min(
              cpt * t,
              Math.max(0, b.inQ - Math.min(b.inQ, cpt * b.tokOut)),
            );
            const gain = q - cost;
            if (gain !== 0 && cost > 0 && !seen.has(e.sig)) {
              seen.add(e.sig);
              (gain > 0 ? st.wins : losses).push({
                sig: e.sig,
                ts: e.ts,
                wallet: e.actor,
                kind: "exit",
                market: e.market,
                ticker: e.ticker,
                side: e.side,
                unit: "rfstacc",
                cost,
                out: q,
                gain,
                ret: gain / cost,
                hold_s: Math.max(0, e.ts - b.first),
              });
            }
          }
          b.outQ += q;
          b.tokOut += t;
        }
        opts.log?.(
          `${ctx.ticker}: ${sigs.length} new txs, ${evs.length} events`,
        );
      }
      if (newest) st.cursor[k] = newest;
    } catch (e) {
      opts.log?.(
        `market ${k.slice(0, 6)} skipped this pass: ${e instanceof Error ? e.message.slice(0, 100) : e}`,
      );
    }
  }

  for (const v of vaults) {
    const k = v.key.toBase58();
    try {
      const { sigs, newest } = await newSigs(c, v.key, st.cursor[k], max);
      if (sigs.length) {
        const txs = await parsed(c, sigs);
        const shareMint = v.shareMint.toBase58();
        let ticker = "";
        for (const tx of txs) {
          const e: DnEv | null = tx ? classifyVault(tx, shareMint) : null;
          if (!e || !e.actor || bots.has(e.actor)) continue;
          const pk = `${k}:${e.actor}`;
          if (e.kind === "deposit") {
            const b =
              st.vpos[pk] ?? (st.vpos[pk] = { lam: 0, shares: 0, first: e.ts });
            b.lam += Number(e.lamports ?? 0);
            b.shares += Number(e.shares ?? 0);
            b.first = Math.min(b.first, e.ts);
          } else if (e.kind === "withdraw" && tx) {
            const b = st.vpos[pk];
            const shares = Number(e.shares ?? 0);
            if (!b || b.shares <= 0 || shares <= 0) continue;
            const cost = (b.lam / b.shares) * Math.min(shares, b.shares);
            const out = await unparkProceeds(c, tx, e.actor, v);
            b.lam = Math.max(0, b.lam - cost);
            b.shares = Math.max(0, b.shares - shares);
            const gain = out - cost;
            if (gain !== 0 && cost > 0 && !seen.has(e.sig)) {
              if (!ticker)
                ticker =
                  (await retry(() => marketCtx(v.market)).catch(() => null))
                    ?.ticker ?? v.xMint.toBase58().slice(0, 4);
              seen.add(e.sig);
              (gain > 0 ? st.wins : losses).push({
                sig: e.sig,
                ts: e.ts,
                wallet: e.actor,
                kind: "unpark",
                market: v.market.toBase58(),
                vault: k,
                ticker,
                unit: "sol",
                cost: cost / 1e9,
                out: out / 1e9,
                gain: gain / 1e9,
                ret: gain / cost,
                hold_s: Math.max(0, e.ts - b.first),
              });
            }
          }
        }
        opts.log?.(`vault ${k.slice(0, 6)}: ${sigs.length} new txs`);
      }
      if (newest) st.cursor[k] = newest;
    } catch (e) {
      opts.log?.(
        `vault ${k.slice(0, 6)} skipped this pass: ${e instanceof Error ? e.message.slice(0, 100) : e}`,
      );
    }
  }

  st.wins.sort((a, b) => b.ts - a.ts);
  st.at = Math.floor(Date.now() / 1000);
  st.losses = losses.sort((a, b) => b.ts - a.ts);
  return st;
}

/** SOL per r-fstacc right now, to put exits and unparks on one scale. */
export async function rfstaccRate(): Promise<number> {
  try {
    return (await poolState()).rate;
  } catch {
    return 1;
  }
}
