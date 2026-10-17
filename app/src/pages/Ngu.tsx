// /ngu — the stacSOL successor. Mechanism copy is tied to what the ngu-crank program enforces (see its docs/MARKETING.md);
// live numbers appear once ../ngu.ts is filled from the launch.
import { useEffect } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { usePoll } from "../hooks";
import { NGU, NGU_LABEL, nguLive } from "../ngu";
import "../ngu.css";

const ANNOUNCEMENT = `'fix the trenches, stacc,' they said
'it'll be easy, stacc, just give them a better casino with less fees, stacc,' they said
stacc thought to self 'yea, but that preserves all the bits wrong with the trenches lol: the unseen unsightly organ grinder that runs beneath the surface n taxes us whatever we dumb enough to donate to it, enuff times those %s add up and we left w less than we started with,' stacc thought to self
and then: 'idk, we have enough bits n bobs lying around we can tie number-go-up tech directly to prospecting, and then all actors invariably happy?? including the organ grinder itself?? 🤔'
so net net we fix nothing: we just attract an underrepresented class of users, those risk-averse folks that don't like memes cuz it is lighting monye on fire
this tweet is a complete and utter abandon: a surrender.
it's also an announcement of the unholy marriage of 100x.broker n the remains of stacsol/infity, as well as everything we learned in the post-mortum:`;

const pct = (bps: number | null | undefined) => (bps == null ? "set at launch" : `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`);
const shortKey = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
const solscan = (k: string) => `https://solscan.io/account/${k}`;

type Live = { backing: number; supply: number; burned: number; swapped: number; lp: number; cranks: number };
function useLive() {
  const { connection } = useConnection();
  return usePoll<Live | null>(
    async () => {
      if (!nguLive()) return null;
      const [pool, supply, state] = await Promise.all([
        connection.getAccountInfo(new PublicKey(NGU.stakePool!)),
        connection.getTokenSupply(new PublicKey(NGU.mint!)),
        connection.getAccountInfo(new PublicKey(NGU.state!)),
      ]);
      if (!pool || !state) return null;
      // stake pool: total_lamports at 258; crank state: totals after the 1+1+32*10+1+8+8+16+8 byte prefix
      const o = 8 + 1 + 1 + 32 * 10 + 1 + 8 + 8 + 16 + 8;
      const d = state.data;
      return {
        backing: Number(pool.data.readBigUInt64LE(258)) / 1e9,
        supply: Number(supply.value.uiAmount ?? 0),
        burned: Number(d.readBigUInt64LE(o)) / 1e9,
        swapped: Number(d.readBigUInt64LE(o + 8)) / 1e9,
        lp: Number(d.readBigUInt64LE(o + 16)) / 1e9,
        cranks: Number(d.readBigUInt64LE(o + 24)),
      };
    },
    [],
    20_000,
  );
}

