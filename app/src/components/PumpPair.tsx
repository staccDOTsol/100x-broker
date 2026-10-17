// A market's companion pump.fun coins: $TICKERUP / $TICKERDN, quoted in $100XBRO, creator = the connected wallet, creator fee 3%
// split lister 10% / Launch PDA 90% (the program boosts the side's vault with 80 and burns 10). A missing side is a resumable
// plan (2 tx + optional first buy); a launched side is a card read from /api/pumps.
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { conn, toV0, sendRaw, type MarketView } from "../lib/chain";
import { LAUNCH_CREATOR_FEE_BPS, LAUNCH_MODE_SHARED, LAUNCH_SPLIT, cu, launchPda, pumpCurvePda } from "../lib/hooked";
import { CU_BUY, CU_CREATE, CU_SHARE, PUMP_QUOTE, decodeSharingConfig, feeSharingConfigPda, firstBuyIxs, launchSideIxs, pumpUrl, quoteAtaOf, resolvePumpQuote, sharesSet, vanityMints } from "../lib/pump";
import { getDerivedMeta, metaUri, type DerivedMeta } from "../lib/das";
import { humanError, usePoll } from "../hooks";
import { useToasts } from "./Toasts";
import { Tweet } from "./Share";
import { lev } from "../lib/format";
import { MEME_SYMBOL } from "../config";
import type { PumpsPayload, PumpSide } from "../../api/pumps";

type StepState = "idle" | "active" | "done" | "failed";
const MODE = LAUNCH_MODE_SHARED;
const SIDES = ["UP", "DOWN"] as const;
const keyStore = (market: string) => `launch:${market}`;
type Saved = { up?: number[]; down?: number[]; vanity: boolean };

function readSaved(market: string): Saved | null {
  try {
    const raw = localStorage.getItem(keyStore(market));
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}
function keyOf(raw?: number[]): Keypair | null {
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  } catch {
    return null;
  }
}

/** Mint keypairs for the sides still to launch: resumed from this browser, else fresh `1oox…` keys from /api/vanity. */
async function loadOrMakeMints(market: string, sides: readonly (0 | 1)[]): Promise<{ mints: [Keypair | null, Keypair | null]; vanity: boolean; resumed: boolean }> {
  const saved = readSaved(market);
  const mints: [Keypair | null, Keypair | null] = [keyOf(saved?.up), keyOf(saved?.down)];
  const need = sides.filter((i) => !mints[i]);
  const fresh = need.length ? await vanityMints(need.length) : [];
  need.forEach((i, k) => {
    mints[i] = fresh[k].kp;
  });
  const freshVanity = fresh.length === 0 || fresh.every((f) => f.vanity);
  const vanity = freshVanity && (need.length === sides.length ? true : !!saved?.vanity);
  try {
    const next: Saved = {
      up: mints[0] ? [...mints[0].secretKey] : saved?.up,
      down: mints[1] ? [...mints[1].secretKey] : saved?.down,
      vanity,
    };
    localStorage.setItem(keyStore(market), JSON.stringify(next));
  } catch {
    /* private mode: single-shot only */
  }
  return { mints, vanity, resumed: need.length === 0 };
}

const fmtQ = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : x.toLocaleString("en-US", { maximumFractionDigits: x < 1 ? 6 : 2 }));

export function PumpPair({ v, ticker, onDone }: { v: MarketView; ticker: string; onDone: () => void }) {
  const market = v.acct.key.toBase58();
  const up = v.launches.up?.toBase58() ?? "";
  const down = v.launches.down?.toBase58() ?? "";
  const missing = useMemo(() => ([0, 1] as const).filter((i) => !(i ? down : up)), [up, down]);
  return (
    <section className="panel pp" id="pumps">
      <h2 className="meta">
        <a className="anchor" href="#pumps" aria-hidden tabIndex={-1} />
        Pumps · ${MEME_SYMBOL}
      </h2>
      {missing.length < 2 && <Live v={v} ticker={ticker} />}
      {missing.length > 0 && <Launch v={v} ticker={ticker} market={market} missing={missing} onDone={onDone} />}
      <p className="meta pp-loop">
        {LAUNCH_CREATOR_FEE_BPS / 100}% of trades → {LAUNCH_SPLIT.vault}% vault · {LAUNCH_SPLIT.lister}% you · {LAUNCH_SPLIT.burn}% burn
      </p>
    </section>
  );
}

