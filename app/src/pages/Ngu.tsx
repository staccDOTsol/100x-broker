// /ngu — $NGU (Number Go Up), the stacSOL successor. Buy/sell at the pool rate up top; mechanism copy below is tied to
// what the ngu-crank program enforces (see its docs/MARKETING.md). Fees and numbers are read live from chain.
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { usePoll, useSend } from "../hooks";
import { WalletButton } from "../components/bits";
import { NGU } from "../ngu";
import { buildBuy, buildSell, nguAta, rate, readNgu, type NguInfo } from "../lib/ngu";
import { amount as fmt, parseAmount } from "../lib/format";
import { nguDatafeed } from "../lib/nguChart";
import "../ngu.css";

const ANNOUNCEMENT = `'fix the trenches, stacc,' they said
'it'll be easy, stacc, just give them a better casino with less fees, stacc,' they said
stacc thought to self 'yea, but that preserves all the bits wrong with the trenches lol: the unseen unsightly organ grinder that runs beneath the surface n taxes us whatever we dumb enough to donate to it, enuff times those %s add up and we left w less than we started with,' stacc thought to self
and then: 'idk, we have enough bits n bobs lying around we can tie number-go-up tech directly to prospecting, and then all actors invariably happy?? including the organ grinder itself?? 🤔'
so net net we fix nothing: we just attract an underrepresented class of users, those risk-averse folks that don't like memes cuz it is lighting monye on fire
this tweet is a complete and utter abandon: a surrender.
it's also an announcement of the unholy marriage of 100x.broker n the remains of stacsol/infity, as well as everything we learned in the post-mortum:`;

const pct = (bps: number | null | undefined) => (bps == null ? "—" : `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`);
const shortKey = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
const solscan = (k: string) => `https://solscan.io/account/${k}`;
const sol = (lamports: bigint, dp = 4) => fmt(lamports, 9, dp);

