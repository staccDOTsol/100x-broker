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
import { ago, short } from "../lib/format";
import { getDerivedMeta, getUnderlying, metaUri, type DerivedMeta, type Underlying } from "../lib/das";
import { shareUrl, tweetUrl } from "../lib/ref";
import { currentShare, useQuery } from "../lib/url";
import { DEFAULT_WINDOW_SECS, PROGRAM_ID, RAYDIUM_CLMM, RFSTACC } from "../config";

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
const STEPS = ["Curve config · hook = 100x, partner = market", "UP curve + mint", "DOWN curve + mint", "Market, vaults, hook accounts"];
const WINDOWS = [
  { secs: 900, label: "15 min", note: "reacts fast · easier to push" },
  { secs: DEFAULT_WINDOW_SECS, label: "66 min", note: "house default" },
  { secs: 14_400, label: "4 h", note: "calm · slow to react" },
];
const EST_RENT_SOL = 0.04;

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
      toasts.push({ s: "ok", title: `$${under?.symbol} ±100× is live. You cooked.`, body: "Your wallet is the referrer on this link." });
      window.open(tweetUrl(`I just cooked $${under?.symbol} at ±100×. Up or down, no liquidations. Pick a side before someone picks it for you.`, url), "_blank", "noopener");
      nav(`/m/${keys.key.toBase58()}`);
    } catch (e) {
      setErr(humanError(e));
      setSteps((xs) => xs.map((x) => (x === "active" ? "idle" : x)));
    } finally {
      setBusy(false);
    }
  }

  const resumed = steps.some((s) => s === "done") || !!kp?.resumed;
  const canCreate = !!publicKey && !!keys && !!meta && !busy && !!pool?.health?.ok;
  return (
    <>
      <header className="mkt-head">
        <div>
          <div className="meta">
            <Link to="/">Board</Link> / list a market
          </div>
          <h1 className="display">Cook up a ±100× pair</h1>
          <p className="lede">Any coin with a Raydium CLMM pool. Paste the CA; we find the oracle, name the pair, you sign once. Yes, even that one.</p>
        </div>
        <div className="px">
          <button
            type="button"
            className="btn ghost small"
            disabled={!under}
            onClick={() => {
              navigator.clipboard?.writeText(currentShare(publicKey));
              toasts.push({ s: "ok", title: "Recipe copied", body: "Coin, pool and window are in it — anyone can finish cooking this." });
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
                <span className="meta">The coin · paste a CA (or a Raydium CLMM pool)</span>
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
              <span className="meta">The oracle · which Raydium pool calls the price</span>
              {!pools.length ? (
                <p className="note">{under ? "No usable pool. Tragic." : "Pools show up once the coin resolves."}</p>
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
                      title={p.health?.ok ? undefined : "This pool hasn't recorded enough observations to be an oracle"}
                    >
                      <span className="pool-pair">
                        {under?.symbol}/{p.quote}
                        <span className="addr"> {short(p.id.toBase58())}</span>
                      </span>
                      <span className="num">${p.tvl.toLocaleString("en-US", { maximumFractionDigits: 0 })} TVL</span>
                      <span className="num">${p.volume24h.toLocaleString("en-US", { maximumFractionDigits: 0 })} / 24h</span>
                      <span className={`num ${p.health?.ok ? "" : "down"}`}>
                        {p.health ? `${p.health.observations} obs · last ${ago(Math.floor(Date.now() / 1000) - p.health.lastAgeSecs)}` : "no observations"}
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
              <span className="meta">The window · how much history each twitch averages</span>
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
              <p className="note">
Shorter tracks the coin faster but one fat trade can lean on it. Longer is calmer. Either way only stored observations count —
                nobody flashloans this in the same block.
              </p>
            </div>
          </section>

          {existing.length > 0 && (
            <div className="callout">
              This oracle already has {existing.length === 1 ? "a market" : `${existing.length} markets`}:{" "}
              {existing.map((k) => (
                <Link key={k.toBase58()} to={`/m/${k.toBase58()}`} className="addr">
                  {short(k.toBase58())}
                </Link>
              ))}
              . Listing another with a different window is allowed; the same window would be a duplicate.
            </div>
          )}
          {err && <p className="err">{err}</p>}
          <button className="btn big" type="submit" disabled={!canCreate} data-loading={busy}>
            {!publicKey ? "Connect a wallet to cook" : resumed && !busy ? "Finish cooking" : `Cook $${under?.symbol ?? "…"} ±100×`}
          </button>
          <p className="note">
            ≈{EST_RENT_SOL} SOL in account rent · 4 transactions, one approval · names, symbols and images come from the token's own
            metadata. The market address commits to the mints, oracle and window.
          </p>
        </form>

        <aside className="col">
          <section className="panel">
            <h2 className="meta">Your pair · meet the twins</h2>
            <div className="pair-cards">
              {(["up", "down"] as const).map((sd) => (
                <div className={`pair-card ${sd === "up" ? "u" : "d"}`} key={sd}>
                  {meta ? <img src={meta[sd].image} alt="" /> : <span className="skeleton img" />}
                  <div>
                    <div className="display">{sd === "up" ? "Up" : "Down"} 100×</div>
                    <div className="num">{meta ? meta[sd].symbol : "—"}</div>
                    <div className="muted">{meta ? meta[sd].name : under ? "cooking…" : "paste a CA first"}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="panel-row">
              <span className="muted">Market address</span>
              <span className="addr">{keys ? short(keys.key.toBase58()) : "—"}</span>
            </div>
            <div className="panel-row">
              <span className="muted">Leverage · curve fee · redeem fee</span>
              <span className="num">100× · 4% · 4%</span>
            </div>
          </section>
          {pool && (
            <section className="panel">
              <h2 className="meta">Oracle health</h2>
              <div className="panel-row">
                <span className="muted">Pool</span>
                <span className="num">
                  {under?.symbol}/{pool.quote} · {short(pool.id.toBase58())}
                </span>
              </div>
              <div className="panel-row">
                <span className="muted">Stored observations</span>
                <span className="num">{pool.health?.observations ?? 0} / 100</span>
              </div>
              <div className="panel-row">
                <span className="muted">Ring spans</span>
                <span className="num">{pool.health ? `${(pool.health.spanSecs / 60).toFixed(0)} min` : "—"}</span>
              </div>
              <div className="panel-row">
                <span className="muted">Last observation</span>
                <span className="num">{pool.health && Number.isFinite(pool.health.lastAgeSecs) ? ago(Math.floor(Date.now() / 1000) - pool.health.lastAgeSecs) : "—"}</span>
              </div>
              {pool.health && pool.health.spanSecs < windowSecs && (
                <p className="note">
                  The ring holds less history than your window right now; the market keeps its own checkpoints and the window fills in
                  over time.
                </p>
              )}
            </section>
          )}
          <section className="panel">
            <h2 className="meta">Steps</h2>
            <ol className="steps">
              {STEPS.map((s, i) => (
                <li key={s} data-s={steps[i]}>
                  <span className="dot" aria-hidden />
                  <span>
                    {s}
                    <span className="sr-only"> — {steps[i]}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="note">Keys live in this browser until the market exists — close the tab mid-cook and it resumes where you left it.</p>
          </section>
        </aside>
      </div>
    </>
  );
}
