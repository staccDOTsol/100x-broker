// NGU buy/sell at the pool rate: SPL stake-pool DepositSol (buy) and WithdrawSol (sell) on Sanctum's SP12 program.
// Every trade first runs the pool's permissionless update, so the rate shown (SOL ÷ live supply) is the rate filled
// and a stale epoch can never block a trade. Minting and redeeming aren't transfers, so the NGU tax doesn't apply.
import { PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_STAKE_HISTORY_PUBKEY, StakeProgram, Transaction, TransactionInstruction, ComputeBudgetProgram, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { NGU } from "../ngu";

const SPL_STAKE_POOL = new PublicKey("SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY");
const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const m = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

export type NguInfo = {
  backingLamports: bigint;
  supply: bigint; // live mint supply (burns show up immediately)
  burned: bigint;
  swapped: bigint;
  lp: bigint;
  cranks: bigint;
  stale: boolean;
  reserve: PublicKey;
  managerFee: PublicKey;
  validatorList: PublicKey;
  validatorPairs: PublicKey[];
  /** Fees in bps as the pool charges them now; `next*` is a scheduled change (applies two epochs after it was set). */
  fees: { buyBps: number; sellBps: number; epochBps: number; nextSellBps: number | null; nextEpochBps: number | null };
};

/** SPL StakePool fee fields after the fixed header (offset 258); several are variable-length Options/FutureEpochs. */
function parseFees(d: Buffer): NguInfo["fees"] {
  let o = 258 + 24 + 48;
  const fee = () => { const den = d.readBigUInt64LE(o), num = d.readBigUInt64LE(o + 8); o += 16; return den === 0n ? 0 : Number((num * 10000n) / den); };
  const future = () => { const tag = d[o]; o += 1; return tag === 1 || tag === 2 ? fee() : null; };
  const optKey = () => { const tag = d[o]; o += 1 + (tag === 1 ? 32 : 0); };
  const epochBps = fee(); const nextEpochBps = future(); optKey(); optKey();
  fee(); fee(); future(); o += 1; // stake deposit/withdrawal + next, stake referral
  optKey(); const buyBps = fee(); o += 1; // sol deposit authority, sol deposit fee, sol referral
  optKey(); const sellBps = fee(); const nextSellBps = future(); // sol withdraw authority, sol withdrawal fee + next
  return { buyBps, sellBps, epochBps, nextSellBps, nextEpochBps };
}

export async function readNgu(conn: Connection): Promise<NguInfo | null> {
  if (!NGU.mint || !NGU.stakePool || !NGU.state) return null;
  const pool = new PublicKey(NGU.stakePool);
  const [p, mintAcc, st, clock] = await conn.getMultipleAccountsInfo([pool, new PublicKey(NGU.mint), new PublicKey(NGU.state), CLOCK]);
  if (!p || !mintAcc || !st || !clock) return null;
  const d = p.data;
  const key = (o: number) => new PublicKey(d.subarray(o, o + 32));
  const validatorList = key(98);
  const vl = await conn.getAccountInfo(validatorList);
  const validatorPairs: PublicKey[] = [];
  if (vl) {
    const n = vl.data.readUInt32LE(5);
    for (let i = 0; i < n; i++) {
      const o = 9 + 73 * i, tseed = vl.data.readBigUInt64LE(o + 24), vseed = vl.data.readUInt32LE(o + 36);
      const vote = new PublicKey(vl.data.subarray(o + 41, o + 73));
      const seeds = [vote.toBuffer(), pool.toBuffer(), ...(vseed ? [Buffer.from(new Uint32Array([vseed]).buffer)] : [])];
      validatorPairs.push(PublicKey.findProgramAddressSync(seeds, SPL_STAKE_POOL)[0]);
      validatorPairs.push(PublicKey.findProgramAddressSync([Buffer.from("transient"), vote.toBuffer(), pool.toBuffer(), u64(tseed)], SPL_STAKE_POOL)[0]);
    }
  }
  // crank state totals sit after the fixed prefix: tag 8, version 1, bump 1, ten keys, ngu_is_a 1, two queues, ref price 16, ref slot 8
  const o = 8 + 1 + 1 + 32 * 10 + 1 + 8 + 8 + 16 + 8;
  return {
    backingLamports: d.readBigUInt64LE(258),
    supply: mintAcc.data.readBigUInt64LE(36),
    burned: st.data.readBigUInt64LE(o),
    swapped: st.data.readBigUInt64LE(o + 8),
    lp: st.data.readBigUInt64LE(o + 16),
    cranks: st.data.readBigUInt64LE(o + 24),
    stale: d.readBigUInt64LE(274) < clock.data.readBigUInt64LE(16),
    reserve: key(130),
    managerFee: key(194),
    validatorList,
    validatorPairs,
    fees: parseFees(d),
  };
}

/** SOL per NGU from live supply. Each trade syncs the pool's cached supply first, so this is the fill rate. */
export const rate = (i: NguInfo) => (i.supply === 0n ? 1 : Number(i.backingLamports) / Number(i.supply));

function updateIxs(i: NguInfo): TransactionInstruction[] {
  const pool = new PublicKey(NGU.stakePool!);
  const wAuth = PublicKey.findProgramAddressSync([pool.toBuffer(), Buffer.from("withdraw")], SPL_STAKE_POOL)[0];
  return [
    new TransactionInstruction({ programId: SPL_STAKE_POOL, data: Buffer.from([6, 0, 0, 0, 0, 0]),
      keys: [m(pool), m(wAuth), m(i.validatorList, true), m(i.reserve, true), m(SYSVAR_CLOCK_PUBKEY), m(SYSVAR_STAKE_HISTORY_PUBKEY), m(StakeProgram.programId), ...i.validatorPairs.map(p => m(p, true))] }),
    new TransactionInstruction({ programId: SPL_STAKE_POOL, data: Buffer.from([7]),
      keys: [m(pool, true), m(wAuth), m(i.validatorList, true), m(i.reserve), m(i.managerFee, true), m(new PublicKey(NGU.mint!), true), m(TOKEN_2022_PROGRAM_ID)] }),
  ];
}

export function buildBuy(payer: PublicKey, lamports: bigint, i: NguInfo): Transaction {
  const pool = new PublicKey(NGU.stakePool!), mint = new PublicKey(NGU.mint!);
  const wAuth = PublicKey.findProgramAddressSync([pool.toBuffer(), Buffer.from("withdraw")], SPL_STAKE_POOL)[0];
  const ata = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_2022_PROGRAM_ID);
  return new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ...updateIxs(i),
    createAssociatedTokenAccountIdempotentInstruction(payer, ata, payer, mint, TOKEN_2022_PROGRAM_ID),
    new TransactionInstruction({ programId: SPL_STAKE_POOL, data: Buffer.concat([Buffer.from([14]), u64(lamports)]),
      keys: [m(pool, true), m(wAuth), m(i.reserve, true), m(payer, true, true), m(ata, true), m(i.managerFee, true), m(i.managerFee, true), m(mint, true),
        m(SystemProgram.programId), m(TOKEN_2022_PROGRAM_ID)] }),
  );
}

export function buildSell(payer: PublicKey, amount: bigint, i: NguInfo): Transaction {
  const pool = new PublicKey(NGU.stakePool!), mint = new PublicKey(NGU.mint!);
  const wAuth = PublicKey.findProgramAddressSync([pool.toBuffer(), Buffer.from("withdraw")], SPL_STAKE_POOL)[0];
  const ata = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_2022_PROGRAM_ID);
  return new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ...updateIxs(i),
    new TransactionInstruction({ programId: SPL_STAKE_POOL, data: Buffer.concat([Buffer.from([16]), u64(amount)]),
      keys: [m(pool, true), m(wAuth), m(payer, false, true), m(ata, true), m(i.reserve, true), m(payer, true), m(i.managerFee, true), m(mint, true),
        m(SYSVAR_CLOCK_PUBKEY), m(SYSVAR_STAKE_HISTORY_PUBKEY), m(StakeProgram.programId), m(TOKEN_2022_PROGRAM_ID)] }),
  );
}

export const nguAta = (owner: PublicKey) => getAssociatedTokenAddressSync(new PublicKey(NGU.mint!), owner, false, TOKEN_2022_PROGRAM_ID);
