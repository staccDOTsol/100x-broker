import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { conn, dbc, marketsForOracle, oracleHealth, quoteSymbolOf, sendRaw, type OracleHealth, type OracleQuote } from "../lib/chain";
import { createMarketIx, cu, marketPda, sideAccounts, type MarketKeys } from "../lib/hooked";
import { marketCurve } from "../lib/curve";
import { humanError } from "../hooks";
import { useToasts } from "../components/Toasts";
import { CardShare } from "../components/Share";
import { ago, lev, pct, short } from "../lib/format";
import { getDerivedMeta, getUnderlying, metaUri, type DerivedMeta, type Underlying } from "../lib/das";
import { shareUrl, tweetUrl } from "../lib/ref";
import { currentShare, useQuery } from "../lib/url";
import { DEFAULT_WINDOW_SECS, LEVERAGE, PROGRAM_ID, RAYDIUM_CLMM, REDEEM_FEE, RFSTACC } from "../config";

type PoolRow = {
  id: PublicKey;
  obs: PublicKey;
  mint0: PublicKey;
  mint1: PublicKey;
  quote: OracleQuote;
  tvl: number;
  volume24h: number;
  health: OracleHealth | null;
};
type StepState = "idle" | "active" | "done" | "failed";
// Same four on-chain steps, same order; labels are display-only.
const STEPS = ["Curve config", "UP curve", "DOWN curve", "Market + vaults"];
const WINDOWS = [
  { secs: 900, label: "15 min", note: "fast" },
  { secs: DEFAULT_WINDOW_SECS, label: "66 min", note: "default" },
  { secs: 14_400, label: "4 h", note: "calm" },
];
const EST_RENT_SOL = 0.04;
/** Mirrors `marketCurve()` in lib/curve.ts (startingFeeBps = endingFeeBps = 400). */
const CURVE_FEE_BPS = 400;

/** Raydium v3: CLMM pools containing this mint, deepest first. Filtered to SOL/USDC/USDT quotes. */
async function raydiumPools(mint: PublicKey): Promise<Omit<PoolRow, "obs" | "health">[]> {
  const u = `https://api-v3.raydium.io/pools/info/mint?mint1=${mint.toBase58()}&poolType=concentrated&poolSortField=liquidity&sortType=desc&pageSize=12&page=1`;
  const r = await fetch(u);
  if (!r.ok) throw new Error("Raydium API unavailable");
  const j = await r.json();
  const rows: Omit<PoolRow, "obs" | "health">[] = [];
  for (const p of j?.data?.data ?? []) {
    if (p.programId !== RAYDIUM_CLMM.toBase58()) continue;
    const mint0 = new PublicKey(p.mintA.address);
    const mint1 = new PublicKey(p.mintB.address);
    const other = mint0.equals(mint) ? mint1 : mint0;
    const quote = quoteSymbolOf(other);
    if (quote === "?") continue;
    rows.push({ id: new PublicKey(p.id), mint0, mint1, quote, tvl: Number(p.tvl ?? 0), volume24h: Number(p.day?.volume ?? 0) });
  }
  return rows;
}

/** Resolve a pasted address: a mint, or a CLMM pool (then the non-quote side is the underlying). */
async function resolveInput(text: string): Promise<{ mint: PublicKey; pinnedPool?: PublicKey }> {
  const key = new PublicKey(text.trim());
  const info = await conn.getAccountInfo(key);
  if (!info) throw new Error("No account at that address.");
  if (info.owner.equals(RAYDIUM_CLMM)) {
    const m0 = new PublicKey(info.data.subarray(73, 105));
    const m1 = new PublicKey(info.data.subarray(105, 137));
    const mint = quoteSymbolOf(m0) !== "?" ? m1 : m0;
    return { mint, pinnedPool: key };
  }
  if (info.data.length < 82) throw new Error("That isn't a token mint or a Raydium CLMM pool.");
  return { mint: key };
}