export default function NguPage() {
  useEffect(() => {
    document.title = "$NGU — Number Go Up · staked SOL whose SOL rate only goes up · 100x.broker";
  }, []);
  const { connection } = useConnection();
  const info = usePoll<NguInfo | null>(() => readNgu(connection), [connection], 10_000);
  const i = info.data ?? null;
  const tax = pct(NGU.taxBps);

  return (
    <div className="ngu">
      <section className="ngu-head">
        <div className="ngu-id">
          <div className="ngu-brand">
            <img src="/ngu/logo.png" alt="" width={64} height={64} />
            <div>
              <h1 className="display ngu-name">Number Go Up</h1>
              <span className="meta">$NGU · staked SOL · the SOL rate only goes up</span>
            </div>
          </div>
          <div className="ngu-rate">
            <span className="meta">SOL per $NGU · live</span>
            <span className="num ngu-rate-v">{i ? rate(i).toFixed(9) : "…"}</span>
          </div>
          <div className="ngu-stats">
            <Stat k="SOL backing" v={i ? sol(i.backingLamports) : "…"} />
            <Stat k="supply" v={i ? sol(i.supply) : "…"} />
            <Stat k="burned forever" v={i ? sol(i.burned, 6) : "…"} />
            <Stat k="into $100XBRO" v={i ? sol(i.swapped, 6) : "…"} />
            <Stat k="into liquidity" v={i ? sol(i.lp, 6) : "…"} />
            <Stat k="cranks" v={i ? String(i.cranks) : "…"} />
          </div>
          <p className="ngu-lead">
            Every $NGU transfer pays a {tax} tax. A permissionless crank burns 90% of it; of the rest, a third buys $100XBRO on Orca and
            two thirds pair with it as liquidity the program owns forever. Burns shrink supply while the SOL stays in the pool, so SOL per
            $NGU can only rise. Volume is the yield.
          </p>
        </div>
        <Trade info={i} refresh={info.refresh} />
      </section>

      <NguChart />

      <section>
        <h2 className="meta">every tax, split</h2>
        <div className="ngu-split" role="img" aria-label="90% burned, 3.3% to $100XBRO, 6.7% to liquidity">
          <span className="burn" style={{ flex: 27 }}>
            90% burned
          </span>
          <span className="fr28" style={{ flex: 1 }}>
            → $100XBRO
          </span>
          <span className="lp" style={{ flex: 2 }}>
            → liquidity
          </span>
        </div>
        <ul className="howto ngu-howto">
          <li>
            <b className="display">Buy</b>
            <p>Buy here at the pool rate: no slippage however thin the market is, and the buy fee goes straight into the burn loop.</p>
          </li>
          <li>
            <b className="display">Hold</b>
            <p>Every transfer and trade anyone makes pays {tax}. The crank burns 90% of it, so SOL per $NGU rises for everyone holding; the other 10% buys $100XBRO and locks it as liquidity.</p>
          </li>
          <li>
            <b className="display">Sell</b>
            <p>Sell back here at the pool rate whenever you want, paid in SOL from the pool's reserve.</p>
          </li>
        </ul>
      </section>

      <section>
        <h2 className="meta">what stacsol/infity did</h2>
        <div className="ngu-stats ngu-history">
          <div className="ngu-stat">
            <span className="meta">SOL per stacSOL, May 8 → now</span>
            <span className="num">1.000 → 3.198</span>
          </div>
          <div className="ngu-stat">
            <span className="meta">day-one round trip, after 6.9% in + 6.9% out</span>
            <span className="num">~2.77× the SOL</span>
          </div>
          <div className="ngu-stat">
            <span className="meta">times the rate went down</span>
            <span className="num">0</span>
          </div>
        </div>
        <p className="muted ngu-foot">
          Read on-chain from pool <a href={solscan("E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb")}>E6oq…Qixqb</a>. Past results, not a promise.
        </p>
      </section>

      <section>
        <h2 className="meta">what the post-mortem taught us</h2>
        <ol className="ngu-lessons">
          <li>
            <b>The tax goes to a program, not a wallet.</b> stacSOL's withheld fees answered to one wallet; when it was compromised the burn
            loop died with it. Here, only the crank program's address can collect them, and it can only split them the way the label says: at least half must burn, forever.
          </li>
          <li>
            <b>Anyone can run the crank.</b> stacSOL went eight epochs without an update and buying stopped. This crank needs no key, it keeps
            the stake pool updated, and every trade on this page runs that update too.
          </li>
          <li>
            <b>We bring our own market.</b> A third of every tax builds a $NGU/$100XBRO Orca position held by the program.
          </li>
          <li>
            <b>Half burned, not all.</b> stacSOL burned the whole fee and had nowhere to trade. This one burns half and turns the rest into depth.
          </li>
        </ol>
      </section>

      <pre className="ngu-announce">{ANNOUNCEMENT}</pre>

      <section className="ngu-two">
        <div>
          <h2 className="meta">true by construction</h2>
          <ul className="ngu-list">
            <li>SOL per $NGU rises with every burn. Only a loss at the validator could lower it.</li>
            <li>New $NGU only comes from SOL paid into the stake pool. The crank refuses any other token.</li>
            <li>The crank program has two instructions, initialize and crank. Neither removes liquidity or sends treasury tokens anywhere.</li>
            <li>Buying and selling on this page skip the transfer tax: no tokens change hands, the pool issues and retires them.</li>
          </ul>
        </div>
        <div>
          <h2 className="meta">not promised</h2>
          <ul className="ngu-list">
            <li>The Orca price and the USD value can go down. Only the SOL rate is one-directional.</li>
            <li>Moving $NGU between wallets or trading it on Orca pays the {tax} tax each time.</li>
            <li>Past stacSOL returns. That burned 100% of its tax; this burns half.</li>
            <li>Staking yield: the pool's SOL sits in its reserve until it has the 1 SOL a validator needs.</li>
          </ul>
        </div>
      </section>

      <section className="primer ngu-disclose">
        <h2 className="meta">disclosures</h2>
        <div>
          Transfer tax: {tax}
          {NGU.taxLocked == null ? "" : NGU.taxLocked ? " · locked forever" : " · the team can still lower or raise it"}
        </div>
        <div>
          Buy fee {i ? pct(i.fees.buyBps) : "…"} · sell fee {i ? pct(i.fees.sellBps) : "…"}
          {i?.fees.nextSellBps != null ? ` (rising to ${pct(i.fees.nextSellBps)} as the program allows)` : ""} · epoch fee{" "}
          {i ? pct(i.fees.epochBps) : "…"}
          {i?.fees.nextEpochBps != null ? ` (${pct(i.fees.nextEpochBps)} from two epochs after it was set)` : ""}. Pool fees go into the
          crank's treasury and get split like the tax: 3/6 burned, 1/6 → $100XBRO, 2/6 → liquidity.
        </div>
        <div>
          Orca pool: config <a href={solscan(NGU.orcaConfig)}>{shortKey(NGU.orcaConfig)}</a>, {NGU.orcaFeePct}% swap fee.{" "}
          {NGU.orcaProtocolSharePct}% of its trading fees go to the config's protocol-fee collector (us).
        </div>
        <div>
          Crank program <a href={solscan(NGU.programId)}>{shortKey(NGU.programId)}</a>:{" "}
          {NGU.programImmutable ? "immutable (upgrade authority renounced)" : "the team can still upgrade it until the authority is renounced"}.
        </div>
        <div>
          Crank safety: swaps and liquidity adds pause while the pool price is more than ~4% from a slow-moving reference, so nobody can push
          the price around to profit from the crank. Burns never pause.
        </div>
        {NGU.showAddresses && NGU.mint && (
          <div>
            Token <a href={solscan(NGU.mint)}>{shortKey(NGU.mint)}</a>
            {NGU.stakePool && (
              <>
                {" "}
                · stake pool <a href={solscan(NGU.stakePool)}>{shortKey(NGU.stakePool)}</a>
              </>
            )}
          </div>
        )}
        <div className="muted">Not financial advice. Not a promise of returns.</div>
      </section>
    </div>
  );
}

