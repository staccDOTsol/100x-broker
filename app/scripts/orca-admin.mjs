// Admin for the Orca Whirlpool configs 12Nqk2 controls (fee authority + protocol-fee collector on 385 configs). The owner runs
// this; it signs with ~/.config/solana/id.json, which must be 12Nqk2. Every command is a dry run (simulated) unless --send.
//
//   node scripts/orca-admin.mjs protocol-fee [--rate 2500] [--send]
//       default protocol fee on every config (2500 bps = 25% of each swap fee, Orca's max). Pools opened afterwards inherit it.
//   node scripts/orca-admin.mjs tiers [--spacing 256] [--fee 10000] [--count 64] [--send]
//       a fixed fee tier (fee in hundredths of a bp: 10000 = 1%, max 60000 = 6%) on configs that lack that spacing
//   node scripts/orca-admin.mjs adaptive-tiers [--spacing 256] [--base-fee 10000] [--count 64] [--send]
//       a permissionless adaptive (dynamic) fee tier, constants copied from Orca's own 128-spacing tier
//   node scripts/orca-admin.mjs alt [--alt <address>] [--send]
//       the Orca launch lookup table (authority 12Nqk2): sysvars, token programs, the good quotes, and every config + wide tier,
//       so each launch pool fits in one transaction. Without --alt it creates a new table and prints its address.
//   node scripts/orca-admin.mjs list
//   any command: --sim-rpc http://127.0.0.1:8999 simulates (or with --send, sends) against a local fork instead of mainnet
//       configs, their defaults, and the wide tiers (spacing >= 128) the launchpad can use
//
// Reads HELIUS_RPC_URL from .env.local (program scans need Helius's paginated getProgramAccountsV2).
import fs from "node:fs";
import os from "node:os";
import { AddressLookupTableProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { GOOD_QUOTES, ORCA_STATIC } from "../src/lib/orcaquotes.ts";

const WP = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const AUTH = "12Nqk2jyA3XNe3rPxAaLFixytmohnMrBfCsdwrCfWNm2";
const env = Object.fromEntries(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n").map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^"|"$/g, "")]));
const RPC = env.HELIUS_RPC_URL;
// --sim-rpc <url>: simulate/send against another RPC (e.g. a local fork) while discovery stays on Helius
const conn = new Connection(process.argv.includes("--sim-rpc") ? process.argv[process.argv.indexOf("--sim-rpc") + 1] : RPC, "confirmed");
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SEND = args.includes("--send");

const DISC = {
  setDefaultProtocolFeeRate: [107, 205, 249, 226, 151, 35, 86, 0],
  initializeFeeTier: [183, 74, 156, 160, 112, 2, 42, 30],
  initializeAdaptiveFeeTier: [77, 99, 208, 200, 141, 123, 117, 48],
};
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const feeTierPda = (config, index) => PublicKey.findProgramAddressSync([Buffer.from("fee_tier"), config.toBuffer(), u16(index)], WP)[0];

async function gpa(filters) {
  const all = [];
  let paginationKey = null;
  for (let p = 0; p < 200; p++) {
    const body = { jsonrpc: "2.0", id: 1, method: "getProgramAccountsV2", params: [WP.toBase58(), { encoding: "base64", filters, limit: 1000, ...(paginationKey && { paginationKey }) }] };
    let j;
    for (let t = 0; t < 5; t++) {
      j = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
      if (!j.error) break;
      await new Promise((r) => setTimeout(r, 1500 * (t + 1)));
    }
    if (j.error) throw new Error(JSON.stringify(j.error));
    for (const a of j.result.accounts) all.push({ key: new PublicKey(a.pubkey), data: Buffer.from(a.account.data[0], "base64") });
    paginationKey = j.result.paginationKey;
    if (!paginationKey || !j.result.accounts.length) break;
  }
  return all;
}

async function configs() {
  const rows = await gpa([{ dataSize: 108 }, { memcmp: { offset: 8, bytes: AUTH } }]);
  return rows.map((r) => ({ key: r.key, defaultProtocolFee: r.data.readUInt16LE(104), featureFlags: r.data.readUInt16LE(106) }));
}
async function tiersOf(cfgs) {
  // fixed tiers are 44 bytes, adaptive 256; both keyed by config at offset 8
  // adaptive tiers by their discriminator: on chain they are 256 bytes (reserved space), not the client's 128
  const [fixed, adaptive] = await Promise.all([gpa([{ dataSize: 44 }]), gpa([{ memcmp: { offset: 0, bytes: "RbiHfkM4pGM" } }])]);
  const mine = new Set(cfgs.map((c) => c.key.toBase58()));
  const out = new Map(cfgs.map((c) => [c.key.toBase58(), []]));
  for (const t of fixed) { const c = new PublicKey(t.data.subarray(8, 40)).toBase58(); if (mine.has(c)) out.get(c).push({ key: t.key, kind: "fixed", index: t.data.readUInt16LE(40), tickSpacing: t.data.readUInt16LE(40), fee: t.data.readUInt16LE(42) }); }
  for (const t of adaptive) { const c = new PublicKey(t.data.subarray(8, 40)).toBase58(); if (mine.has(c)) out.get(c).push({ key: t.key, kind: "adaptive", index: t.data.readUInt16LE(40), tickSpacing: t.data.readUInt16LE(42), fee: t.data.readUInt16LE(108), permissioned: !t.data.subarray(44, 76).equals(Buffer.alloc(32)) }); }
  return out;
}

function signer() {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8"))));
  if (kp.publicKey.toBase58() !== AUTH) throw new Error(`id.json is ${kp.publicKey.toBase58()}, not ${AUTH}`);
  return kp;
}

async function run(label, ixs, perTx) {
  const kp = signer();
  const bal = await conn.getBalance(kp.publicKey);
  console.log(`${label}: ${ixs.length} instructions in ${Math.ceil(ixs.length / perTx)} transactions; 12Nqk2 has ${(bal / 1e9).toFixed(4)} SOL`);
  for (let i = 0; i < ixs.length; i += perTx) {
    const batch = ixs.slice(i, i + perTx);
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 + batch.length * 25_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }), ...batch);
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    if (!SEND) {
      tx.sign(kp);
      const sim = await conn.simulateTransaction(tx);
      console.log(`  batch ${i / perTx + 1}: ${sim.value.err ? `FAILS ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(" | ")}` : `ok (${sim.value.unitsConsumed} CU)`}`);
      continue;
    }
    const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
    console.log(`  batch ${i / perTx + 1}: ${sig}`);
  }
  if (!SEND) console.log("dry run only; add --send to sign and send");
}