const keyStore = (id: string) => `listing:${id}`;
function loadOrMakeKeys(id: string) {
  try {
    const raw = localStorage.getItem(keyStore(id));
    if (raw) {
      const j = JSON.parse(raw) as { bull: number[]; bear: number[]; config: number[] };
      return {
        bull: Keypair.fromSecretKey(Uint8Array.from(j.bull)),
        bear: Keypair.fromSecretKey(Uint8Array.from(j.bear)),
        config: Keypair.fromSecretKey(Uint8Array.from(j.config)),
        resumed: true,
      };
    }
  } catch {
    /* fall through */
  }
  const k = { bull: Keypair.generate(), bear: Keypair.generate(), config: Keypair.generate() };
  try {
    localStorage.setItem(keyStore(id), JSON.stringify({ bull: [...k.bull.secretKey], bear: [...k.bear.secretKey], config: [...k.config.secretKey] }));
  } catch {
    /* private mode: single-shot only */
  }
  return { ...k, resumed: false };
}

export default function NewMarket() {
  const { publicKey, signAllTransactions } = useWallet();
  const nav = useNavigate();
  const toasts = useToasts();
  const q = useQuery();
  const [input, setInputRaw] = useState(() => q.get("pool") ?? q.get("mint") ?? "");
  const setInput = (v: string) => {
    setInputRaw(v);
    q.set({ mint: v.trim() || null, pool: null, window: null });
  };
  const [resolving, setResolving] = useState(false);
  const [inputErr, setInputErr] = useState<string | null>(null);
  const [under, setUnder] = useState<Underlying | null>(null);
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [poolIdx, setPoolIdx] = useState(0);
  const [windowSecs, setWindowSecsRaw] = useState(() => {
    const m = Number(q.get("window"));
    return Number.isFinite(m) && m > 0 ? Math.round(m * 60) : DEFAULT_WINDOW_SECS;
  });
  const setWindowSecs = (secs: number) => {
    setWindowSecsRaw(secs);
    q.set({ window: secs === DEFAULT_WINDOW_SECS ? null : secs / 60 });
  };
  const [customWin, setCustomWin] = useState(() => {
    const m = Number(q.get("window"));
    return Number.isFinite(m) && m > 0 && !WINDOWS.some((w) => w.secs === Math.round(m * 60)) ? String(m) : "";
  });
  const [meta, setMeta] = useState<{ up: DerivedMeta; down: DerivedMeta } | null>(null);
  const [existing, setExisting] = useState<PublicKey[]>([]);
  const [steps, setSteps] = useState<StepState[]>(STEPS.map(() => "idle"));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listed, setListed] = useState<{ symbol: string; key: string } | null>(null);

  // 1. resolve the pasted address -> underlying + candidate pools (+ oracle health per pool)
  useEffect(() => {
    setUnder(null);
    setPools([]);
    setMeta(null);
    setInputErr(null);
    setExisting([]);
    const text = input.trim();
    if (text.length < 32) return;
    let alive = true;
    setResolving(true);
    (async () => {
      try {
        const { mint, pinnedPool } = await resolveInput(text);
        const [asset, candidates] = await Promise.all([getUnderlying(mint.toBase58()), raydiumPools(mint)]);
        if (!alive) return;
        if (!candidates.length) throw new Error("No Raydium CLMM pool against SOL/USDC/USDT for this token — it needs one to have an oracle.");
        const infos = await conn.getMultipleAccountsInfo(candidates.map((c) => c.id));
        const obsKeys = infos.map((i) => (i ? new PublicKey(i.data.subarray(201, 233)) : null));
        const obsInfos = await conn.getMultipleAccountsInfo(obsKeys.filter((k): k is PublicKey => !!k));
        let oi = 0;
        const rows: PoolRow[] = candidates.map((c, i) => {
          const obs = obsKeys[i];
          const od = obs ? obsInfos[oi++] : null;
          return { ...c, obs: obs ?? c.id, health: od ? oracleHealth(od.data) : null };
        });
        // prefer SOL quote, then usable oracle, then depth
        rows.sort((a, b) => Number(b.quote === "SOL") - Number(a.quote === "SOL") || Number(!!b.health?.ok) - Number(!!a.health?.ok) || b.tvl - a.tvl);
        if (!alive) return;
        setUnder(asset ?? { mint: mint.toBase58(), name: short(mint.toBase58()), symbol: "TOKEN", image: null, decimals: 0 });
        setPools(rows);
        const wanted = pinnedPool ?? (q.get("pool") ? new PublicKey(q.get("pool")!) : null);
        const pinned = wanted ? rows.findIndex((r) => r.id.equals(wanted)) : -1;
        setPoolIdx(pinned >= 0 ? pinned : 0);
        q.set({ mint: mint.toBase58(), pool: rows[pinned >= 0 ? pinned : 0]?.id.toBase58() ?? null });
      } catch (e) {
        if (alive) setInputErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setResolving(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [input]);

  const pool = pools[poolIdx] ?? null;
  const underlyingMint = under ? new PublicKey(under.mint) : null;

  // 2. derived names/images for the pair + existing markets on this oracle
  useEffect(() => {
    setMeta(null);
    setExisting([]);
    if (!underlyingMint || !pool) return;
    let alive = true;
    const m = underlyingMint.toBase58();
    Promise.all([getDerivedMeta(m, "up"), getDerivedMeta(m, "down")]).then(([up, down]) => alive && setMeta({ up, down })).catch(() => {});
    marketsForOracle(pool.obs).then((ms) => alive && setExisting(ms)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [underlyingMint?.toBase58(), pool?.obs.toBase58()]);

  const flag = pool && underlyingMint ? (pool.mint0.equals(underlyingMint) ? 1 : 0) : 0;
  const windowOk = windowSecs >= 60 && windowSecs <= 86_400;
  const kp = useMemo(() => (pool ? loadOrMakeKeys(`${pool.obs.toBase58()}:${windowSecs}`) : null), [pool?.obs.toBase58(), windowSecs]);
  const keys: MarketKeys | null = useMemo(() => {
    if (!pool || !kp || !windowOk) return null;
    return {
      key: marketPda(kp.bull.publicKey, kp.bear.publicKey, pool.obs, windowSecs, flag),
      bullMint: kp.bull.publicKey,
      bearMint: kp.bear.publicKey,
      oraclePool: pool.id,
      oracleObs: pool.obs,
      windowSecs,
      underlyingIsToken0: flag,
      config: kp.config.publicKey,
    };
  }, [pool, kp, windowSecs, windowOk, flag]);

  const set = (i: number, s: StepState) => setSteps((xs) => xs.map((x, j) => (j === i ? s : x)));

  async function create() {
    if (!publicKey || !signAllTransactions || !keys || !kp || !meta || !underlyingMint || !pool) return;
    setBusy(true);
    setErr(null);
    try {
      const payer = publicKey;
      const um = underlyingMint.toBase58();
      const exists = await conn.getMultipleAccountsInfo([kp.config.publicKey, sideAccounts(keys, 0).pool, sideAccounts(keys, 1).pool, keys.key]);
      const plan: { i: number; tx: Transaction; signers: Keypair[] }[] = [];
      if (!exists[0]) {
        const tx = await dbc.partner.createConfigWithTransferHook({
          ...marketCurve(), config: kp.config.publicKey, feeClaimer: keys.key, leftoverReceiver: payer,
          quoteMint: RFSTACC, payer, transferHookProgram: PROGRAM_ID,
        });
        plan.push({ i: 0, tx, signers: [kp.config] });
      } else set(0, "done");
      for (const [i, mint, side] of [[1, kp.bull, "up"], [2, kp.bear, "down"]] as const) {
        if (exists[i]) {
          set(i, "done");
          continue;
        }
        const d = meta[side];
        const tx = await dbc.creator.createPoolWithTransferHook({
          name: d.name, symbol: d.symbol, uri: metaUri(um, side), payer, poolCreator: payer,
          config: kp.config.publicKey, baseMint: mint.publicKey, transferHookProgram: PROGRAM_ID,
        });
        plan.push({ i, tx, signers: [mint] });
      }
      if (!exists[3]) {
        const b = sideAccounts(keys, 0);
        const e = sideAccounts(keys, 1);
        const tx = new Transaction().add(
          cu(600_000),
          createAssociatedTokenAccountIdempotentInstruction(payer, b.escrow, keys.key, keys.bullMint, TOKEN_2022_PROGRAM_ID),
          createAssociatedTokenAccountIdempotentInstruction(payer, e.escrow, keys.key, keys.bearMint, TOKEN_2022_PROGRAM_ID),
          createMarketIx(payer, keys),
        );
        plan.push({ i: 3, tx, signers: [] });
      }
      if (plan.length) {
        const { blockhash } = await conn.getLatestBlockhash("confirmed");
        for (const p of plan) {
          p.tx.feePayer = payer;
          p.tx.recentBlockhash = blockhash;
          if (p.signers.length) p.tx.partialSign(...p.signers);
        }
        plan.forEach((p) => set(p.i, "active"));
        const signed = await signAllTransactions(plan.map((p) => p.tx));
        for (let k = 0; k < plan.length; k++) {
          try {
            await sendRaw(signed[k].serialize());
            set(plan[k].i, "done");
          } catch (e) {
            set(plan[k].i, "failed");
            for (const later of plan.slice(k + 1)) set(later.i, "idle");
            throw e;
          }
        }
      }
      try {
        localStorage.removeItem(keyStore(`${pool.obs.toBase58()}:${windowSecs}`));
      } catch {
        /* ignore */
      }
      const url = shareUrl(`/m/${keys.key.toBase58()}`, payer);
      toasts.push({ s: "ok", title: `$${under?.symbol} is live.`, body: "You're the referrer on this link." });
      window.open(tweetUrl(`I just cooked $${under?.symbol} at ±100×. Up or down, no liquidations. Pick a side before someone picks it for you.`, url), "_blank", "noopener");
      setListed({ symbol: under?.symbol ?? "TOKEN", key: keys.key.toBase58() });
    } catch (e) {
      setErr(humanError(e));
      setSteps((xs) => xs.map((x) => (x === "active" ? "idle" : x)));
    } finally {
      setBusy(false);
    }
  }

  const resumed = steps.some((s) => s === "done") || !!kp?.resumed;
  const canCreate = !!publicKey && !!keys && !!meta && !busy && !!pool?.health?.ok;
  const symbol = under?.symbol ?? "…";
  const stepLabel = (s: StepState) => (s === "idle" ? "pending" : s);
  return (
    <>
      <header className="mkt-head">
        <div>
          <div className="meta">
            <Link to="/">Board</Link> / list
          </div>
          <h1 className="display">List a coin.</h1>
          <p className="lede num nm-lede">Paste CA · pick oracle · sign once</p>
        </div>
        <div className="px">
          <button
            type="button"
            className="btn ghost small"
            disabled={!under}
            onClick={() => {
              navigator.clipboard?.writeText(currentShare(publicKey));
              toasts.push({ s: "ok", title: "Recipe copied", body: "Coin, pool, window. Anyone can finish it." });
            }}
          >
            Copy recipe
          </button>
        </div>
      </header>
      <div className="cfg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <section className="step">
            <div className="step-n">1</div>
            <div className="field">
              <label htmlFor="ca">
                <span className="meta">Coin · CA or CLMM pool</span>
                {resolving && <span className="meta">looking up…</span>}
              </label>
              <div className="input text" data-invalid={!!inputErr}>
                <input
                  id="ca"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="pumpCmXq…  or  45ssPkUQ…"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              {inputErr && <span className="err">{inputErr}</span>}
              {under && (
                <div className="asset">
                  {under.image && <img className="tokimg" src={under.image} alt="" />}
                  <b>{under.symbol}</b>
                  <span className="muted">{under.name}</span>
                  <span className="addr">{short(under.mint)}</span>
                </div>
              )}
            </div>
          </section>

          <section className="step" aria-disabled={!pools.length}>
            <div className="step-n">2</div>
            <div className="field">
              <span className="meta">Oracle · Raydium pool</span>
              {!pools.length ? (
                <p className="note">{under ? "No usable pool." : "Resolves after the coin."}</p>
              ) : (
                <div className="pools" role="radiogroup" aria-label="Oracle pool">
                  {pools.map((p, i) => (
                    <button
                      type="button"
                      key={p.id.toBase58()}
                      role="radio"
                      aria-checked={i === poolIdx}
                      className="pool"
                      onClick={() => {
                        setPoolIdx(i);
                        q.set({ pool: p.id.toBase58() });
                      }}
                      disabled={!p.health?.ok}
                      title={p.health?.ok ? undefined : "Too few observations to be an oracle"}
                    >
                      <span className="pool-pair">
                        {under?.symbol}/{p.quote}
                        <span className="addr"> {short(p.id.toBase58())}</span>
                      </span>
                      <span className="num">${p.tvl.toLocaleString("en-US", { maximumFractionDigits: 0 })} TVL</span>
                      <span className="num">${p.volume24h.toLocaleString("en-US", { maximumFractionDigits: 0 })} / 24h</span>
                      <span className={`num ${p.health?.ok ? "" : "down"}`}>
                        {p.health ? `${p.health.observations} obs · ${ago(Math.floor(Date.now() / 1000) - p.health.lastAgeSecs)}` : "no observations"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="step" aria-disabled={!pool}>
            <div className="step-n">3</div>
            <div className="field">
              <span className="meta">Window · price averaging</span>
              <div className="chips">
                {WINDOWS.map((w) => (
                  <button
                    type="button"
                    key={w.secs}
                    className="chip"
                    role="radio"
                    aria-checked={windowSecs === w.secs && customWin === ""}
                    onClick={() => {
                      setCustomWin("");
                      setWindowSecs(w.secs);
                    }}
                  >
                    {w.label} <span className="muted">· {w.note}</span>
                  </button>
                ))}
                <span className="chips-right">
                  <span className="meta">custom</span>
                  <span className="input text mini" data-invalid={customWin !== "" && !windowOk}>
                    <input
                      inputMode="numeric"
                      placeholder="min"
                      value={customWin}
                      aria-label="Custom window in minutes"
                      onChange={(e) => {
                        setCustomWin(e.target.value);
                        const m = Number(e.target.value);
                        if (Number.isFinite(m) && m > 0) setWindowSecs(Math.round(m * 60));
                      }}
                    />
                  </span>
                </span>
              </div>
            </div>
          </section>

          {existing.length > 0 && (
            <div className="callout">
              {existing.length === 1 ? "1 market" : `${existing.length} markets`} on this oracle:{" "}
              {existing.map((k) => (
                <Link key={k.toBase58()} to={`/m/${k.toBase58()}`} className="addr">
                  {short(k.toBase58())}
                </Link>
              ))}
              <span className="muted"> · new window ok · same window = duplicate</span>
            </div>
          )}
          {err && <p className="err">{err}</p>}

          {listed ? (
            <div className="card nm-done" data-live>
              <div className="card-head">
                <span className="card-ticker">
                  {under?.image && <img className="tokimg" src={under.image} alt="" />}${listed.symbol}
                </span>
                <span className="chip nm-live">live</span>
                <CardShare text={`Just listed $${listed.symbol} on 100x.broker · pick a side`} path={`/m/${listed.key}`} />
              </div>
              <div className="num muted">{short(listed.key)}</div>
              <button type="button" className="btn big lfg" onClick={() => nav(`/m/${listed.key}`)}>
                Open market →
              </button>
            </div>
          ) : (
            <button className="btn big lfg" type="submit" disabled={!canCreate} data-loading={busy}>
              {!publicKey ? "Connect to list" : resumed && !busy ? "Finish listing" : `List $${symbol} · LFG`}
            </button>
          )}

          <ol className="nm-progress" aria-label="Listing progress">
            {STEPS.map((s, i) => (
              <li key={s} className="chip nm-step" data-s={steps[i]}>
                <span className="dot" aria-hidden />
                {s}
                <span className="sr-only"> — {stepLabel(steps[i])}</span>
              </li>
            ))}
          </ol>
          <p className="note num nm-fine">
            ≈{EST_RENT_SOL} SOL rent · {STEPS.length} tx · 1 approval
          </p>

          <details className="nm-details">
            <summary className="meta">How it works</summary>
            <div className="nm-details-body">
              <p>Names, symbols, images: pulled from the token's own metadata.</p>
              <p>Market address commits to the mints, oracle and window.</p>
              <p>Window: shorter tracks faster but one fat trade can lean on it; longer is calmer. Only stored observations count — no same-block flashloans.</p>
              <p>Keys stay in this browser until the market exists. Close the tab mid-listing; it resumes.</p>
              <p>Same oracle, different window: allowed. Same window: duplicate.</p>
            </div>
          </details>
        </form>

        <aside className="col">
          <section className="panel">
            <h2 className="meta">The pair</h2>
            <div className="pair-cards">
              {(["up", "down"] as const).map((sd) => (
                <div className={`pair-card ${sd === "up" ? "u" : "d"}`} key={sd}>
                  {meta ? <img src={meta[sd].image} alt="" /> : <span className="skeleton img" />}
                  <div>
                    <div className="display">{sd === "up" ? "Up" : "Down"}</div>
                    <div className="num nm-genesis">{lev(LEVERAGE)} at genesis</div>
                    <div className="num">{meta ? meta[sd].symbol : "—"}</div>
                    <div className="muted">{meta ? meta[sd].name : under ? "naming…" : "paste a CA"}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="nm-stats">
              <div className="panel stat-card nm-stat">
                <span className="meta">Max lev</span>
                <span className="display num">{lev(LEVERAGE)}</span>
              </div>
              <div className="panel stat-card nm-stat">
                <span className="meta">Fee in</span>
                <span className="display num">{pct(CURVE_FEE_BPS / 10_000, 0)}</span>
              </div>
              <div className="panel stat-card nm-stat">
                <span className="meta">Fee out</span>
                <span className="display num">{pct(REDEEM_FEE, 0)}</span>
              </div>
            </div>
            <div className="panel-row">
              <span className="muted">Market</span>
              <span className="addr">{keys ? short(keys.key.toBase58()) : "—"}</span>
            </div>
          </section>
          {pool && (
            <section className="panel">
              <h2 className="meta">Oracle</h2>
              <div className="panel-row">
                <span className="muted">Pool</span>
                <span className="num">
                  {under?.symbol}/{pool.quote} · {short(pool.id.toBase58())}
                </span>
              </div>
              <div className="panel-row">
                <span className="muted">Observations</span>
                <span className="num">{pool.health?.observations ?? 0} / 100</span>
              </div>
              <div className="panel-row">
                <span className="muted">Ring span</span>
                <span className="num">{pool.health ? `${(pool.health.spanSecs / 60).toFixed(0)} min` : "—"}</span>
              </div>
              <div className="panel-row">
                <span className="muted">Last obs</span>
                <span className="num">{pool.health && Number.isFinite(pool.health.lastAgeSecs) ? ago(Math.floor(Date.now() / 1000) - pool.health.lastAgeSecs) : "—"}</span>
              </div>
              {pool.health && pool.health.spanSecs < windowSecs && <p className="note">Ring shorter than window · fills in over time.</p>}
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
