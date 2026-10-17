import { useEffect, useState } from "react";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getUnderlying, type Underlying } from "../lib/das";
import { storedRef, swapShareUrl, tweetUrl } from "../lib/ref";
import { loadPortfolio, type Book } from "../lib/portfolio";
import { sendFresh } from "../lib/chain";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ROUTER = "https://api.liquidityxyz.fun";

type Leg = {
  label: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  percent: number;
  protocol: string;
  position: string;
  long: { mint: string; side: string; amount: string };
  short: { mint: string; side: string; amount: string };
};
type MarketHit = { mint: string; market: string | null; ticker: string | null; url: string | null };
/** The router's 100× legs (100x.broker /api/legs): per hop, what is longed and shorted, where, and for how much SOL. */
type LegTarget = { mint: string; bet: "long" | "short"; market: string | null; side: 0 | 1 | null; ticker: string | null; lamports: string; via: "market" | "sol-inverse" | "listing" | "none"; note?: string; counterPot?: string };
type TxBets = { market: string; side: 0 | 1; lamports: string; ticker: string; bets: { hop: number; bet: "long" | "short"; mint: string }[] }[];
type Costs = { curveFeeBps: number; potFeeBps: number; stakeFeeBps: number; networkLamportsPerTx: number; rentPerNewAccountLamports: number };
/** One signed transaction's fate, for the status list under the button. Bets are not all-or-nothing with the swap: a bet that
 *  fails is marked and can be retried on its own. */
type TxRow = { label: string; kind: "swap" | "bets" | "listing"; status: "waiting" | "sending" | "ok" | "failed" | "skipped"; sig?: string; error?: string; orders?: string[] };
type LegsSummary = {
  houseBps: number; legBps: number; badBeat: boolean; totalLamports: string;
  hops: { hop: number; label: string; sold: string; bought: string; valueLamports: string; legBudget: string; long: LegTarget; short: LegTarget }[];
  listings: { mint: string; symbol: string | null; venue: string; quote: string; market: string; estRentSol: number; steps: string[] }[];
  pending: string[]; unplaceable: { mint: string; reason: string }[]; url?: string;
  txBets?: TxBets[]; costs?: Costs | null;
  error?: string;
};
type RouteHop = { inputMint: string; outputMint: string; inAmount: string; outAmount: string; label?: string };
/** The same hops the router sends to /api/legs (router.ts routeHops), for the second call after a listing lands. */
function routeHops(q: { inputMint?: string; outputMint?: string; inAmount?: string; outAmount?: string; routePlan?: { swapInfo?: Partial<RouteHop> }[] }): RouteHop[] {
  const plan = q.routePlan ?? [];
  const hops = plan.map((h) => h.swapInfo ?? {}).filter((s) => s.inputMint && s.outputMint && /^\d+$/.test(s.inAmount ?? "") && /^\d+$/.test(s.outAmount ?? "")) as RouteHop[];
  if (hops.length === plan.length && hops.length) return hops;
  return q.inputMint && q.outputMint && q.inAmount && q.outAmount ? [{ inputMint: q.inputMint, outputMint: q.outputMint, inAmount: q.inAmount, outAmount: q.outAmount }] : hops;
}
const sol = (lamports: string | bigint) => {
  const n = Number(lamports) / 1e9;
  return n === 0 ? "0" : n < 0.0001 ? n.toExponential(1) : n.toFixed(n < 0.01 ? 5 : 4);
};
type Quote = {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  badBeat: boolean;
  protocolBps: number;
  positionBps: number;
  hops: Leg[];
  markets: MarketHit[];
  quote: unknown;
  legs: LegsSummary | null;
  error?: string;
};

const b58 = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());
const short = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

type Hit = { mint: string; symbol: string; name: string; logo: string | null };

