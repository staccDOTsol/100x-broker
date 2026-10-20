import { assertTransactionDeployment } from "../lib/deployment";
// 100x.broker/launch: two launchers, both pump.fun coins quoted in $100XBRO. "pump + Orca pools" (LaunchOrca.tsx, the
// default, built entirely in the browser) spreads your first buy single-sided across Orca pools. "pump only" (below) is the
// plain pump launch with an optional first buy and war, built by the server. You pick the name, ticker, image, description and
// links; the 3% creator fee is yours; an optional first buy; and optionally a Last Bid Wins war on the coin. The server
// (api/launch.ts) stores the metadata and builds the transactions; the mint key comes from the 1oox stockpile and signs here.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction, type Keypair } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { conn, sendRaw } from "../lib/chain";
import { vanityMints } from "../lib/pump";
import { humanError } from "../hooks";
import { tweetUrl } from "../lib/ref";
import { short } from "../lib/format";
import { MEME_MINT } from "../config";
import { OrcaLaunch } from "./LaunchOrca";

const MAX_IMAGE = 2_500_000;
const BUYS = [0, 100_000, 500_000, 1_000_000];
type StepState = "idle" | "active" | "done" | "failed";
type Built = { txs: string[]; mintTx: number; summary: Summary };
type Summary = {
  mint: string; symbol: string; pump: string; play: string | null;
  buy: { quote: number; usd: number; tokens: number } | null;
  game: { id: number; opened: boolean; minBid: number } | null;
  zap: { lamports: string; via: string } | null;
};
const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K` : n.toFixed(n >= 1 ? 0 : 2));
const money = (u: number | null) => (u === null ? "" : u >= 1 ? `$${u.toFixed(2)}` : `$${u.toPrecision(2)}`);
const post = async (body: unknown) => {
  const r = await fetch("/api/launch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `launch API ${r.status}` }));
  if (!r.ok) throw new Error(j.error ?? `launch API ${r.status}`);
  return j;
};

export default function Launch() {
  const { publicKey, signAllTransactions } = useWallet();
  const [image, setImage] = useState<string | null>(null);
  const [imageErr, setImageErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [about, setAbout] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [buy, setBuy] = useState("0");
  const [war, setWar] = useState(true);
  const [quoteUsd, setQuoteUsd] = useState<number | null>(null);
  const [held, setHeld] = useState<number | null>(null);
  const [mint, setMint] = useState<Keypair | null>(null);
  const [uploaded, setUploaded] = useState<{ key: string; uri: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [plan, setPlan] = useState<string[]>([]);
  const [done, setDone] = useState<Summary | null>(null);
  const [mode, setMode] = useState<"orca" | "pump">(() => (new URLSearchParams(window.location.search).get("mode") === "pump" ? "pump" : "orca"));

  useEffect(() => {
    fetch("/api/launch").then((r) => r.json()).then((j) => setQuoteUsd(j.quote?.usd ?? null)).catch(() => null);
    vanityMints(1).then(([m]) => setMint(m.kp)).catch(() => null);
  }, []);
  useEffect(() => {
    if (!publicKey) return setHeld(null);
    const ata = getAssociatedTokenAddressSync(MEME_MINT, publicKey, false, TOKEN_2022_PROGRAM_ID);
    conn.getTokenAccountBalance(ata).then((b) => setHeld(Number(b.value.uiAmount ?? 0))).catch(() => setHeld(0));
  }, [publicKey]);

  const sym = symbol.replace(/^\$/, "").toUpperCase();
  const buyN = Number(buy) || 0;
  const mintKey = mint?.publicKey.toBase58() ?? null;
  const play = mintKey ? `lastbidwins.fun/play/${mintKey}` : "lastbidwins.fun/play/<your coin>";
  const short_ = held !== null && buyN > held ? buyN - held : 0;
  // what the form is still missing, in the order you'd fix it
  const missing = useMemo(() => {
    if (!image) return "add an image";
    if (!name.trim()) return "name it";
    if (!/^[A-Z0-9]{1,10}$/.test(sym)) return "ticker: letters and numbers, up to 10";
    if (!Number.isFinite(Number(buy)) || Number(buy) < 0) return "first buy must be a number";
    return null;
  }, [image, name, sym, buy]);
  const metaKey = JSON.stringify([image?.length, name, sym, about, website, twitter, telegram, war]);

  function pickImage(f: File | undefined) {
    setImageErr(null);
    if (!f) return;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return setImageErr("png, jpg, gif or webp");
    if (f.size > MAX_IMAGE) return setImageErr("keep it under 2.5 MB");
    const rd = new FileReader();
    rd.onload = () => setImage(String(rd.result));
    rd.readAsDataURL(f);
  }

  async function uploadOrcaMeta() {
    const key = `orca:${metaKey}`;
    if (uploaded?.key === key) return uploaded.uri;
    const m = await post({ op: "meta", mint: mint!.publicKey.toBase58(), name, symbol: sym, description: about, website, twitter, telegram, war: false, image });
    setUploaded({ key, uri: m.uri });
    return m.uri as string;
  }

  async function launch() {
    if (!publicKey || !signAllTransactions || !mint || missing) return;
    setBusy(true);
    setErr(null);
    const labels = ["Metadata", ...(short_ > 0 && buyN > 0 ? ["Swap SOL → $100XBRO"] : []), buyN > 0 ? "Coin + first buy" : "Coin", ...(war ? ["War"] : [])];
    setPlan(labels);
    const st: StepState[] = labels.map(() => "idle");
    const set = (i: number, s: StepState) => {
      st[i] = s;
      setSteps([...st]);
    };
    let i = 0;
    try {
      // 1) metadata, once per form state: a retry after a failed send reuses it
      set(0, "active");
      let up = uploaded;
      if (!up || up.key !== metaKey) {
        const m = await post({ op: "meta", mint: mint.publicKey.toBase58(), name, symbol: sym, description: about, website, twitter, telegram, war, image });
        up = { key: metaKey, uri: m.uri };
        setUploaded(up);
      }
      set(0, "done");
      // 2) the server builds every transaction; the mint key signs its own before the wallet sees them
      const b: Built = await post({ op: "build", wallet: publicKey.toBase58(), mint: mint.publicKey.toBase58(), uri: up.uri, name, symbol: sym, buy: buyN, war });
      const txs = b.txs.map((t) => VersionedTransaction.deserialize(Uint8Array.from(atob(t), (c) => c.charCodeAt(0))));
      txs[b.mintTx].sign([mint]);
      for (let k = 1; k <= txs.length; k++) set(k, "active");
      await Promise.all(txs.map((tx) => assertTransactionDeployment(conn, tx)));
      const signed = await signAllTransactions(txs);
      for (let k = 0; k < signed.length; k++) {
        i = k + 1;
        for (let r = i + 1; r <= signed.length; r++) set(r, "idle");
        set(i, "active");
        await sendRaw(signed[k].serialize());
        set(i, "done");
      }
      const s = b.summary;
      // a war opened with a bid gets its thread on @lastbidwins, like every war
      if (s.game?.opened) await fetch("/api/war", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "announce", g: s.game.id }) }).catch(() => null);
      setDone(s);
      const line = s.play ? `last bid wins its war: ${s.play}` : s.pump;
      window.open(tweetUrl(`just launched $${s.symbol} on 100x.broker, quoted in $100XBRO.\n${line}`, s.play ?? s.pump), "_blank", "noopener");
    } catch (e) {
      setErr(humanError(e));
      setSteps((xs) => xs.map((x, k) => (x !== "active" ? x : k === i ? "failed" : "idle")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="mkt-head">
        <div>
          <div className="meta">
            <Link to="/">Board</Link> / launch
          </div>
          <h1 className="display">Launch a coin.</h1>
          <p className="lede num nm-lede">
            {mode === "orca" ? "Your coin on pump.fun, quoted in $100XBRO · your first buy spread across Orca pools, single-sided to 10,000×" : "Your coin on pump.fun · quoted in $100XBRO · 3% of every trade to you"}
          </p>
        </div>
        <div className="chips" role="radiogroup" aria-label="Launch on">
          <button type="button" className="chip" role="radio" aria-checked={mode === "orca"} onClick={() => setMode("orca")}>
            pump + Orca pools
          </button>
          <button type="button" className="chip" role="radio" aria-checked={mode === "pump"} onClick={() => setMode("pump")}>
            pump only
          </button>
        </div>
      </header>
      <div className="cfg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void launch();
          }}
        >
          <section className="step">
            <div className="step-n">1</div>
            <div className="field">
              <label htmlFor="ln-img">
                <span className="meta">Image · square works best</span>
              </label>
              <label className="ln-drop" data-has={!!image}>
                {image ? <img src={image} alt="" /> : <span className="muted">choose an image</span>}
                <input id="ln-img" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => pickImage(e.target.files?.[0])} className="sr-only" />
              </label>
              {imageErr && <span className="err">{imageErr}</span>}
              <div className="ln-pair">
                <div className="field">
                  <label htmlFor="ln-name">
                    <span className="meta">Name</span>
                    <span className="meta">{name.length}/32</span>
                  </label>
                  <div className="input text">
                    <input id="ln-name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="Last Bid Wins" autoComplete="off" />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="ln-sym">
                    <span className="meta">Ticker</span>
                  </label>
                  <div className="input text">
                    <span className="unit">$</span>
                    <input id="ln-sym" value={sym} maxLength={10} onChange={(e) => setSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, ""))} placeholder="LASTBID" autoComplete="off" spellCheck={false} />
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="step">
            <div className="step-n">2</div>
            <div className="field">
              <label htmlFor="ln-about">
                <span className="meta">Description</span>
                <span className="meta">{about.length}/600</span>
              </label>
              <div className="input text ln-area">
                <textarea id="ln-about" value={about} maxLength={600} rows={3} onChange={(e) => setAbout(e.target.value)} placeholder="what it is, in a line or two" />
              </div>
              <p className="note">We add one line saying it launched on 100x.broker, quoted in $100XBRO{mode === "pump" && war ? ", with its war link" : ""}.</p>
              <div className="ln-links">
                <div className="input text">
                  <span className="unit">web</span>
                  <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder={war ? play : "100x.broker"} autoComplete="off" spellCheck={false} />
                </div>
                <div className="input text">
                  <span className="unit">X</span>
                  <input value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="@handle or link" autoComplete="off" spellCheck={false} />
                </div>
                <div className="input text">
                  <span className="unit">TG</span>
                  <input value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="t.me/… (optional)" autoComplete="off" spellCheck={false} />
                </div>
              </div>
            </div>
          </section>

          {mode === "pump" ? (
            <>
          <section className="step">
            <div className="step-n">3</div>
            <div className="field">
              <label htmlFor="ln-buy">
                <span className="meta">First buy · $100XBRO</span>
                {held !== null && <span className="meta">you hold {compact(held)}</span>}
              </label>
              <div className="input">
                <input id="ln-buy" inputMode="decimal" value={buy} onChange={(e) => setBuy(e.target.value.replace(/[^0-9.]/g, ""))} />
                <span className="unit">{quoteUsd !== null && buyN > 0 ? `≈ ${money(buyN * quoteUsd)}` : "$100XBRO"}</span>
              </div>
              <div className="chips">
                {BUYS.map((n) => (
                  <button type="button" key={n} className="chip" role="radio" aria-checked={buyN === n} onClick={() => setBuy(String(n))}>
                    {n === 0 ? "none" : compact(n)}
                    {n > 0 && quoteUsd !== null && <span className="muted"> · {money(n * quoteUsd)}</span>}
                  </button>
                ))}
              </div>
              {short_ > 0 && <p className="note">You're {compact(short_)} $100XBRO short, so we swap SOL into it first. Same approval.</p>}
            </div>
          </section>

          <section className="step">
            <div className="step-n">4</div>
            <div className="field">
              <span className="meta">War · lastbidwins.fun</span>
              <label className="ln-toggle">
                <input type="checkbox" checked={war} onChange={(e) => setWar(e.target.checked)} />
                <span>
                  <b>Open a Last Bid Wins war on it.</b>{" "}
                  <span className="muted">
                    {buyN > 0
                      ? "You open it with a ~$1 bid out of your first buy and hold its first key, which earns off every bid after it."
                      : "It opens empty; the first bid on X starts it."}{" "}
                    Your coin's website points at its war.
                  </span>
                </span>
              </label>
            </div>
          </section>

          {err && <p className="err">{err}</p>}
          {done ? (
            <div className="card nm-done" data-live>
              <div className="card-head">
                <span className="card-ticker">
                  {image && <img className="tokimg" src={image} alt="" />}${done.symbol}
                </span>
                <span className="chip nm-live">live</span>
              </div>
              <div className="num muted">
                {done.mint}{" "}
                <button type="button" className="btn ghost small" onClick={() => navigator.clipboard?.writeText(done.mint)}>
                  copy CA
                </button>
              </div>
              {done.buy && <p className="note num">You bought {compact(done.buy.tokens)} ${done.symbol} for {compact(done.buy.quote)} $100XBRO ({money(done.buy.usd)}).</p>}
              <div className="ln-done-links">
                {done.play && (
                  <a className="btn big lfg" href={`https://${done.play.replace(/^https:\/\//, "")}`} target="_blank" rel="noopener">
                    Play its war →
                  </a>
                )}
                <a className="btn" href={done.pump} target="_blank" rel="noopener">
                  pump.fun
                </a>
                <a className="btn" href={tweetUrl(`just launched $${done.symbol} on 100x.broker, quoted in $100XBRO.\n${done.play ? `last bid wins its war: ${done.play}` : done.pump}`, done.play ?? done.pump)} target="_blank" rel="noopener">
                  post ↗
                </a>
              </div>
            </div>
          ) : (
            <button className="btn big lfg" type="submit" disabled={!publicKey || !mint || !!missing || busy} data-loading={busy}>
              {!publicKey ? "Connect to launch" : !mint ? "Getting your mint…" : missing ? missing : `Launch $${sym} · LFG`}
            </button>
          )}
          {plan.length > 0 && (
            <ol className="nm-progress" aria-label="Launch progress">
              {plan.map((s, k) => (
                <li key={s} className="chip nm-step" data-s={steps[k] ?? "idle"}>
                  <span className="dot" aria-hidden />
                  {s}
                </li>
              ))}
            </ol>
          )}
          <p className="note num nm-fine">≈0.025 SOL rent + fees · 1 approval · {1 + (short_ > 0 && buyN > 0 ? 1 : 0) + (war ? 1 : 0)} tx</p>
            </>
          ) : (
            <OrcaLaunch missing={missing} name={name} symbol={sym} mint={mint} uploadMeta={uploadOrcaMeta} />
          )}
        </form>

        <aside className="col">
          <section className="panel ln-preview">
            <h2 className="meta">Your coin</h2>
            <div className="ln-card">
              {image ? <img src={image} alt="" /> : <span className="skeleton img" />}
              <div>
                <div className="display">{name || "Name"}</div>
                <div className="num">${sym || "TICKER"}</div>
              </div>
            </div>
            <p className="ln-about">
              {about || <span className="muted">Your description.</span>}
              <span className="muted"> Launched on 100x.broker, quoted in $100XBRO.{mode === "pump" && war ? ` Play its war: ${play}` : ""}</span>
            </p>
            <div className="panel-row">
              <span className="muted">Mint</span>
              <span className="addr">{mintKey ? short(mintKey) : "—"}</span>
            </div>
            <div className="panel-row">
              <span className="muted">Quoted in</span>
              <span className="num">$100XBRO</span>
            </div>
            {mode === "orca" ? (
              <>
                <div className="panel-row">
                  <span className="muted">Creator fee</span>
                  <span className="num">3% of every pump trade, to you</span>
                </div>
                <div className="panel-row">
                  <span className="muted">Orca pools</span>
                  <span className="num">your first buy, single-sided from pump's price to 10,000×</span>
                </div>
                <div className="panel-row">
                  <span className="muted">LP fees</span>
                  <span className="num">to you (you own every position)</span>
                </div>
              </>
            ) : (
              <div className="panel-row">
                <span className="muted">Creator fee</span>
                <span className="num">3% of every trade, to you</span>
              </div>
            )}
            <div className="panel-row">
              <span className="muted">Website</span>
              <span className="addr">{website || (mode === "pump" && war ? "its war, on lastbidwins.fun" : "100x.broker")}</span>
            </div>
            {mode === "pump" && war && (
              <div className="panel-row">
                <span className="muted">War</span>
                <span className="num">{buyN > 0 ? "opens with your ~$1 bid" : "opens empty"} · 1h clock · last bid takes 70%</span>
              </div>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