function Trade({ info, refresh }: { info: NguInfo | null; refresh: () => void }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const send = useSend();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const bal = usePoll(
    async () => {
      if (!publicKey || !NGU.mint) return null;
      const [lamports, ngu] = await Promise.all([
        connection.getBalance(publicKey),
        connection.getTokenAccountBalance(nguAta(publicKey)).then((r) => BigInt(r.value.amount)).catch(() => 0n),
      ]);
      return { sol: BigInt(lamports), ngu };
    },
    [publicKey?.toBase58(), connection],
    10_000,
  );
  const amt = parseAmount(text, 9);
  const quote = useMemo(() => {
    if (!info || !amt || amt <= 0n) return null;
    const r = rate(info);
    if (side === "buy") return { out: (Number(amt) / r) * (1 - info.fees.buyBps / 10000), unit: "$NGU", fee: info.fees.buyBps };
    return { out: Number(amt) * r * (1 - info.fees.sellBps / 10000), unit: "SOL", fee: info.fees.sellBps };
  }, [info, amt, side]);
  const max = side === "buy" ? (bal.data ? (bal.data.sol > 15_000_000n ? bal.data.sol - 15_000_000n : 0n) : null) : bal.data?.ngu ?? null;
  const over = amt != null && max != null && amt > max;
  const go = async () => {
    if (!info || !amt || amt <= 0n) return;
    setBusy(true);
    const sig = await send(side === "buy" ? "Buy $NGU" : "Sell $NGU", async (payer) =>
      side === "buy" ? buildBuy(payer, amt, info) : buildSell(payer, amt, info),
    );
    setBusy(false);
    if (sig) {
      setText("");
      bal.refresh();
      refresh();
    }
  };

  return (
    <div className="panel ngu-trade">
      <div className="ngu-tabs" role="tablist">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} role="tab" aria-selected={side === s} className={side === s ? "on" : ""} onClick={() => (setSide(s), setText(""))}>
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>
      <label className="ngu-field">
        <span className="meta">{side === "buy" ? "you pay" : "you sell"}</span>
        <div className="ngu-input">
          <input inputMode="decimal" placeholder="0.0" value={text} onChange={(e) => setText(e.target.value)} aria-label="amount" />
          <span className="meta">{side === "buy" ? "SOL" : "$NGU"}</span>
        </div>
        {max != null && (
          <div className="ngu-quick">
            <span className="muted">balance {sol(side === "buy" ? bal.data!.sol : bal.data!.ngu)}</span>
            {[25, 50, 100].map((p) => (
              <button key={p} className="chip" onClick={() => setText(fmt((max * BigInt(p)) / 100n, 9, 9).replace(/,/g, ""))}>
                {p === 100 ? "max" : `${p}%`}
              </button>
            ))}
          </div>
        )}
      </label>
      <div className="ngu-out">
        <span className="meta">you get</span>
        <span className="num">{quote ? `${quote.out / 1e9 < 0.0001 ? (quote.out / 1e9).toExponential(2) : (quote.out / 1e9).toFixed(6)} ${quote.unit}` : "—"}</span>
      </div>
      <div className="ngu-terms muted">
        At {info ? rate(info).toFixed(6) : "…"} SOL per $NGU · {side === "buy" ? "buy" : "sell"} fee {quote ? pct(quote.fee) : info ? pct(side === "buy" ? info.fees.buyBps : info.fees.sellBps) : "…"} · no
        slippage · no transfer tax
      </div>
      {publicKey ? (
        <button className="btn ngu-go" disabled={!info || !amt || amt <= 0n || over || busy} data-loading={busy} onClick={go}>
          {over ? "Not enough balance" : side === "buy" ? "Buy $NGU" : "Sell $NGU"}
        </button>
      ) : (
        <WalletButton solo />
      )}
    </div>
  );
}

