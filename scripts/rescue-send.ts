// Claim local-key fees and sweep the proceeds to 331nEBz4. Prints pubkeys and signatures only.
import { readFileSync, readdirSync, statSync } from "fs";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createTransferInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import BN from "bn.js";

const DEST = new PublicKey("331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth");
const ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const DBC = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const LB = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const X100 = new PublicKey("Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump");
const RFSTACC = new PublicKey("pSYRpDqr847kB2nD5ZhjcPsHLV2ZpUxweXm1MwiSTcc");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const KEEP = 1_000_000n;
const SYSTEM = new PublicKey("11111111111111111111111111111111");

const env = readFileSync("/Users/stacc/hooked/app/.env.local", "utf8");
const rpc = env.match(/^HELIUS_RPC_URL=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!rpc) throw new Error("HELIUS_RPC_URL missing");
const conn = new Connection(rpc, "confirmed");

function loadKeys(): Map<string, Keypair> {
  const out = new Map<string, Keypair>();
  const files = ["/Users/stacc/hooked.json", "/Users/stacc/collectionauth.json"];
  for (const d of ["/Users/stacc/.config/solana", "/Users/stacc/sexicurves/tests-fork/keys", "/Users/stacc/hooked/scripts"]) {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".json") || n.startsWith("market-keys") || n.startsWith("fork-keys")) continue;
      const p = `${d}/${n}`;
      try { if (!statSync(p).isFile() || statSync(p).size > 8000) continue; } catch { continue; }
      files.push(p);
    }
  }
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(f, "utf8"));
      if (!Array.isArray(raw) || raw.length < 64) continue;
      const kp = Keypair.fromSecretKey(Uint8Array.from(raw.slice(0, 64)));
      out.set(kp.publicKey.toBase58(), kp);
    } catch { /* not a key */ }
  }
  return out;
}

const u64 = (b: Buffer, o: number) => b.readBigUInt64LE(o);
const pk = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32));
const pda = (seeds: Buffer[], prog: PublicKey) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const i64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const bn = (n: bigint) => new BN(n.toString());