if (cmd === "list") {
  const cfgs = await configs();
  const tiers = await tiersOf(cfgs);
  const fees = {};
  for (const c of cfgs) fees[c.defaultProtocolFee] = (fees[c.defaultProtocolFee] ?? 0) + 1;
  console.log(`${cfgs.length} configs; default protocol fee (bps -> configs):`, fees);
  const wide = [...tiers.entries()].flatMap(([c, ts]) => ts.filter((t) => t.tickSpacing >= 128 && t.tickSpacing < 32768).map((t) => ({ config: c, ...t, key: t.key.toBase58() })));
  console.log(`${wide.length} wide tiers (spacing 128..16384) the launchpad can use:`);
  for (const t of wide) console.log(`  ${t.config} ${t.kind} spacing ${t.tickSpacing} fee ${(t.fee / 10000).toFixed(2)}%${t.permissioned ? " (permissioned)" : ""} ${t.key}`);
} else if (cmd === "protocol-fee") {
  const rate = Number(flag("rate", 2500));
  if (!(rate >= 0 && rate <= 2500)) throw new Error("rate is 0..2500 bps");
  const cfgs = (await configs()).filter((c) => c.defaultProtocolFee !== rate);
  const kp = new PublicKey(AUTH);
  const ixs = cfgs.map((c) => new TransactionInstruction({ programId: WP, keys: [{ pubkey: c.key, isSigner: false, isWritable: true }, { pubkey: kp, isSigner: true, isWritable: false }], data: Buffer.from([...DISC.setDefaultProtocolFeeRate, ...u16(rate)]) }));
  await run(`default protocol fee -> ${rate} bps`, ixs, 20);
} else if (cmd === "tiers" || cmd === "adaptive-tiers") {
  const spacing = Number(flag("spacing", 256));
  const count = Number(flag("count", 64));
  const cfgs = await configs();
  const tiers = await tiersOf(cfgs);
  const auth = new PublicKey(AUTH);
  const ixs = [];
  for (const c of cfgs) {
    if (ixs.length >= count) break;
    const have = tiers.get(c.key.toBase58());
    if (cmd === "tiers") {
      if (have.some((t) => t.index === spacing)) continue;
      const fee = Number(flag("fee", 10000));
      ixs.push(new TransactionInstruction({ programId: WP, keys: [
        { pubkey: c.key, isSigner: false, isWritable: false }, { pubkey: feeTierPda(c.key, spacing), isSigner: false, isWritable: true },
        { pubkey: auth, isSigner: true, isWritable: true }, { pubkey: auth, isSigner: true, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data: Buffer.from([...DISC.initializeFeeTier, ...u16(spacing), ...u16(fee)]) }));
    } else {
      if (have.some((t) => t.kind === "adaptive" && t.tickSpacing === spacing)) continue;
      // fee-tier index shares the "fee_tier" seed with fixed tiers: 1024 + spacing, or the next free one
      let index = 1024 + spacing;
      while (have.some((t) => t.index === index)) index++;
      const base = Number(flag("base-fee", 10000));
      // Orca's own permissionless 128-spacing tier: filter 30 s, decay 600 s, reduction 5000, control 20000, max volatility 100000
      const data = Buffer.concat([Buffer.from(DISC.initializeAdaptiveFeeTier), u16(index), u16(spacing), PublicKey.default.toBuffer(), PublicKey.default.toBuffer(),
        u16(base), u16(30), u16(600), u16(5000), u32(20000), u32(100000), u16(spacing), u16(spacing)]);
      ixs.push(new TransactionInstruction({ programId: WP, keys: [
        { pubkey: c.key, isSigner: false, isWritable: false }, { pubkey: feeTierPda(c.key, index), isSigner: false, isWritable: true },
        { pubkey: auth, isSigner: true, isWritable: true }, { pubkey: auth, isSigner: true, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], data }));
    }
  }
  await run(`${cmd} spacing ${spacing}`, ixs, cmd === "tiers" ? 8 : 5);
} else if (cmd === "alt") {
  const cfgs = await configs();
  const tiers = await tiersOf(cfgs);
  // on a fork the new tiers exist only there: probe the fork for the spacing-256 ones too
  const extra = [];
  if (args.includes("--sim-rpc")) {
    const probe = cfgs.flatMap((c) => [{ c: c.key, i: 256 }, { c: c.key, i: 1280 }]);
    for (let i = 0; i < probe.length; i += 100) {
      const infos = await conn.getMultipleAccountsInfo(probe.slice(i, i + 100).map((x) => feeTierPda(x.c, x.i)));
      infos.forEach((a, j) => { if (a) extra.push({ config: probe[i + j].c.toBase58(), tier: feeTierPda(probe[i + j].c, probe[i + j].i).toBase58() }); });
    }
  }
  const wide = [...tiers.entries()].flatMap(([c, ts]) => ts.filter((t) => t.tickSpacing >= 128 && t.tickSpacing < 32768 && !t.permissioned).map((t) => ({ config: c, tier: t.key.toBase58() })));
  const want = [...new Set([...ORCA_STATIC, ...GOOD_QUOTES.map((q) => q.mint), ...[...wide, ...extra].flatMap((w) => [w.config, w.tier])])];
  if (want.length > 256) console.log(`${want.length} addresses; a table holds 256, keeping the first 256`);
  const auth = new PublicKey(AUTH);
  let table = flag("alt", null);
  const ixs = [];
  let have = [];
  if (table) {
    have = ((await conn.getAddressLookupTable(new PublicKey(table))).value?.state.addresses ?? []).map((a) => a.toBase58());
  } else {
    const [create, key] = AddressLookupTableProgram.createLookupTable({ authority: auth, payer: auth, recentSlot: await conn.getSlot("finalized") });
    ixs.push(create);
    table = key.toBase58();
  }
  const add = want.filter((a) => !have.includes(a)).slice(0, 256 - have.length).map((a) => new PublicKey(a));
  for (let i = 0; i < add.length; i += 25) ixs.push(AddressLookupTableProgram.extendLookupTable({ lookupTable: new PublicKey(table), authority: auth, payer: auth, addresses: add.slice(i, i + 25) }));
  console.log(`launch table ${table}: ${have.length} listed, adding ${add.length} (${wide.length + extra.length} wide tiers)`);
  await run("alt", ixs, 1);
} else {
  console.log("commands: list | protocol-fee | tiers | adaptive-tiers | alt   (see the header of this file)");
}
