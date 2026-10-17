// The default side of /launch: your coin on pump.fun, quoted in $100XBRO (3% creator fee to you), with a first buy whose
// coins are spread single-sided across Orca pools (configs 12Nqk2 runs; 25% protocol cut) against $100XBRO plus whatever
// quotes you pick. Every pool opens at pump's price right after your buy and runs to 10,000x it. Built and signed here in the
// browser: one approval signs the optional SOL -> $100XBRO swap, the pump create + buy, and every pool; then each is sent and
// resent until it lands. A coin that already exists (this page's, or one you paste) skips straight to the pools.
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, VersionedTransaction, type AddressLookupTableAccount, type Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { conn } from "../lib/chain";
import { blast, type BlastState } from "../lib/blast";
import { planPools, poolIxs, v0, COIN_DECIMALS, RANGE, type PoolPlan, type Quote, type Slot } from "../lib/orcalaunch";
import { coinLaunchIxs, firstBuyPrice, LAUNCH_ALT } from "../lib/coinlaunch";
import { bondingCurvePda, curveStats, pumpUrl, resolvePumpQuote, type PumpQuote } from "../lib/pump";
import { QUOTE_100XBRO } from "../lib/orcaquotes";
import { MEME_MINT } from "../config";
import { humanError } from "../hooks";
import { tweetUrl } from "../lib/ref";
import { short } from "../lib/format";