async function gpa(program: PublicKey, filters: Parameters<Connection["getProgramAccounts"]>[1] extends infer _ ? any[] : never, slice: { offset: number; length: number }, label: string) {
  for (let i = 0; i < 3; i++) {
    try {
      return await conn.getProgramAccounts(program, { filters, dataSlice: slice });
    } catch (e) {
      console.log(`GPA ${label} retry ${i} ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return [] as Awaited<ReturnType<Connection["getProgramAccounts"]>>;
}

async function send(label: string, payer: Keypair, ixs: TransactionInstruction[], signers: Keypair[]) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId))],
  }).compileToV0Message());
  const uniq = new Map<string, Keypair>();
  for (const s of [payer, ...signers]) uniq.set(s.publicKey.toBase58(), s);
  tx.sign([...uniq.values()]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false });
  if (sim.value.err) {
    const line = (sim.value.logs ?? []).find((l) => /error|failed|custom|insufficient/i.test(l)) ?? "";
    console.log(`FAIL ${label} ${JSON.stringify(sim.value.err)} ${line}`);
    return;
  }
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) { console.log(`FAIL confirm ${label} ${sig} ${JSON.stringify(res.value.err)}`); return; }
  console.log(`OK ${label} ${sig}`);
}

async function main() {
  const keys = loadKeys();
  const dest = keys.get(DEST.toBase58());
  const wmza = keys.get("WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb");
  const id12 = keys.get("12Nqk2jyA3XNe3rPxAaLFixytmohnMrBfCsdwrCfWNm2");
  if (!dest || !wmza || !id12) throw new Error("missing dest, wmza, or 12nq key");
  const owners = [...keys.values()].filter((k) => !k.publicKey.equals(DEST));

  // ---- pump creator fees ----
  const pump = new OnlinePumpSdk(conn);
  const xProg = await pump.fetchQuoteTokenProgram(X100);
  const xIxs = await pump.collectCoinCreatorFeeV2Instructions(dest.publicKey, X100, xProg, dest.publicKey);
  if (xIxs.length) await send("pump 331n $100XBRO", dest, xIxs, [dest]);
  for (const k of [dest, wmza]) {
    const ixs = await pump.collectCoinCreatorFeeInstructions(k.publicKey, k.publicKey);
    if (ixs.length) await send(`pump ${k.publicKey.toBase58()} SOL`, k, ixs, [k]);
  }

  // ---- DBC partner (WzMa) and creator (any local key) ----
  const dbc = DynamicBondingCurveClient.create(conn, "confirmed");
  const configs = await gpa(DBC, [{ memcmp: { offset: 40, bytes: wmza.publicKey.toBase58() } }], { offset: 0, length: 8 }, "configs");
  console.log(`dbc configs ${configs.length}`);
  let checked = false;
  let offsetOk = true;
  const claimed = new Set<string>();
  for (const cfg of offsetOk ? configs : []) {
    const pools = await gpa(DBC, [{ memcmp: { offset: 72, bytes: cfg.pubkey.toBase58() } }], { offset: 104, length: 176 }, cfg.pubkey.toBase58());
    await new Promise((r) => setTimeout(r, 400));
    for (const p of pools) {
      const d = p.account.data;
      if (d.length < 176) continue;
      const creator = pk(d, 0);
      const partnerBase = u64(d, 160);
      const partnerQuote = u64(d, 168);
      if (!checked && (partnerBase > 0n || partnerQuote > 0n)) {
        const live: any = await dbc.state.getPool(p.pubkey);
        const st = live?.poolState ?? live?.account ?? live;
        const qb = BigInt(st.partnerQuoteFee?.toString?.() ?? st.partner_quote_fee?.toString?.() ?? "-1");
        console.log(`dbc offset check pool ${p.pubkey.toBase58()} slice ${partnerQuote} decoded ${qb}`);
        if (qb !== partnerQuote) { console.log("dbc fee offset mismatch, skipping partner claims"); offsetOk = false; break; }
        checked = true;
      }
      if (partnerBase === 0n && partnerQuote === 0n) continue;
      if (claimed.has(p.pubkey.toBase58() + ":p")) continue;
      claimed.add(p.pubkey.toBase58() + ":p");
      try {
        const tx = await dbc.partner.claimPartnerTradingFee2({
          feeClaimer: wmza.publicKey, payer: wmza.publicKey, pool: p.pubkey,
          maxBaseAmount: bn(partnerBase), maxQuoteAmount: bn(partnerQuote), receiver: DEST,
        });
        await send(`dbc partner ${p.pubkey.toBase58()}`, wmza, tx.instructions, [wmza]);
      } catch (e) { console.log(`FAIL build partner ${p.pubkey.toBase58()} ${e instanceof Error ? e.message : e}`); }
      if (keys.has(creator.toBase58())) {
        const base = u64(d, 0); // placeholder, creator fees claimed below
        void base;
      }
    }
  }

  for (const k of [dest, ...owners]) {
    const pools = await gpa(DBC, [{ memcmp: { offset: 104, bytes: k.publicKey.toBase58() } }], { offset: 352, length: 16 }, `creator ${k.publicKey.toBase58().slice(0, 4)}`);
    for (const p of pools) {
      if (p.account.data.length < 16) continue;
      const base = u64(p.account.data, 0);
      const quote = u64(p.account.data, 8);
      if (base === 0n && quote === 0n) continue;
      try {
        const tx = await dbc.creator.claimCreatorTradingFee2({
          creator: k.publicKey, payer: k.publicKey, pool: p.pubkey,
          maxBaseAmount: bn(base), maxQuoteAmount: bn(quote), receiver: DEST,
        });
        await send(`dbc creator ${k.publicKey.toBase58().slice(0, 4)} ${p.pubkey.toBase58()}`, k, tx.instructions, [k]);
      } catch (e) { console.log(`FAIL build creator ${p.pubkey.toBase58()} ${e instanceof Error ? e.message : e}`); }
    }
  }

  // ---- orca positions with liquidity ----
  try { for (const k of [id12, dest]) {
    const tas = await conn.getParsedTokenAccountsByOwner(k.publicKey, { programId: TOKEN_2022_PROGRAM_ID });
    const nfts = tas.value.filter((t) => t.account.data.parsed.info.tokenAmount.amount === "1" && t.account.data.parsed.info.tokenAmount.decimals === 0);
    for (const t of nfts) {
      const mint = new PublicKey(t.account.data.parsed.info.mint);
      const pos = pda([Buffer.from("position"), mint.toBuffer()], ORCA);
      const info = await conn.getAccountInfo(pos);
      if (!info || !info.owner.equals(ORCA) || info.data.length < 96) continue;
      const liq = u64(info.data, 72) + (u64(info.data, 80) << 64n);
      if (liq === 0n) continue;
      const pool = pk(info.data, 8);
      const lower = info.data.readInt32LE(88);
      const upper = info.data.readInt32LE(92);
      const wp = await conn.getAccountInfo(pool);
      if (!wp) continue;
      const spacing = wp.data.readUInt16LE(41);
      const span = spacing * 88;
      const start = (tick: number) => Math.floor(tick / span) * span;
      const ta = (s: number) => pda([Buffer.from("tick_array"), pool.toBuffer(), Buffer.from(String(s))], ORCA);
      const mintA = pk(wp.data, 101);
      const vaultA = pk(wp.data, 133);
      const mintB = pk(wp.data, 181);
      const vaultB = pk(wp.data, 213);
      const [aOwn, bOwn] = await conn.getMultipleAccountsInfo([mintA, mintB]);
      const progA = aOwn?.owner ?? TOKEN_PROGRAM_ID;
      const progB = bOwn?.owner ?? TOKEN_PROGRAM_ID;
      const ata = (m: PublicKey, prog: PublicKey) => getAssociatedTokenAddressSync(m, k.publicKey, true, prog);
      const data = Buffer.alloc(40);
      Buffer.from([160, 38, 208, 111, 104, 91, 44, 1]).copy(data, 0);
      data.writeBigUInt64LE(liq & ((1n << 64n) - 1n), 8);
      data.writeBigUInt64LE(liq >> 64n, 16);
      const ix = new TransactionInstruction({
        programId: ORCA, data,
        keys: [
          { pubkey: pool, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: k.publicKey, isSigner: true, isWritable: false },
          { pubkey: pos, isSigner: false, isWritable: true },
          { pubkey: t.pubkey, isSigner: false, isWritable: false },
          { pubkey: ata(mintA, progA), isSigner: false, isWritable: true },
          { pubkey: ata(mintB, progB), isSigner: false, isWritable: true },
          { pubkey: vaultA, isSigner: false, isWritable: true },
          { pubkey: vaultB, isSigner: false, isWritable: true },
          { pubkey: ta(start(lower)), isSigner: false, isWritable: true },
          { pubkey: ta(start(upper)), isSigner: false, isWritable: true },
          { pubkey: ORCA, isSigner: false, isWritable: false },
        ],
      });
      const pre = [
        createAssociatedTokenAccountIdempotentInstruction(k.publicKey, ata(mintA, progA), k.publicKey, mintA, progA),
        createAssociatedTokenAccountIdempotentInstruction(k.publicKey, ata(mintB, progB), k.publicKey, mintB, progB),
      ];
      if (!progA.equals(TOKEN_PROGRAM_ID) || !progB.equals(TOKEN_PROGRAM_ID)) {
        console.log(`SKIP orca token22 ${pos.toBase58()}`);
        continue;
      }
      await send(`orca liq ${pos.toBase58()}`, k, [...pre, ix], [k]);
      const close = new TransactionInstruction({
        programId: ORCA,
        data: Buffer.from([1, 182, 135, 59, 155, 25, 99, 223]),
        keys: [
          { pubkey: k.publicKey, isSigner: true, isWritable: false },
          { pubkey: DEST, isSigner: false, isWritable: true },
          { pubkey: pos, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: true },
          { pubkey: t.pubkey, isSigner: false, isWritable: true },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: ORCA, isSigner: false, isWritable: false },
        ],
      });
      await send(`orca close ${pos.toBase58()}`, k, [close], [k]);
    }
  } } catch (e) { console.log(`orca section ${e instanceof Error ? e.message : e}`); }

  // ---- meteora DLMM, WzMa ----
  let dlmm: Awaited<ReturnType<Connection["getProgramAccounts"]>> = [];
  try {
    dlmm = await conn.getProgramAccounts(LB, {
      filters: [{ dataSize: 8120 }, { memcmp: { offset: 40, bytes: wmza.publicKey.toBase58() } }],
    });
  } catch (e) { console.log(`dlmm list ${e instanceof Error ? e.message.split("\n")[0] : e}`); }
  for (const row of dlmm) {
    const d = row.account.data;
    const pair = pk(d, 8);
    const lo = d.readInt32LE(7912);
    const hi = d.readInt32LE(7916);
    const pairInfo = await conn.getAccountInfo(pair);
    if (!pairInfo) continue;
    const mx = pk(pairInfo.data, 88);
    const my = pk(pairInfo.data, 120);
    const rx = pk(pairInfo.data, 152);
    const ry = pk(pairInfo.data, 184);
    const [xOwn, yOwn] = await conn.getMultipleAccountsInfo([mx, my]);
    const px = xOwn?.owner ?? TOKEN_PROGRAM_ID;
    const py = yOwn?.owner ?? TOKEN_PROGRAM_ID;
    const ax = getAssociatedTokenAddressSync(mx, wmza.publicKey, true, px);
    const ay = getAssociatedTokenAddressSync(my, wmza.publicKey, true, py);
    const idx = (bin: number) => Math.floor(bin / 70);
    const arrays: PublicKey[] = [];
    for (let i = idx(lo); i <= idx(hi); i++) arrays.push(pda([Buffer.from("bin_array"), pair.toBuffer(), i64(i)], LB));
    const bitmap = pda([Buffer.from("bitmap"), pair.toBuffer()], LB);
    const bmp = await conn.getAccountInfo(bitmap);
    const ev = pda([Buffer.from("__event_authority")], LB);
    const ix = new TransactionInstruction({
      programId: LB,
      data: Buffer.from([10, 51, 61, 35, 112, 105, 24, 85]),
      keys: [
        { pubkey: row.pubkey, isSigner: false, isWritable: true },
        { pubkey: pair, isSigner: false, isWritable: true },
        { pubkey: bmp ? bitmap : LB, isSigner: false, isWritable: true },
        { pubkey: ax, isSigner: false, isWritable: true },
        { pubkey: ay, isSigner: false, isWritable: true },
        { pubkey: rx, isSigner: false, isWritable: true },
        { pubkey: ry, isSigner: false, isWritable: true },
        { pubkey: mx, isSigner: false, isWritable: false },
        { pubkey: my, isSigner: false, isWritable: false },
        { pubkey: arrays[0], isSigner: false, isWritable: true },
        { pubkey: arrays[arrays.length - 1], isSigner: false, isWritable: true },
        { pubkey: wmza.publicKey, isSigner: true, isWritable: false },
        { pubkey: px, isSigner: false, isWritable: false },
        { pubkey: py, isSigner: false, isWritable: false },
        { pubkey: ev, isSigner: false, isWritable: false },
        { pubkey: LB, isSigner: false, isWritable: false },
        ...arrays.slice(1, -1).map((a) => ({ pubkey: a, isSigner: false, isWritable: true })),
      ],
    });
    await send(`dlmm ${row.pubkey.toBase58()}`, wmza, [
      createAssociatedTokenAccountIdempotentInstruction(wmza.publicKey, ax, wmza.publicKey, mx, px),
      createAssociatedTokenAccountIdempotentInstruction(wmza.publicKey, ay, wmza.publicKey, my, py),
      ix,
    ], [wmza]);
  }

  // ---- tokens worth moving, then SOL ----
  const keepMints = new Set([WSOL.toBase58(), USDC.toBase58(), X100.toBase58(), RFSTACC.toBase58(), "1jMtuLutv4XKPvN1qQmbTp3qiUqFKd3PAyBA4abYceg"]);
  for (const k of owners) {
    try {
    const info = await conn.getAccountInfo(k.publicKey);
    if (!info || !info.owner.equals(SYSTEM)) continue;
    const ixs: TransactionInstruction[] = [];
    for (const prog of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const tas = await conn.getParsedTokenAccountsByOwner(k.publicKey, { programId: prog });
      for (const t of tas.value) {
        const inf = t.account.data.parsed.info;
        const amt = BigInt(inf.tokenAmount.amount);
        const dec = inf.tokenAmount.decimals as number;
        if (amt === 0n) continue;
        if (dec === 0) continue;
        const mint = new PublicKey(inf.mint);
        if (!keepMints.has(inf.mint) && amt < 1_000_000n) continue;
        if (mint.equals(WSOL)) {
          ixs.push(createCloseAccountInstruction(t.pubkey, k.publicKey, k.publicKey, [], prog));
          continue;
        }
        const destAta = getAssociatedTokenAddressSync(mint, DEST, true, prog);
        ixs.push(
          createAssociatedTokenAccountIdempotentInstruction(k.publicKey, destAta, DEST, mint, prog),
          createTransferInstruction(t.pubkey, destAta, k.publicKey, amt, [], prog),
          createCloseAccountInstruction(t.pubkey, DEST, k.publicKey, [], prog),
        );
      }
    }
    for (let i = 0; i < ixs.length; i += 8) await send(`tokens ${k.publicKey.toBase58().slice(0, 4)}`, k, ixs.slice(i, i + 8), [k]);
    const bal = BigInt(await conn.getBalance(k.publicKey));
    const sendLamports = bal > KEEP + 5_000n ? bal - KEEP : 0n;
    if (sendLamports > 0n) {
      await send(`sol ${k.publicKey.toBase58()} ${sendLamports}`, k, [SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: DEST, lamports: Number(sendLamports) })], [k]);
    }
    } catch (e) { console.log(`sweep ${k.publicKey.toBase58()} ${e instanceof Error ? e.message : e}`); }
  }
  const left = await conn.getBalance(DEST);
  console.log(`DEST_SOL ${left}`);
  console.log("RESCUE_DONE");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
