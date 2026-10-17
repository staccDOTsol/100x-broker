// /wrap: turn a 100x coin into its plain SPL twin (and back), 1:1, through the immutable SPL Token Wrap at 3cwC….
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { useSend } from "../hooks";
import { toV0 } from "../lib/chain";
import { WalletButton } from "../components/bits";
import {
  COIN_UNIT, WRAP_PROGRAM, createTwinIxs, listWrapCoins, parseCoinAmount, unwrapIxs, wrapBalances, wrapIxs, type WrapCoin,
} from "../lib/wrap";

const fmt = (raw: bigint) => (Number(raw) / COIN_UNIT).toLocaleString(undefined, { maximumFractionDigits: 6 });
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;
type Bal = Awaited<ReturnType<typeof wrapBalances>>;

export default function WrapPage() {
  const { mint } = useParams();
  const { publicKey } = useWallet();
  const send = useSend();
  const [coins, setCoins] = useState<WrapCoin[] | null>(null);
  const [selected, setSelected] = useState<string | null>(mint ?? null);
  const [bal, setBal] = useState<Bal | null>(null);
  const [mode, setMode] = useState<"wrap" | "unwrap">("wrap");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listWrapCoins().then(setCoins).catch((e) => setError(String(e?.message ?? e)));
  }, []);

  const coin = useMemo(
    () => coins?.find((c) => c.w.coin.toBase58() === selected || c.w.wrapped.toBase58() === selected) ?? coins?.[0] ?? null,
    [coins, selected],
  );

  const refresh = useCallback(async () => {
    if (!coin || !publicKey) return setBal(null);
    setBal(await wrapBalances(publicKey, coin.w));
  }, [coin, publicKey]);
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const go = async () => {
    if (!coin) return;
    let raw: bigint;
    try {
      raw = parseCoinAmount(amount);
    } catch (e: any) {
      return setError(e.message);
    }
    setError(null);
    setBusy(true);
    const label = `${mode === "wrap" ? "Wrap" : "Unwrap"} ${amount} ${coin.symbol}`;
    const sig = await send(label, async (payer) =>
      toV0(
        mode === "wrap"
          ? [...(coin.live ? [] : await createTwinIxs(payer, coin.w)), ...(await wrapIxs(payer, coin.w, raw))]
          : await unwrapIxs(payer, coin.w, raw),
        payer,
      ),
    );
    setBusy(false);
    if (sig) {
      setAmount("");
      if (!coin.live) setCoins(await listWrapCoins());
      await refresh();
    }
  };

  const max = () => bal && setAmount((Number(mode === "wrap" ? bal.coin : bal.twin) / COIN_UNIT).toString());
  const backed = bal ? bal.escrow >= bal.supply : true;

  return (
    <div className="wrapx">
      <div className="panel wrapx-intro">
        <h2>Wrap</h2>
        <p>
          100x coins carry a transfer hook, so Jupiter and most venues won't touch them. Wrapping gives you the coin's
          plain SPL twin, 1:1, that any router can trade (Orca pools vs $100XBRO and r-freestacc). Unwrap any time to get
          the exact coin back.
        </p>
        <p className="wrapx-fine">
          Program <a href={`https://solscan.io/account/${WRAP_PROGRAM}`} target="_blank" rel="noreferrer">{short(WRAP_PROGRAM.toBase58())}</a>:
          SPL Token Wrap, immutable (no upgrade authority), audited upstream code. Your coins sit in its escrow; nobody can move them but an unwrap.
        </p>
      </div>

      <div className="wrapx-grid">
        <div className="panel wrapx-list">
          {!coins && !error && <p className="wrapx-fine">Loading coins…</p>}
          {coins?.map((c) => (
            <button
              key={c.w.coin.toBase58()}
              className={`wrapx-row ${coin === c ? "on" : ""}`}
              onClick={() => { setSelected(c.w.coin.toBase58()); setAmount(""); setError(null); }}
            >
              <span className={`chip ${c.side === 1 ? "down" : "up"}`}>{c.symbol}</span>
              <span className="wrapx-fine">{c.live ? `twin ${short(c.w.wrapped.toBase58())}` : "no twin yet"}</span>
            </button>
          ))}
        </div>

        {coin && (
          <div className="panel wrapx-card">
            <h2>
              {coin.symbol} <span className="wrapx-fine">{coin.name}</span>
            </h2>
            <dl className="wrapx-facts">
              <dt>Coin (hooked)</dt>
              <dd><a href={`https://solscan.io/token/${coin.w.coin}`} target="_blank" rel="noreferrer">{short(coin.w.coin.toBase58())}</a></dd>
              <dt>SPL twin</dt>
              <dd>
                <a href={`https://solscan.io/token/${coin.w.wrapped}`} target="_blank" rel="noreferrer">{short(coin.w.wrapped.toBase58())}</a>
                {coin.live ? "" : " · created on your first wrap (~0.004 SOL rent)"}
              </dd>
              {bal && (
                <>
                  <dt>Backing</dt>
                  <dd className={backed ? "" : "bad"}>{backed ? "1:1" : "under-backed"} · escrow {fmt(bal.escrow)} / twins {fmt(bal.supply)}</dd>
                </>
              )}
            </dl>

            {!publicKey ? (
              <WalletButton solo />
            ) : (
              <>
                <div className="wrapx-tabs">
                  <button className={`btn small ${mode === "wrap" ? "" : "ghost"}`} onClick={() => setMode("wrap")}>Wrap</button>
                  <button className={`btn small ${mode === "unwrap" ? "" : "ghost"}`} onClick={() => setMode("unwrap")} disabled={!coin.live}>Unwrap</button>
                </div>
                <div className="input">
                  <input inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} />
                  <button className="btn small ghost" onClick={max}>max</button>
                  <span className="unit">{mode === "wrap" ? coin.symbol : `w${coin.symbol}`}</span>
                </div>
                <p className="wrapx-fine">
                  You hold {bal ? fmt(bal.coin) : "…"} {coin.symbol} and {bal ? fmt(bal.twin) : "…"} twin.
                </p>
                {error && <p className="wrapx-err">{error}</p>}
                <button className="btn big" disabled={busy} onClick={go}>
                  {busy ? "Working…" : mode === "wrap" ? `Wrap to SPL` : `Unwrap to ${coin.symbol}`}
                </button>
                {coin.live && (
                  <p className="wrapx-fine">
                    Trade the twin: <a href={`https://jup.ag/swap/SOL-${coin.w.wrapped}`} target="_blank" rel="noreferrer">Jupiter</a>
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