export default function NguPage() {
  useEffect(() => {
    document.title = `${NGU_LABEL()} — staked SOL whose SOL rate only goes up · 100x.broker`;
  }, []);
  const live = useLive().data;
  const tax = pct(NGU.taxBps);

  return (
    <div className="ngu">
      <section className="ngu-top">
        <span className="meta">the surrender</span>
        <h1 className="display ngu-title">
          The SOL rate
          <br />
          only goes up.
        </h1>
        <p className="ngu-lead">
          {NGU_LABEL()} is staked SOL with a {tax} tax on every transfer. A permissionless crank burns half of each tax, buys Fr28 with
          a sixth, and adds the rest to liquidity the program owns forever. Burns shrink supply while the SOL stays in the pool, so SOL
          per {NGU_LABEL()} can only rise. Volume is the yield.
        </p>
        {!nguLive() && <div className="ngu-pending meta">Launch pending · addresses and live numbers appear here at launch</div>}
      </section>

      <pre className="ngu-announce">{ANNOUNCEMENT}</pre>

      <section>
        <h2 className="meta">what the post-mortem taught us</h2>
        <ol className="ngu-lessons">
          <li>
            <b>The tax goes to a program, not a wallet.</b> stacSOL's withheld fees answered to one wallet; when it was compromised the burn
            loop died with it. Here, only the crank program's address can collect them, and it can only split them three ways.
          </li>
          <li>
            <b>Anyone can run the crank.</b> stacSOL went eight epochs without an update and deposits stopped. This crank needs no key, and it
            also runs the stake pool's epoch update.
          </li>
          <li>
            <b>We bring our own liquidity.</b> No listing needed: a third of every tax builds a {NGU_LABEL()}/Fr28 Orca position held by the
            program.
          </li>
          <li>
            <b>Half burned, not all.</b> stacSOL burned the whole fee and had nowhere to trade. This one burns half and turns the rest into
            depth.
          </li>
        </ol>
      </section>

      <section>
        <h2 className="meta">every tax, split</h2>
        <div className="ngu-split" role="img" aria-label="3/6 burned, 1/6 to Fr28, 2/6 to liquidity">
          <span className="burn" style={{ flex: 3 }}>
            3/6 burned
          </span>
          <span className="fr28" style={{ flex: 1 }}>
            1/6 → Fr28
          </span>
          <span className="lp" style={{ flex: 2 }}>
            2/6 → liquidity
          </span>
        </div>
        <ul className="howto ngu-howto">
          <li>
            <b className="display">Mint</b>
            <p>Deposit SOL, get {NGU_LABEL()} at the live rate. Minting isn't a transfer, so it pays no tax.</p>
          </li>
          <li>
            <b className="display">Move it</b>
            <p>Every transfer, buy or sell pays {tax}. The crank burns half, and SOL per {NGU_LABEL()} rises for everyone holding.</p>
          </li>
          <li>
            <b className="display">Depth compounds</b>
            <p>The other half buys Fr28 and joins a {NGU_LABEL()}/Fr28 position the program owns. Nobody can withdraw it.</p>
          </li>
        </ul>
      </section>

      {live && (
        <section className="panel ngu-live">
          <h2 className="meta">live</h2>
          <div className="ngu-stats">
            <Stat k="SOL per token" v={(live.backing / live.supply).toFixed(9)} />
            <Stat k="SOL backing" v={live.backing.toLocaleString(undefined, { maximumFractionDigits: 3 })} />
            <Stat k="supply" v={live.supply.toLocaleString(undefined, { maximumFractionDigits: 3 })} />
            <Stat k="burned" v={live.burned.toLocaleString(undefined, { maximumFractionDigits: 3 })} />
            <Stat k="into Fr28" v={live.swapped.toLocaleString(undefined, { maximumFractionDigits: 3 })} />
            <Stat k="into liquidity" v={live.lp.toLocaleString(undefined, { maximumFractionDigits: 3 })} />
            <Stat k="cranks" v={String(live.cranks)} />
          </div>
        </section>
      )}

      <section className="ngu-two">
        <div>
          <h2 className="meta">true by construction</h2>
          <ul className="ngu-list">
            <li>SOL per {NGU_LABEL()} rises with every burn. Only a loss at the validator could lower it.</li>
            <li>Supply only comes from SOL deposited into the stake pool. The crank refuses any other mint.</li>
            <li>The program has two instructions, initialize and crank. Neither removes liquidity or sends treasury tokens anywhere.</li>
            <li>Mint and redeem at the pool rate with no transfer tax.</li>
          </ul>
        </div>
        <div>
          <h2 className="meta">not promised</h2>
          <ul className="ngu-list">
            <li>The Orca price and the USD value can go down. Only the SOL redemption rate is one-directional.</li>
            <li>Buying on Orca above the rate and selling below it loses the gap, plus tax both ways.</li>
            <li>Past stacSOL returns. That burned 100% of its tax; this burns half.</li>
            <li>Staking yield, unless the reserve is delegated.</li>
          </ul>
        </div>
      </section>

      <section className="primer ngu-disclose">
        <h2 className="meta">disclosures</h2>
        <div>
          Transfer tax: {tax}
          {NGU.taxLocked == null ? "" : NGU.taxLocked ? " · locked forever (fee-config authority burned)" : " · the team can still change it"}
        </div>
        <div>
          Stake-pool fees: {NGU.poolFees ? `epoch ${pct(NGU.poolFees.epochBps)}, deposit ${pct(NGU.poolFees.depositBps)}, withdrawal ${pct(NGU.poolFees.withdrawBps)}` : "set at launch"}
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
        {NGU.mint && (
          <div>
            Mint <a href={solscan(NGU.mint)}>{shortKey(NGU.mint)}</a>
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

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="ngu-stat">
      <span className="meta">{k}</span>
      <span className="num">{v}</span>
    </div>
  );
}