/** TradingView chart of SOL per $NGU, one point per transaction that moved it (rebuilt from chain by /api/ngu-history). */
export function NguChart() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let w: { remove: () => void } | null = null;
    let dead = false;
    const url = "/tradingview/charting_library/charting_library.esm.js";
    (async () => {
      const lib = await import(/* @vite-ignore */ url);
      if (dead || !ref.current) return;
      const set = document.documentElement.getAttribute("data-theme");
      const dark = set ? set === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
      const bg = dark ? "#15120f" : "#f7f2ea";
      w = new lib.widget({
        container: ref.current,
        library_path: "/tradingview/charting_library/",
        datafeed: nguDatafeed(),
        symbol: "NGU",
        interval: "15",
        theme: dark ? "dark" : "light",
        autosize: true,
        locale: "en",
        timezone: "Etc/UTC",
        disabled_features: ["header_symbol_search", "symbol_search_hot_key", "header_compare", "header_saveload", "use_localstorage_for_settings", "display_market_status", "popup_hints"],
        overrides: {
          "mainSeriesProperties.style": 3,
          "mainSeriesProperties.areaStyle.linecolor": "#2fbf71",
          "mainSeriesProperties.areaStyle.color1": "rgba(47,191,113,0.35)",
          "mainSeriesProperties.areaStyle.color2": "rgba(47,191,113,0.02)",
          "mainSeriesProperties.areaStyle.linewidth": 2,
          "paneProperties.background": bg,
          "paneProperties.backgroundType": "solid",
          "paneProperties.vertGridProperties.color": dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)",
          "paneProperties.horzGridProperties.color": dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)",
        },
      });
    })().catch(() => {});
    return () => {
      dead = true;
      w?.remove();
    };
  }, []);
  return (
    <section>
      <h2 className="meta">SOL per $NGU · every crank, every trade</h2>
      <div ref={ref} className="ngu-chart" />
    </section>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="ngu-stat">
      <span className="meta">{k}</span>
      <span className="num">{v}</span>
    </div>
  );
}