function Live({ v, ticker }: { v: MarketView; ticker: string }) {
  const market = v.acct.key.toBase58();
  const pumps = usePoll(() => fetch(`/api/pumps?market=${market}`).then((r) => (r.ok ? (r.json() as Promise<PumpsPayload>) : Promise.reject(new Error(`pumps ${r.status}`)))), [market], 15_000);
  const [meta, setMeta] = useState<{ up: DerivedMeta; down: DerivedMeta } | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([getDerivedMeta(v.underlyingMint, "up"), getDerivedMeta(v.underlyingMint, "down")]).then(([up, down]) => alive && setMeta({ up, down })).catch(() => {});
    return () => {
      alive = false;
    };
  }, [v.underlyingMint]);
  const sides: [PumpSide | null, PumpSide | null] = [pumps.data?.up ?? null, pumps.data?.down ?? null];
  const live = ([0, 1] as const).filter((i) => (i ? v.launches.down : v.launches.up));
  return (
    <div className="pp-cards">
      {live.map((i) => {
        const mint = (i ? v.launches.down : v.launches.up)?.toBase58() ?? null;
        const s = sides[i];
        const m = meta?.[i ? "down" : "up"];
        return (
          <div className={`pp-card ${i ? "d" : "u"}`} key={i}>
            <div className="pp-head">
              {m ? <img src={m.image} alt="" /> : <span className="skeleton img" />}
              <div>
                <div className="display">
                  {SIDES[i]} · pump {s?.complete && <span className="chip pp-grad">graduated</span>}
                </div>
                <div className="num">{m?.symbol ?? v.side[i].symbol}</div>
              </div>
              {mint && (
                <span className="right h2-share">
                  <Tweet text={`$${m?.symbol ?? v.side[i].symbol} is live on pump.fun, quoted in $${MEME_SYMBOL}. 3% of every trade boosts the ${SIDES[i]} pot on $${ticker} (${lev(v.side[i].leverage)}).`} path={`/m/${market}#pumps`} />
                </span>
              )}
            </div>
            {mint ? (
              <>
                <div className="pp-stats num">
                  <span>
                    <span className="muted">price</span> {s ? fmtQ(s.price) : "—"} {MEME_SYMBOL}
                  </span>
                  <span>
                    <span className="muted">mcap</span> {s ? fmtQ(s.mcap) : "—"} {MEME_SYMBOL}
                  </span>
                  <span>
                    <span className="muted">curve</span> {s ? `${(s.progress * 100).toFixed(1)}%` : "—"}
                  </span>
                </div>
                {s && !s.complete && (
                  <div className="pp-bar" role="progressbar" aria-valuenow={Math.round(s.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                    <i style={{ width: `${Math.max(1, s.progress * 100)}%` }} />
                  </div>
                )}
                <div className="pp-foot">
                  <span className="pp-ca num">
                    <span className="muted">CA</span> <span className="addr">{mint}</span>
                  </span>
                  <a className="btn ghost small" href={pumpUrl(mint)} target="_blank" rel="noopener noreferrer">
                    pump.fun ↗
                  </a>
                </div>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Launch({ v, ticker, market, missing, onDone }: { v: MarketView; ticker: string; market: string; missing: readonly (0 | 1)[]; onDone: () => void }) {
  const { publicKey, signAllTransactions } = useWallet();
  const toasts = useToasts();
  const [buy, setBuy] = useState<[string, string]>(["", ""]);
  const [steps, setSteps] = useState<{ label: string; s: StepState }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ mints: { side: 0 | 1; ca: string }[]; vanity: boolean } | null>(null);
  const [preview, setPreview] = useState<{ ca: string; side: 0 | 1 }[]>([]);
  const [resumable, setResumable] = useState(false);
  useEffect(() => {
    const saved = readSaved(market);
    const rows = missing.flatMap((side) => {
      const kp = keyOf(side === 0 ? saved?.up : saved?.down);
      return kp ? [{ side, ca: kp.publicKey.toBase58() }] : [];
    });
    setPreview(rows);
    setResumable(rows.length === missing.length && rows.length > 0);
  }, [market, missing]);
  const pq = usePoll(() => resolvePumpQuote(conn), [], 60_000);
  const bal = usePoll(async () => {
    if (!publicKey || !pq.data) return null;
    try {
      const b = await conn.getTokenAccountBalance(quoteAtaOf(publicKey, pq.data.quote));
      return b.value.uiAmount ?? 0;
    } catch {
      return 0;
    }
  }, [publicKey?.toBase58(), pq.data ? 1 : 0], 20_000);
  const buyRaw = useMemo(() => buy.map((b) => BigInt(Math.round((Number(b) || 0) * 1e6))) as [bigint, bigint], [buy]);
  const totalBuy = Number(buyRaw[0] + buyRaw[1]) / 1e6;
  const overBudget = bal.data !== null && bal.data !== undefined && totalBuy > bal.data;
  const set = (i: number, s: StepState) => setSteps((xs) => xs.map((x, j) => (j === i ? { ...x, s } : x)));

  async function launch() {
    if (!publicKey || !signAllTransactions || !pq.data) return;
    setBusy(true);
    setErr(null);
    try {
      const payer = publicKey;
      const { mints, vanity } = await loadOrMakeMints(market, missing);
      const metas = await Promise.all(missing.map((i) => getDerivedMeta(v.underlyingMint, i ? "down" : "up")));
      // what already landed (a half-finished launch resumes with the same CA): curve, Launch PDA, sharing config per missing side
      const kps = missing.map((i) => mints[i]!);
      const probe = await conn.getMultipleAccountsInfo(kps.flatMap((m) => [pumpCurvePda(m.publicKey), launchPda(v.acct.key, missing[kps.indexOf(m)]), feeSharingConfigPda(m.publicKey)]));
      const plan: { label: string; tx: VersionedTransaction }[] = [];
      for (let n = 0; n < missing.length; n++) {
        const i = missing[n];
        const mint = kps[n];
        const [curve, launch, sc] = [probe[n * 3], probe[n * 3 + 1], probe[n * 3 + 2]];
        const built = await launchSideIxs({ payer, market: v.acct.key, side: i, mint: mint.publicKey, name: metas[n].name, symbol: metas[n].symbol, uri: metaUri(v.underlyingMint, i ? "down" : "up"), mode: MODE, pq: pq.data });
        if (!launch) {
          const ixs = curve ? [built.create[1]] : built.create; // curve landed but register_launch did not: just register
          const tx = await toV0([cu(CU_CREATE), ...ixs], payer);
          if (!curve) tx.sign([mint]);
          plan.push({ label: `${SIDES[i]} pump`, tx });
        }
        const setAlready = sc ? sharesSet(decodeSharingConfig(sc), MODE, payer, launchPda(v.acct.key, i)) : false;
        if (!setAlready) plan.push({ label: `${SIDES[i]} split`, tx: await toV0([cu(CU_SHARE), ...(sc ? built.share.filter((_, k) => k !== built.sharingIx) : built.share)], payer) });
        if (buyRaw[i] > 0n) plan.push({ label: `${SIDES[i]} buy`, tx: await toV0([cu(CU_BUY), ...(await firstBuyIxs({ payer, mint: mint.publicKey, creator: built.creator, buyQuote: buyRaw[i], pq: pq.data }))], payer) });
      }
      if (!plan.length) throw new Error("Those pumps are already live.");
      setSteps(plan.map((p) => ({ label: p.label, s: "active" })));
      const signed = await signAllTransactions(plan.map((p) => p.tx));
      for (let k = 0; k < plan.length; k++) {
        try {
          await sendRaw(signed[k].serialize());
          set(k, "done");
        } catch (e) {
          set(k, "failed");
          for (let j = k + 1; j < plan.length; j++) set(j, "idle");
          throw e;
        }
      }
      try {
        localStorage.removeItem(keyStore(market));
      } catch {
        /* ignore */
      }
      setDone({ mints: missing.map((i) => ({ side: i, ca: mints[i]!.publicKey.toBase58() })), vanity });
      setPreview(missing.map((i) => ({ side: i, ca: mints[i]!.publicKey.toBase58() })));
      toasts.push({ s: "ok", title: `$${ticker} pumps are live.`, body: `${metas.map((m) => m.symbol).join(" + ")} on pump.fun, quoted in $${MEME_SYMBOL}.` });
      onDone();
    } catch (e) {
      setErr(humanError(e));
      setSteps((xs) => xs.map((x) => (x.s === "active" ? { ...x, s: "idle" } : x)));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card pp-done" data-live>
        <div className="card-head">
          <span className="card-ticker">${ticker} pumps</span>
          <span className="chip nm-live">live</span>
        </div>
        <div className="display">
          UP {lev(v.side[0].leverage)} · DOWN {lev(v.side[1].leverage)}
        </div>
        {done.mints.map((m) => (
          <div className="pp-ca num" key={m.ca}>
            <span className="muted">{SIDES[m.side]} CA</span> <span className="addr">{m.ca}</span>{" "}
            <a href={pumpUrl(m.ca)} target="_blank" rel="noopener noreferrer">
              pump.fun ↗
            </a>
          </div>
        ))}
        {!done.vanity && <p className="note">Vanity stock was empty: plain addresses this time.</p>}
      </div>
    );
  }
  const canLaunch = !!publicKey && !!pq.data && !busy && !overBudget;
  return (
    <div className="pp-launch">
      <p className="note">
        {missing.length === 2
          ? `Give $${ticker} two pump.fun coins — ${v.side[0].symbol} and ${v.side[1].symbol} — quoted in $${MEME_SYMBOL}. You are the creator; every trade feeds the pots.`
          : `Launch the missing ${SIDES[missing[0]]} pump ($${v.side[missing[0]].symbol}), quoted in $${MEME_SYMBOL}. You are the creator.`}
      </p>
      {preview.length > 0 && (
        <div className="pp-cas">
          {preview.map((p) => (
            <div className="pp-ca num" key={p.side}>
              <span className="muted">{SIDES[p.side]} CA</span> <span className="addr">{p.ca}</span>
            </div>
          ))}
        </div>
      )}
      <div className="pp-buys">
        {missing.map((i) => (
          <label className="field" key={i}>
            <span className="meta">{SIDES[i]} first buy</span>
            <span className="input text mini">
              <input inputMode="decimal" placeholder="0" value={buy[i]} aria-label={`${SIDES[i]} first buy in ${MEME_SYMBOL}`} onChange={(e) => setBuy((b) => (i ? [b[0], e.target.value] : [e.target.value, b[1]]))} />
              <span className="muted">{MEME_SYMBOL}</span>
            </span>
          </label>
        ))}
        <span className="meta pp-bal num">
          {publicKey ? (bal.data === null || bal.data === undefined ? "…" : `${fmtQ(bal.data)} ${MEME_SYMBOL} in wallet`) : "connect to see balance"}
          {publicKey && bal.data === 0 && (
            <>
              {" · "}
              <a href={pumpUrl(PUMP_QUOTE)} target="_blank" rel="noopener noreferrer">
                get ${MEME_SYMBOL}
              </a>
            </>
          )}
        </span>
      </div>
      {overBudget && <p className="err">First buys exceed your ${MEME_SYMBOL}.</p>}
      {pq.error && <p className="err">{pq.error}</p>}
      {err && <p className="err">{err}</p>}
      <button type="button" className="btn big lfg" disabled={!canLaunch} data-loading={busy} onClick={launch}>
        {!publicKey ? "Connect to launch" : resumable && !busy ? "Finish launch" : missing.length === 2 ? `Launch $${ticker} pumps` : `Launch ${SIDES[missing[0]]}`}
      </button>
      {steps.length > 0 && (
        <ol className="nm-progress" aria-label="Launch progress">
          {steps.map((s, i) => (
            <li key={`${s.label}-${i}`} className="chip nm-step" data-s={s.s}>
              <span className="dot" aria-hidden />
              {s.label}
            </li>
          ))}
        </ol>
      )}
      <p className="note num nm-fine">≈0.02 SOL per side · 2 tx per side{totalBuy > 0 ? " + buys" : ""} · 1 approval · 1oox… addresses when the stockpile has them</p>
    </div>
  );
}