function CoinField({ mint, onMint }: { mint: string; onMint: (mint: string) => void }) {
  const [meta, setMeta] = useState<Underlying | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const q = (draft ?? "").trim();
  useEffect(() => {
    let live = true;
    setMeta(null);
    getUnderlying(mint).then((u) => live && setMeta(u));
    return () => {
      live = false;
    };
  }, [mint]);
  useEffect(() => {
    if (q.length < 2 || b58(q)) {
      setHits([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((j: { tokens?: Hit[] }) => live && setHits(Array.isArray(j.tokens) ? j.tokens.slice(0, 6) : []))
        .catch(() => live && setHits([]));
    }, 280);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  const pick = (next: string) => {
    onMint(next);
    setDraft(null);
    setHits([]);
  };
  return (
    <div className="swap-coin">
      {meta?.image && <img className="tokimg" src={meta.image} alt="" />}
      <input
        value={draft ?? meta?.symbol ?? ""}
        placeholder="name or ticker"
        spellCheck={false}
        autoComplete="off"
        aria-label="Token"
        onFocus={() => setDraft("")}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          if (b58(next.trim())) pick(next.trim());
        }}
        onBlur={() => {
          const t = q;
          if (b58(t)) onMint(t);
          setTimeout(() => setDraft(null), 180);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) {
            e.preventDefault();
            pick(hits[0].mint);
          }
        }}
      />
      {hits.length > 0 && draft !== null && (
        <div className="swap-hits" role="listbox">
          {hits.map((h) => (
            <button key={h.mint} type="button" role="option" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h.mint)}>
              {h.logo && <img className="tokimg" src={h.logo} alt="" />}
              <b>{h.symbol}</b>
              <span>{h.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function legs(plan: { swapInfo?: { label?: string; inputMint?: string; outputMint?: string; inAmount?: string; outAmount?: string }; percent?: number }[], badBeat: boolean): Leg[] {
  return plan.map((h) => {
    const info = h.swapInfo ?? {};
    const out = /^\d+$/.test(info.outAmount ?? "") ? info.outAmount! : "0";
    const position = ((BigInt(out) * 10n) / 10_000n).toString();
    const half = (BigInt(position) / 2n).toString();
    const sold = info.inputMint ?? "";
    const bought = info.outputMint ?? "";
    return {
      label: info.label ?? "hop",
      inputMint: sold,
      outputMint: bought,
      inAmount: info.inAmount ?? "0",
      outAmount: out,
      percent: h.percent ?? 100,
      protocol: (BigInt(out) / 10_000n).toString(),
      position,
      long: { mint: badBeat ? sold : bought, side: "UP", amount: half },
      short: { mint: badBeat ? bought : sold, side: "DOWN", amount: (BigInt(position) - BigInt(half)).toString() },
    };
  });
}

function toRaw(human: string, dec: number) {
  const t = human.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("amount");
  const [w, f = ""] = t.split(".");
  if (f.length > dec) throw new Error("too many decimals");
  const frac = (f + "0".repeat(dec)).slice(0, dec);
  return (BigInt(w || "0") * 10n ** BigInt(dec) + BigInt(frac || "0")).toString();
}
function fromRaw(raw: string, dec: number) {
  const n = BigInt(raw);
  const base = 10n ** BigInt(dec);
  const w = n / base;
  const f = (n % base).toString().padStart(dec, "0").replace(/0+$/, "");
  return f ? `${w}.${f}` : w.toString();
}

export default function SwapPage() {
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  const connection = useConnection().connection;
  const [payMint, setPayMint] = useState(SOL);
  const [recvMint, setRecvMint] = useState(USDC);
  const [amount, setAmount] = useState("0.1");
  const [slippage, setSlippage] = useState(50);
  const [badBeat, setBadBeat] = useState(false);
  const [payDec, setPayDec] = useState(9);
  const [recvDec, setRecvDec] = useState(6);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bal, setBal] = useState<bigint | null>(null);
  const [solBal, setSolBal] = useState<bigint | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const pay = q.get("pay");
    const recv = q.get("recv");
    if (pay && b58(pay)) setPayMint(pay);
    if (recv && b58(recv)) setRecvMint(recv);
    if (q.get("badBeat") === "1") setBadBeat(true);
  }, []);

  useEffect(() => {
    let live = true;
    const dec = (mint: string, fallback: number) =>
      getUnderlying(mint).then((u) => (live ? (u?.decimals ?? fallback) : fallback)).catch(() => fallback);
    dec(payMint, payMint === SOL ? 9 : 0).then((d) => live && setPayDec(d));
    dec(recvMint, recvMint === USDC ? 6 : 0).then((d) => live && setRecvDec(d));
    return () => {
      live = false;
    };
  }, [payMint, recvMint]);

  useEffect(() => {
    if (!b58(payMint) || !b58(recvMint) || payMint === recvMint || payDec === 0) return;
    let raw: string;
    try {
      raw = toRaw(amount, payDec);
    } catch {
      return;
    }
    if (raw === "0") return;
    let live = true;
    const t = setTimeout(() => {
      const q = new URLSearchParams({ inputMint: payMint, outputMint: recvMint, amount: raw, slippageBps: String(slippage), swapMode: "ExactIn" });
      if (badBeat) q.set("badBeat", "1");
      const refKey = storedRef()?.toBase58();
      if (refKey) q.set("ref", refKey);
      fetch(`${ROUTER}/api/quote/solana?${q}`, { signal: AbortSignal.timeout(70_000) })
        .then(async (r) => {
          const j = (await r.json()) as { error?: string; inAmount?: string; outAmount?: string; otherAmountThreshold?: string; slippageBps?: number; routePlan?: Parameters<typeof legs>[0]; legs?: LegsSummary };
          if (!r.ok || !j.outAmount) throw new Error(j.error ?? "no route");
          const quote: Quote = {
            inAmount: j.inAmount ?? raw,
            outAmount: j.outAmount,
            otherAmountThreshold: j.otherAmountThreshold ?? j.outAmount,
            slippageBps: j.slippageBps ?? slippage,
            badBeat,
            protocolBps: 1,
            positionBps: 10,
            hops: legs(j.routePlan ?? [], badBeat),
            markets: [],
            quote: j,
            legs: j.legs ?? null,
          };
          return quote;
        })
        .then((j) => {
          if (live) {
            setQuote(j);
            setErr(null);
          }
        })
        .catch((e) => {
          if (live) {
            setQuote(null);
            setErr(e instanceof Error ? e.message : "no route");
          }
        });
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [payMint, recvMint, amount, slippage, badBeat, payDec]);

  useEffect(() => {
    const mints = [...new Set([...(quote?.hops.flatMap((h) => [h.long.mint, h.short.mint]) ?? []), ...(quote?.legs?.hops?.flatMap((h) => [h.sold, h.bought]) ?? [])])];
    if (!mints.length) return;
    let live = true;
    Promise.all(mints.map(async (m) => [m, (await getUnderlying(m))?.symbol ?? short(m)] as const)).then((rows) => {
      if (live) setNames(new Map(rows));
    });
    return () => {
      live = false;
    };
  }, [quote]);

  useEffect(() => {
    if (!publicKey) {
      setBal(null);
      return;
    }
    let live = true;
    const run = async () => {
      try {
        const lamports = BigInt(await connection.getBalance(publicKey, "confirmed"));
        if (live) setSolBal(lamports);
        if (payMint === SOL) {
          if (live) setBal(lamports);
          return;
        }
        const mint = new PublicKey(payMint);
        for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
          const ata = getAssociatedTokenAddressSync(mint, publicKey, false, program);
          const info = await connection.getTokenAccountBalance(ata, "confirmed").catch(() => null);
          if (info) {
            if (live) setBal(BigInt(info.value.amount));
            return;
          }
        }
        if (live) setBal(0n);
      } catch {
        if (live) {
          setBal(null);
          setSolBal(null);
        }
      }
    };
    run();
    return () => {
      live = false;
    };
  }, [publicKey, payMint, connection]);

  const flip = () => {
    setPayMint(recvMint);
    setRecvMint(payMint);
    if (quote) setAmount(fromRaw(quote.outAmount, recvDec));
  };
  const take = (pct: number) => {
    if (bal === null) return;
    const reserve = payMint === SOL ? 20_000_000n : 0n;
    const spend = bal > reserve ? bal - reserve : 0n;
    setAmount(fromRaw(((spend * BigInt(pct)) / 100n).toString(), payDec));
  };

  const [step, setStep] = useState<string | null>(null);
  const [rows, setRows] = useState<TxRow[]>([]);
  // What this swap needs in SOL before anything is signed: the SOL swapped (if paying SOL), the 100× legs, the one-time rent of
  // accounts it may open (wrapped SOL for the swap, r-fstacc for the stake deposit, one per UP/DOWN token; refundable when
  // closed), any listing rent, and network fees. Upper bound: accounts the wallet already has are counted as new.
  const RENT = 2_100_000n;
  const need = (() => {
    if (!quote?.legs || quote.legs.error) return null;
    const swapSol = payMint === SOL ? BigInt(quote.inAmount) : 0n;
    const legTokens = new Set(quote.legs.hops.flatMap((h) => [h.long, h.short]).filter((t) => t.market && t.side !== null).map((t) => `${t.market}:${t.side}`)).size;
    const listing = BigInt(Math.round(quote.legs.listings.reduce((a, l) => a + l.estRentSol, 0) * 1e9)) + BigInt(quote.legs.pending.length && !quote.legs.listings.length ? quote.legs.pending.length * 40_000_000 : 0);
    const txs = 1 + quote.legs.hops.length * 2 + quote.legs.pending.length * 4;
    return swapSol + BigInt(quote.legs.totalLamports) + RENT * BigInt(2 + legTokens) + listing + BigInt(txs) * 20_000n;
  })();
  const lacking = need !== null && solBal !== null && solBal < need;
  const legsBody = (extra: Record<string, unknown>) => JSON.stringify({ wallet: publicKey?.toBase58(), hops: routeHops(quote?.quote as Parameters<typeof routeHops>[0]), badBeat, ref: storedRef()?.toBase58() ?? null, build: true, ...extra });
  const betRows = (labels: string[], txBets: TxBets[]): TxRow[] =>
    txBets.map((tb, i) => ({ label: labels[i] ?? "100× bets", kind: "bets", status: "waiting", orders: tb.map((o) => `${o.market}:${o.side}`) }));

  const swap = async () => {
    if (!publicKey || !signTransaction || !quote) return;
    setBusy(true);
    setRows([]);
    setErr(null);
    const build = async (version: "0" | "1") => {
      const r = await fetch(`${ROUTER}/api/swap/solana`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userPublicKey: publicKey.toBase58(), wrapAndUnwrapSol: true, transactionVersion: version,
          badBeat, ref: storedRef()?.toBase58(), quoteResponse: quote.quote,
        }),
        signal: AbortSignal.timeout(45_000),
      });
      const j = await r.json();
      const list = Array.isArray(j.swapTransactions) ? j.swapTransactions : j.swapTransaction ? [j.swapTransaction] : [];
      if (!r.ok || !list.length || list.some((x: unknown) => typeof x !== "string")) throw new Error(j.error ?? "could not build the swap");
      built = j;
      return list as string[];
    };
    let built: { legs?: LegsSummary; transactionLabels?: string[] } = {};
    try {
      let raws: string[];
      try {
        raws = await build("0");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (!/1232|V0 transaction limit|use a V1/i.test(msg)) throw e;
        raws = await build("1");
      }
      // the router's list is [swap..., bet txs..., listing steps...]; name each one
      const labels = built.transactionLabels ?? [];
      const nBets = built.legs?.txBets?.length ?? 0;
      const nList = (built.legs?.listings ?? []).reduce((a, l) => a + l.steps.length, 0);
      const nSwap = Math.max(1, raws.length - nBets - nList);
      const plan: TxRow[] = [
        ...raws.slice(0, nSwap).map((_, i): TxRow => ({ label: labels[i] ?? "Swap", kind: "swap", status: "waiting" })),
        ...betRows(labels.slice(nSwap, nSwap + nBets), built.legs?.txBets ?? []),
        ...raws.slice(nSwap + nBets).map((_, i): TxRow => ({ label: labels[nSwap + nBets + i] ?? "Listing", kind: "listing", status: "waiting" })),
      ];
      await signAndSend(raws, plan);
      // coins listed by this swap: their legs can only be built once the listing has landed
      const pending = built.legs?.pending ?? [];
      if (pending.length) {
        setStep("Listing landed. Building the 100× bets on the new markets…");
        const r = await fetch("/api/legs", { method: "POST", headers: { "content-type": "application/json" }, body: legsBody({ only: pending, markets: (built.legs?.listings ?? []).map((l) => l.market) }) });
        const j = await r.json();
        if (!r.ok || !Array.isArray(j.txs)) throw new Error(j.error ?? "could not build the bets on the new markets");
        if (j.txs.length) await signAndSend(j.txs as string[], betRows(j.txLabels ?? [], j.txBets ?? []));
      }
      setStep(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "swap failed");
      setStep(null);
    } finally {
      setBusy(false);
    }
  };

  /** Rebuild and resend only the bets that did not land (the swap itself already went through). */
  const retryBets = async () => {
    const orders = [...new Set(rows.filter((r) => r.kind === "bets" && r.status === "failed").flatMap((r) => r.orders ?? []))];
    if (!orders.length || !publicKey) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/legs", { method: "POST", headers: { "content-type": "application/json" }, body: legsBody({ orders }) });
      const j = await r.json();
      if (!r.ok || !Array.isArray(j.txs) || !j.txs.length) throw new Error(j.error ?? "nothing to retry");
      setRows((prev) => prev.map((x) => (x.kind === "bets" && x.status === "failed" ? { ...x, status: "skipped", error: "retried below" } : x)));
      await signAndSend(j.txs as string[], betRows(j.txLabels ?? [], j.txBets ?? []).map((x) => ({ ...x, label: `retry: ${x.label}` })));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "retry failed");
    } finally {
      setStep(null);
      setBusy(false);
    }
  };

  /** Sign everything in one wallet prompt where the wallet allows it, then send in order, each after the previous confirms.
   *  A swap or listing step that fails stops the rest; a bet that fails is marked and the rest still go. */
  const signAndSend = async (raws: string[], plan: TxRow[]) => {
    if (!signTransaction) throw new Error("wallet can't sign");
    const base = await new Promise<number>((res) => setRows((prev) => (res(prev.length), [...prev, ...plan])));
    const patch = (i: number, p: Partial<TxRow>) => setRows((prev) => prev.map((x, k) => (k === base + i ? { ...x, ...p } : x)));
    const packed = raws.map((b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const tx = VersionedTransaction.deserialize(bytes);
      if (bytes[0] === 0x81) {
        const n = tx.message.header.numRequiredSignatures;
        const message = bytes.subarray(0, bytes.length - n * 64);
        tx.message.serialize = () => message;
      }
      return { bytes, tx };
    });
    const v0s = packed.every((p) => p.bytes[0] !== 0x81);
    const signed = v0s && signAllTransactions
      ? await signAllTransactions(packed.map((p) => p.tx))
      : await Promise.all(packed.map((p) => signTransaction(p.tx)));
    for (let i = 0; i < signed.length; i++) {
      const bytes = packed[i].bytes;
      const tx = signed[i];
      const wire = bytes[0] === 0x81
        ? (() => {
            const n = tx.message.header.numRequiredSignatures;
            const message = bytes.subarray(0, bytes.length - n * 64);
            const out = new Uint8Array(message.length + n * 64);
            out.set(message, 0);
            tx.signatures.forEach((sig, k) => out.set(sig, message.length + k * 64));
            return out;
          })()
        : tx.serialize();
      const row = plan[i];
      setStep(`${i + 1}/${signed.length} ${row?.label ?? ""}`.trim());
      patch(i, { status: "sending" });
      try {
        // preflight on: a transaction that cannot land is refused before it costs a fee (each one is sent after the last confirmed)
        const sig = await sendFresh(() => connection.sendRawTransaction(wire, { skipPreflight: false, preflightCommitment: "confirmed" }));
        patch(i, { sig });
        const start = Date.now();
        let ok = false;
        while (Date.now() - start < 30_000) {
          const v = (await connection.getSignatureStatuses([sig])).value[0];
          if (v?.err) throw new Error(`failed on chain: ${JSON.stringify(v.err)}`);
          if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") { ok = true; break; }
          await new Promise((r) => setTimeout(r, 700));
        }
        if (!ok) throw new Error("not confirmed in 30 s");
        patch(i, { status: "ok" });
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 160);
        patch(i, { status: "failed", error: msg });
        if (row?.kind === "bets") continue; // the swap landed; this bet can be retried on its own
        for (let k = i + 1; k < signed.length; k++) patch(k, { status: "skipped" });
        throw new Error(`${row?.label ?? "step"} failed: ${msg}`);
      }
    }
  };

  const out = quote ? fromRaw(quote.outAmount, recvDec || 0) : "";
  const min = quote ? fromRaw(quote.otherAmountThreshold, recvDec || 0) : "";

  return (
    <div className="swap">
      <div className="swap-card">
        <label className="swap-row">
          <span>You pay</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="You pay" />
          <CoinField mint={payMint} onMint={setPayMint} />
        </label>
        <div className="swap-chips">
          <button type="button" onClick={() => setPayMint(SOL)}>SOL</button>
          <button type="button" onClick={() => setPayMint(USDC)}>USDC</button>
          {[10, 25, 50, 100].map((pct) => (
            <button key={pct} type="button" disabled={bal === null} onClick={() => take(pct)}>{pct}%</button>
          ))}
          <button type="button" className="swap-flip" onClick={flip} aria-label="Flip">
            ↕
          </button>
        </div>
        <label className="swap-row">
          <span>You receive</span>
          <output>{out || "—"}</output>
          <CoinField mint={recvMint} onMint={setRecvMint} />
        </label>
        <div className="swap-meta">
          <label>
            Slippage
            <select value={slippage} onChange={(e) => setSlippage(Number(e.target.value))}>
              <option value={50}>0.5%</option>
              <option value={100}>1%</option>
              <option value={300}>3%</option>
            </select>
          </label>
          <label className="swap-beat">
            <input type="checkbox" checked={badBeat} onChange={(e) => setBadBeat(e.target.checked)} />
            Bad beat
          </label>
          {min && <span>Min received {min}</span>}
        </div>
        <p className="swap-fee">
          1 bp of each hop goes to the house. 10 bp of each hop is split in half:{" "}
          {badBeat
            ? "an irresponsible 100× long on what that hop sold, and an irresponsible 100× short on what it bought."
            : "an irresponsible 100× long on what that hop bought, and an irresponsible 100× short on what it sold."}
        </p>
        {err && <p className="swap-err">{err}</p>}
        {quote?.legs?.error && <p className="swap-err">100× legs unavailable, so the swap is held: {quote.legs.error}</p>}
        {quote?.legs && !quote.legs.error && (
          <div className="swap-legs">
            <ol className="swap-hops">
              {quote.legs.hops.map((h) => (
                <li key={h.hop}>
                  <b>
                    {h.label} · {names.get(h.sold) ?? short(h.sold)} → {names.get(h.bought) ?? short(h.bought)}
                  </b>
                  {[h.long, h.short].map((t) => (
                    <span key={t.bet} className={t.bet === "long" ? "up" : "down"}>
                      100× {t.bet} {t.mint === SOL ? "SOL" : names.get(t.mint) ?? t.ticker ?? short(t.mint)}
                      {t.via === "market" && t.market && (
                        <>
                          {" "}· <a href={`https://100x.broker/m/${t.market}${t.side ? "?side=1" : ""}`}>{t.side ? "DOWN" : "UP"} ${t.ticker}</a>
                        </>
                      )}
                      {t.via === "sol-inverse" && t.market && (
                        <>
                          {" "}· <a href={`https://100x.broker/m/${t.market}${t.side ? "?side=1" : ""}`}>{t.side ? "DOWN" : "UP"} ${t.ticker}/SOL</a> (SOL has no market of its own; this is SOL upside down)
                        </>
                      )}
                      {t.via === "listing" && <> · lists it on 100x.broker first, bet placed once it is live</>}
                      {t.via === "none" && <> · {t.note ?? "no market can carry this bet"}</>}
                      {" "}· {sol(t.lamports)} SOL
                      {t.counterPot !== undefined && Number(t.counterPot) < 1_000_000 && (
                        <em className="swap-thin"> · the other side holds {sol(t.counterPot)} SOL, so this bet has almost nothing to win yet</em>
                      )}
                    </span>
                  ))}
                </li>
              ))}
            </ol>
            <p className="swap-legs-total">
              100× bets: <b>{sol(quote.legs.totalLamports)} SOL</b> from your wallet, in one transaction after the swap (identical bets merged)
              {quote.legs.listings.length > 0 && (
                <>
                  {" "}· lists {quote.legs.listings.map((l) => `$${l.symbol ?? short(l.mint)}`).join(", ")} on 100x.broker (~{quote.legs.listings.reduce((a, l) => a + l.estRentSol, 0).toFixed(2)} SOL rent, yours, first swapper lists)
                </>
              )}
              {quote.legs.pending.length > 0 && quote.legs.listings.length === 0 && (
                <> · lists {quote.legs.pending.map((m) => names.get(m) ?? short(m)).join(", ")} on 100x.broker first (~{(0.04 * quote.legs.pending.length).toFixed(2)} SOL rent, yours)</>
              )}
            </p>
            <details className="swap-costs" open>
              <summary>What it costs, what can happen</summary>
              <ul>
                <li>
                  Per hop: <b>0.01%</b> to the house + <b>0.1%</b> into these bets = 0.11% of the swap, on top of the venue's own fee.
                </li>
                <li>
                  The bets buy UP/DOWN on a curve that keeps <b>{((quote.legs.costs?.curveFeeBps ?? 400) / 100).toFixed(0)}%</b> of what goes in (and {((quote.legs.costs?.potFeeBps ?? 400) / 100).toFixed(0)}% again when you sell back or cash out), after a {((quote.legs.costs?.stakeFeeBps ?? 10) / 100).toFixed(1)}% stake-pool deposit fee.
                </li>
                <li>
                  Network: about {sol(String(((quote.legs.costs?.networkLamportsPerTx ?? 5000) * (1 + Math.ceil(new Set(quote.legs.hops.flatMap((h) => [h.long, h.short]).filter((t) => t.market && t.side !== null).map((t) => `${t.market}:${t.side}`)).size / 4)))))} SOL. On tiny swaps that is a big share of the bets themselves.
                </li>
                <li>
                  The first bet on a token opens an account for it: ~{sol(String(quote.legs.costs?.rentPerNewAccountLamports ?? 2_074_080))} SOL of rent, yours, returned when the account is closed.
                </li>
                <li>
                  No liquidations, but 100× is real: about every hour, a 1% move against a bet hands ~63% of its side's pot to the other side, and a 5% move ~99%. Winnings come out of the other side's pot, so a bet is only as big as what sits across from it.
                </li>
                <li>Sells from the swap Bag don't take the 0/20 cut; exits from the main 100x.broker Bag do.</li>
                <li>The swap and the bets are separate transactions. If the swap lands and a bet doesn't, the bet is marked here and you can retry it.</li>
              </ul>
            </details>
            {quote.legs.unplaceable.length > 0 && (
              <p className="swap-err">Can't place: {quote.legs.unplaceable.map((u) => `${names.get(u.mint) ?? short(u.mint)} (${u.reason})`).join("; ")}</p>
            )}
          </div>
        )}
        <div className="swap-share">
          <a className="btn ghost small" href={tweetUrl("Swapping on 100x.broker. The house takes 1 bp. 10 bp goes into a stupid 100×.", swapShareUrl(publicKey, payMint, recvMint))} target="_blank" rel="noreferrer">Share</a>
        </div>
        {lacking && need !== null && solBal !== null && (
          <p className="swap-err">
            This swap needs about {sol(need)} SOL in your wallet (the swap, the 100× legs, and one-time account rent that comes back when those accounts close). You have {sol(solBal)} SOL.
          </p>
        )}
        <button className="btn swap-go" disabled={!quote || busy || !!quote.legs?.error || lacking} onClick={() => (publicKey ? swap() : setErr("Connect a wallet, or try with a burner."))}>
          {busy ? "Signing…" : "Swap"}
        </button>
        {step && <p className="swap-step">{step}</p>}
        {rows.length > 0 && (
          <ol className="swap-status" aria-label="Transactions">
            {rows.map((r, i) => (
              <li key={i} data-s={r.status}>
                <i aria-hidden="true">{r.status === "ok" ? "✓" : r.status === "failed" ? "✕" : r.status === "skipped" ? "–" : r.status === "sending" ? "…" : "·"}</i>
                <span>
                  {r.label}
                  {r.error && <small>{r.error}</small>}
                </span>
                {r.sig && (
                  <a href={`https://solscan.io/tx/${r.sig}`} target="_blank" rel="noreferrer">
                    {short(r.sig)}
                  </a>
                )}
              </li>
            ))}
          </ol>
        )}
        {!busy && rows.some((r) => r.kind === "bets" && r.status === "failed") && (
          <p className="swap-retry">
            The swap went through; {rows.filter((r) => r.kind === "bets" && r.status === "failed").length === 1 ? "one bet" : "some bets"} didn't. Nothing was charged for those.{" "}
            <button className="btn small" onClick={retryBets}>
              Retry the bets
            </button>
          </p>
        )}
      </div>
      {publicKey && <SwapBag owner={publicKey} />}
    </div>
  );
}

function SwapBag({ owner }: { owner: PublicKey }) {
  const [book, setBook] = useState<Book | null>(null);
  useEffect(() => {
    let live = true;
    loadPortfolio(owner).then((b) => live && setBook(b)).catch(() => live && setBook(null));
    return () => {
      live = false;
    };
  }, [owner]);
  if (!book?.positions.length) return null;
  return (
    <ul className="swap-bag">
      {book.positions.slice(0, 8).map((p) => (
        <li key={p.key}>
          <a href={`https://100x.broker/m/${p.v.acct.key.toBase58()}${p.side ? "?side=1" : ""}`}>
            {p.side === 0 ? "UP" : "DOWN"} ${p.v.ticker}
          </a>
        </li>
      ))}
    </ul>
  );
}