const PUMP_SOL = 0.02; // pump create + first buy: mint, curve, token accounts, fees
const POOL_SOL = 0.0242; // pool, vaults, tick arrays, position, measured on a fork
const BUYS = [100_000, 500_000, 1_000_000, 5_000_000]; // first buy in $100XBRO
const CAPS = [1e6, 1e7, 1e8, 1e9]; // only for pouring a coin that has no pump curve: its market cap in $100XBRO
type Menu = { slots: (Slot & { protocolFee: number })[]; quotes: (Quote & { trending: boolean })[]; alt: string | null };
type Row = { plan: PoolPlan; state: BlastState | "idle"; why?: string; pool?: string };
type Coin = { mint: PublicKey; symbol: string; held: bigint; price: number | null };
const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : n.toPrecision(3));
const money = (u: number) => (u >= 1 ? `$${u.toLocaleString("en-US", { maximumFractionDigits: u >= 100 ? 0 : 2 })}` : `$${u.toPrecision(2)}`);
const b64tx = (s: string) => VersionedTransaction.deserialize(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const MINTED_KEY = "orca-launch-minted";
const remembered = (): { mint: string; symbol: string }[] => {
  try {
    return JSON.parse(localStorage.getItem(MINTED_KEY) ?? "[]");
  } catch {
    return [];
  }
};
const remember = (mint: string, symbol: string) => {
  try {
    localStorage.setItem(MINTED_KEY, JSON.stringify([{ mint, symbol }, ...remembered().filter((x) => x.mint !== mint)].slice(0, 10)));
  } catch {
    /* private window: the CA box still works */
  }
};

export function OrcaLaunch(p: { missing: string | null; name: string; symbol: string; mint: Keypair | null; uploadMeta: () => Promise<string> }) {
  const { publicKey, signAllTransactions } = useWallet();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [menuErr, setMenuErr] = useState<string | null>(null);
  const [pq, setPq] = useState<PumpQuote | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set([QUOTE_100XBRO, "So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]));
  const [buy, setBuy] = useState("500000");
  const [cap, setCap] = useState(1e7);
  const [count, setCount] = useState(6);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [coinLive, setCoinLive] = useState(false);
  const [sol, setSol] = useState<number | null>(null);
  const [held, setHeld] = useState<bigint | null>(null);
  const [resume, setResume] = useState<Coin | null>(null);
  const [resumeInput, setResumeInput] = useState("");
  const [resumeErr, setResumeErr] = useState<string | null>(null);
  const [mine, setMine] = useState<{ mint: string; symbol: string }[]>([]);

  useEffect(() => {
    fetch("/api/launch?orca=1").then((r) => r.json()).then((j) => (j.error ? setMenuErr(j.error) : setMenu(j))).catch((e) => setMenuErr(String(e)));
    resolvePumpQuote(conn).then(setPq).catch((e) => setMenuErr(`pump: ${humanError(e)}`));
  }, []);
  useEffect(() => setMine(remembered()), [busy]);
  useEffect(() => {
    if (!publicKey) return;
    conn.getBalance(publicKey).then((l) => setSol(l / 1e9)).catch(() => null);
    conn.getTokenAccountBalance(getAssociatedTokenAddressSync(MEME_MINT, publicKey, false, TOKEN_2022_PROGRAM_ID)).then((b) => setHeld(BigInt(b.value.amount))).catch(() => setHeld(0n));
  }, [publicKey, busy]);

  const quotes = useMemo(() => (menu?.quotes ?? []).filter((q) => picked.has(q.mint)), [menu, picked]);
  const xbro = menu?.quotes.find((q) => q.mint === QUOTE_100XBRO) ?? null;
  const buyN = Number(buy) || 0;
  const buyQuote = BigInt(Math.floor(buyN * 10 ** COIN_DECIMALS));
  const est = useMemo(() => (pq && buyQuote > 0n ? firstBuyPrice(pq, buyQuote) : null), [pq, buyQuote]);
  const short100x = !resume && held !== null && buyQuote > held ? buyQuote - held : 0n;
  const maxPools = Math.max(1, Math.min(64, (menu?.slots.length ?? 0) * Math.max(1, quotes.length)));
  const pools = Math.min(count, maxPools);
  const coins = resume ? resume.held : (est?.tokens ?? 0n);
  const plans = useMemo(() => (menu && quotes.length && coins > 0n ? planPools(menu.slots, quotes, pools, coins) : []), [menu, quotes, pools, coins]);
  // where the pools open: pump's price after your buy; for a coin you're pouring, its curve's price now (or the cap you pick)
  const priceIn100x = resume ? (resume.price ?? cap / 1e9) : (est?.after ?? 0);
  const usdPrice = xbro ? priceIn100x * xbro.usd : null;
  const needSol = (resume ? 0 : PUMP_SOL) + POOL_SOL * plans.length;
  const fees = plans.reduce((m, x) => m.add(`${(x.slot.fee / 1e4).toFixed(2)}%`), new Set<string>());

  function toggle(mint: string) {
    if (mint === QUOTE_100XBRO) return; // always paired against $100XBRO
    setPicked((s) => { const n = new Set(s); if (n.has(mint)) n.delete(mint); else n.add(mint); return n; });
  }

  /** A coin that already exists, to pour: Token-2022, 6 decimals, held by this wallet; priced off its pump curve if it has one. */
  async function loadCoin(ca: string): Promise<Coin> {
    if (!publicKey) throw new Error("connect your wallet first");
    let mint: PublicKey;
    try {
      mint = new PublicKey(ca.trim());
    } catch {
      throw new Error("that isn't a coin address");
    }
    const [info, curve] = await Promise.all([conn.getParsedAccountInfo(mint), conn.getAccountInfo(bondingCurvePda(mint))]);
    const v = info.value;
    const parsed = v && "parsed" in v.data ? (v.data.parsed as { info?: { decimals?: number; extensions?: { extension: string; state?: { symbol?: string } }[] } }) : null;
    if (!v || !parsed?.info) throw new Error("no coin at that address yet");
    if (!v.owner.equals(TOKEN_2022_PROGRAM_ID) || parsed.info.decimals !== COIN_DECIMALS) throw new Error("only Token-2022 coins with 6 decimals (pump coins and coins minted here)");
    const symbol = parsed.info.extensions?.find((e) => e.extension === "tokenMetadata")?.state?.symbol ?? ca.slice(0, 4);
    const bal = await conn.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_2022_PROGRAM_ID)).catch(() => null);
    const h = BigInt(bal?.value.amount ?? "0");
    if (h === 0n) throw new Error(`this wallet holds no $${symbol}`);
    let price: number | null = null;
    try {
      price = curve ? curveStats(mint, curve).price : null;
    } catch {
      price = null;
    }
    return { mint, symbol, held: h, price };
  }
  async function pickResume(ca: string) {
    setResumeErr(null);
    try {
      setResume(await loadCoin(ca));
    } catch (e) {
      setResumeErr(humanError(e));
    }
  }

  async function build(todo: PoolPlan[], create: boolean, coin: PublicKey, price: number) {
    const owner = publicKey!;
    const mint = p.mint!;
    const [orcaAlt, pumpAlt] = await Promise.all([
      menu!.alt ? conn.getAddressLookupTable(new PublicKey(menu!.alt)).then((r) => r.value) : Promise.resolve(null),
      create ? conn.getAddressLookupTable(LAUNCH_ALT).then((r) => r.value) : Promise.resolve(null),
    ]);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    let zap: VersionedTransaction | null = null;
    let launch: VersionedTransaction | null = null;
    if (create) {
      // short on $100XBRO for the first buy: a SOL -> $100XBRO swap goes first (the route comes from the server)
      if (short100x > 0n) {
        const r = await fetch("/api/launch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "zap", wallet: owner.toBase58(), amount: short100x.toString() }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "couldn't route SOL into $100XBRO");
        zap = b64tx(j.tx);
      }
      const uri = await p.uploadMeta();
      const r = await coinLaunchIxs(conn, { wallet: owner, mint: mint.publicKey, name: p.name, symbol: p.symbol, uri, buyQuote, war: false, quoteUsd: xbro!.usd, pq: pq! });
      launch = v0(owner, r.coin, blockhash, pumpAlt ? [pumpAlt] : [], 400_000, [mint]);
    }
    const alts: AddressLookupTableAccount[] = orcaAlt ? [orcaAlt] : [];
    const built = todo.map((plan) => {
      // the same price in every quote: $100XBRO price x $100XBRO's USD / the quote's USD
      const r = poolIxs({ owner, coin, plan, coinPriceInQuote: (price * xbro!.usd) / plan.quote.usd });
      const tx = v0(owner, r.ixs, blockhash, alts, 400_000, r.signers);
      const size = tx.serialize().length;
      if (size > 1232) throw new Error(`the ${plan.quote.symbol} pool's transaction is ${size} bytes (max 1232); the launch lookup table isn't set up for it yet`);
      return { tx, pool: r.pool.toBase58() };
    });
    return { zap, launch, pools: built, lastValidBlockHeight };
  }

  /** fresh: a new launch (new progress rows); otherwise a retry of the pools that missed. */
  async function send(todo: PoolPlan[], fresh: boolean) {
    if (!publicKey || !signAllTransactions || !p.mint || !menu || !xbro || !pq) return;
    setBusy(true);
    setErr(null);
    if (fresh) setRows(todo.map((plan) => ({ plan, state: "idle" as const })));
    try {
      // this page's coin already exists (an earlier try created it): pour it instead of creating it again
      let coin = resume;
      if (!coin && (await conn.getAccountInfo(p.mint.publicKey))) {
        coin = await loadCoin(p.mint.publicKey.toBase58());
        setResume(coin);
      }
      const create = fresh && !coin;
      if (create && buyQuote <= 0n) throw new Error("the first buy is what fills the pools: pick an amount");
      const need = (create ? PUMP_SOL : 0) + POOL_SOL * todo.length;
      if (sol !== null && sol < need) throw new Error(`this needs about ${need.toFixed(3)} SOL${short100x > 0n ? " plus the swap into $100XBRO" : ""} and the wallet has ${sol.toFixed(3)}`);
      const price = coin ? (coin.price ?? cap / 1e9) : est!.after;
      const b = await build(todo, create, coin?.mint ?? p.mint.publicKey, price);
      const all = [...(b.zap ? [b.zap] : []), ...(b.launch ? [b.launch] : []), ...b.pools.map((x) => x.tx)];
      const signed = await signAllTransactions(all);
      if (create) remember(p.mint.publicKey.toBase58(), p.symbol);
      let k = 0;
      if (b.zap) {
        const z = await blast(conn, [signed[k++]], b.lastValidBlockHeight, () => null);
        if (!z.ok[0]) throw new Error("the swap into $100XBRO didn't land; nothing else was sent");
      }
      if (b.launch) {
        const m = await blast(conn, [signed[k++]], b.lastValidBlockHeight, () => null);
        // trust the chain over our status read: if the coin exists, it landed
        if (!m.ok[0] && !(await conn.getAccountInfo(p.mint.publicKey))) throw new Error("the pump launch didn't land; no pools were sent");
      }
      setCoinLive(true);
      const idx = (plan: PoolPlan) => (fresh ? todo.indexOf(plan) : rows.findIndex((r) => r.plan === plan));
      const update = (i: number, s: BlastState, why?: string, pool?: string) =>
        setRows((xs) => xs.map((r, j) => (j === i ? { ...r, state: s, why, pool: pool ?? r.pool } : r)));
      todo.forEach((plan, j) => update(idx(plan), "sending", undefined, b.pools[j].pool));
      await blast(conn, signed.slice(k), b.lastValidBlockHeight, (j, s, why) => update(idx(todo[j]), s, why));
    } catch (e) {
      setErr(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  const failed = rows.filter((r) => r.state === "failed");
  const landed = rows.filter((r) => r.state === "done").length;
  const mintKey = resume?.mint.toBase58() ?? p.mint?.publicKey.toBase58() ?? "";
  const ticker = resume?.symbol ?? p.symbol;
  if (menuErr) return <p className="err">Couldn't load the launcher: {menuErr}</p>;
  if (!menu || !pq) return <p className="note">Loading pump and the pools menu…</p>;

  return (
    <>
      {resume ? (
        <section className="step">
          <div className="step-n">3</div>
          <div className="field">
            <span className="meta">Pouring an existing coin</span>
            <p className="note">
              <b>${resume.symbol}</b> <span className="addr">{short(resume.mint.toBase58())}</span>: your {compact(Number(resume.held) / 10 ** COIN_DECIMALS)} coins go into the pools, nothing new is created.{" "}
              <button type="button" className="btn ghost small" onClick={() => setResume(null)} disabled={busy}>
                cancel
              </button>
            </p>
            {resume.price === null && (
              <>
                <span className="meta">No pump curve: pick its starting market cap in $100XBRO</span>
                <div className="chips" role="radiogroup" aria-label="Starting market cap">
                  {CAPS.map((c) => (
                    <button type="button" key={c} className="chip" role="radio" aria-checked={cap === c} onClick={() => setCap(c)}>
                      {compact(c)}
                      {xbro && <span className="muted"> · {money(c * xbro.usd)}</span>}
                    </button>
                  ))}
                </div>
              </>
            )}
            <p className="note">Pools open at {priceIn100x.toPrecision(3)} $100XBRO per coin{usdPrice !== null ? ` (${usdPrice.toPrecision(2)} USD)` : ""} and run to {RANGE.toLocaleString()}× it.</p>
          </div>
        </section>
      ) : (
        <section className="step">
          <div className="step-n">3</div>
          <div className="field">
            <label htmlFor="ln-buy">
              <span className="meta">First buy on pump · $100XBRO</span>
              {held !== null && <span className="meta">you hold {compact(Number(held) / 1e6)}</span>}
            </label>
            <div className="input">
              <input id="ln-buy" inputMode="decimal" value={buy} onChange={(e) => setBuy(e.target.value.replace(/[^0-9.]/g, ""))} />
              <span className="unit">{xbro && buyN > 0 ? `≈ ${money(buyN * xbro.usd)}` : "$100XBRO"}</span>
            </div>
            <div className="chips">
              {BUYS.map((n) => (
                <button type="button" key={n} className="chip" role="radio" aria-checked={buyN === n} onClick={() => setBuy(String(n))}>
                  {compact(n)}
                  {xbro && <span className="muted"> · {money(n * xbro.usd)}</span>}
                </button>
              ))}
            </div>
            {est && (
              <p className="note">
                Your buy gets {compact(Number(est.tokens) / 1e6)} coins, and every one of them goes into the Orca pools. Pump's price after it: {est.after.toPrecision(3)} $100XBRO
                {usdPrice !== null ? ` (${usdPrice.toPrecision(2)} USD)` : ""}. The pools open there and run to {RANGE.toLocaleString()}× it.
              </p>
            )}
            {short100x > 0n && <p className="note">You're {compact(Number(short100x) / 1e6)} $100XBRO short, so SOL gets swapped into it first. Same approval.</p>}
          </div>
        </section>
      )}

      <section className="step">
        <div className="step-n">4</div>
        <div className="field">
          <span className="meta">Quotes · each one gets its own pools</span>
          <div className="chips ln-quotes">
            {menu.quotes.map((q) => (
              <button type="button" key={q.mint} className="chip" role="checkbox" aria-checked={picked.has(q.mint)} aria-disabled={q.mint === QUOTE_100XBRO} onClick={() => toggle(q.mint)} title={`${q.symbol} · ${money(q.usd)}`}>
                {q.trending && <span aria-label="trending">🔥 </span>}
                {q.mint === QUOTE_100XBRO ? "$100XBRO" : q.symbol}
                {q.mint === QUOTE_100XBRO && <span className="muted"> · always</span>}
              </button>
            ))}
          </div>
          <label htmlFor="ln-pools" className="ln-slider-label">
            <span className="meta">Pools</span>
            <span className="num">{pools} of {maxPools}</span>
          </label>
          <input id="ln-pools" className="ln-slider" type="range" min={1} max={maxPools} value={pools} onChange={(e) => setCount(Number(e.target.value))} />
          <p className="note">
            {plans.length} pools across {new Set(plans.map((x) => x.slot.config)).size} configs · fee tiers {[...fees].join(", ") || "—"} · {compact(Number(coins / BigInt(Math.max(1, plans.length))) / 1e6)} coins in each · ≈{needSol.toFixed(3)} SOL rent + fees
            {sol !== null && <> · you have {sol.toFixed(3)} SOL</>}
          </p>
        </div>
      </section>

      {!resume && (
        <section className="step">
          <div className="step-n">5</div>
          <div className="field">
            <span className="meta">Already have the coin? Pour it instead</span>
            {mine.length > 0 && (
              <div className="chips">
                {mine.map((m) => (
                  <button type="button" key={m.mint} className="chip" onClick={() => void pickResume(m.mint)}>
                    ${m.symbol} <span className="addr">{short(m.mint)}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="input text">
              <input value={resumeInput} onChange={(e) => setResumeInput(e.target.value)} placeholder="its coin address (CA)" spellCheck={false} autoComplete="off" aria-label="Coin address to pour" />
              <button type="button" className="btn small" onClick={() => void pickResume(resumeInput)} disabled={!resumeInput.trim()}>
                Use it
              </button>
            </div>
            {resumeErr && <span className="err">{resumeErr}</span>}
          </div>
        </section>
      )}

      {err && <p className="err">{err}</p>}
      {coinLive && landed > 0 && !busy ? (
        <div className="card nm-done" data-live>
          <div className="card-head">
            <span className="card-ticker">${ticker}</span>
            <span className="chip nm-live">{landed} pools live</span>
          </div>
          <div className="num muted">
            {mintKey}{" "}
            <button type="button" className="btn ghost small" onClick={() => navigator.clipboard?.writeText(mintKey)}>
              copy CA
            </button>
          </div>
          <div className="ln-done-links">
            <a className="btn big lfg" href={tweetUrl(`just launched $${ticker} on pump, quoted in $100XBRO, with ${landed} Orca pools single-sided to ${RANGE.toLocaleString()}x.\nCA ${mintKey}`, pumpUrl(mintKey))} target="_blank" rel="noopener">
              post ↗
            </a>
            <a className="btn" href={pumpUrl(mintKey)} target="_blank" rel="noopener">
              pump.fun
            </a>
            {failed.length > 0 && (
              <button type="button" className="btn" onClick={() => void send(failed.map((r) => r.plan), false)}>
                Retry {failed.length} that missed
              </button>
            )}
          </div>
        </div>
      ) : (
        <button className="btn big lfg" type="button" disabled={!publicKey || busy || !xbro || !plans.length || (!resume && (!p.mint || !!p.missing))} data-loading={busy} onClick={() => void send(plans, true)}>
          {!publicKey ? "Connect to launch" : busy ? "Launching…" : resume ? `Pour $${resume.symbol} into ${plans.length} pools · LFG` : !p.mint ? "Getting your mint…" : p.missing ? p.missing : `Launch $${p.symbol} on pump + ${plans.length} Orca pools · LFG`}
        </button>
      )}
      {rows.length > 0 && (
        <ol className="nm-progress" aria-label="Pools">
          <li className="chip nm-step" data-s={coinLive ? "done" : busy ? "active" : "idle"}>
            <span className="dot" aria-hidden />
            {resume ? "coin" : "pump + first buy"}
          </li>
          {rows.map((r, k) => (
            <li key={k} className="chip nm-step" data-s={r.state === "sending" ? "active" : r.state} title={r.why ?? (r.pool ? `pool ${r.pool}` : "")}>
              <span className="dot" aria-hidden />
              {r.plan.quote.symbol} · {r.plan.slot.kind === "adaptive" ? "dyn " : ""}{(r.plan.slot.fee / 1e4).toFixed(2)}%
              {r.pool && r.state === "done" && <span className="addr"> {short(r.pool)}</span>}
            </li>
          ))}
        </ol>
      )}
      <p className="note num nm-fine">1 approval · {plans.length + (resume ? 0 : 1) + (short100x > 0n ? 1 : 0)} transactions, built in this browser · resent until they land</p>
    </>
  );
}
