// Read-only inventory of claimable fees and wallet-owned liquidity on local keys.
// Prints pubkeys and amounts only. Never prints secret key material.
import { readFileSync, readdirSync, statSync } from "fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getPdaCreatorVault, getPdaPlatformId, getPdaPlatformVault, LAUNCHPAD_PROGRAM } from "@raydium-io/raydium-sdk-v2";

const DEST = new PublicKey("331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth");
const ORCA = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const DBC = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMPSWAP = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const LB = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const RAY = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN22 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const X100 = new PublicKey("Fr28jEWz2msSCKLaHzus2nCKrwqbpTx2EyDYtsVVpump");
const QUOTES = [WSOL, USDC, X100];

const env = readFileSync("/Users/stacc/hooked/app/.env.local", "utf8");
const rpc = env.match(/^HELIUS_RPC_URL=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
if (!rpc) throw new Error("HELIUS_RPC_URL missing");
const conn = new Connection(rpc, "confirmed");

const DIRS = [
  "/Users/stacc/.config/solana",
  "/Users/stacc/sexicurves/tests-fork/keys",
  "/Users/stacc/sexicurves/target/deploy",
  "/Users/stacc/hooked/scripts",
];
const EXTRA = ["/Users/stacc/hooked.json", "/Users/stacc/collectionauth.json"];

function loadKeyFiles(): { file: string; pk: PublicKey }[] {
  const out: { file: string; pk: PublicKey }[] = [];
  const seen = new Set<string>();
  const files: string[] = [...EXTRA];
  for (const d of DIRS) {
    let names: string[] = [];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      if (n.startsWith("market-keys") || n.startsWith("fork-keys")) continue;
      const p = `${d}/${n}`;
      try {
        if (!statSync(p).isFile() || statSync(p).size > 8000) continue;
      } catch {
        continue;
      }
      files.push(p);
    }
  }
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(f, "utf8"));
      if (!Array.isArray(raw) || raw.length < 64 || typeof raw[0] !== "number") continue;
      const pk = Keypair.fromSecretKey(Uint8Array.from(raw.slice(0, 64))).publicKey;
      const b = pk.toBase58();
      if (seen.has(b)) continue;
      seen.add(b);
      out.push({ file: f.split("/").slice(-2).join("/"), pk });
    } catch {
      /* not a keypair */
    }
  }
  return out;
}

const u64 = (b: Buffer, o: number) => b.readBigUInt64LE(o);
const pkAt = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32));
const short = (p: PublicKey) => p.toBase58();

async function main() {
  const keys = loadKeyFiles();
  console.log(`keys ${keys.length}`);
  for (const k of keys) console.log(`KEY ${short(k.pk)}  ${k.file}${k.pk.equals(DEST) ? "  DEST" : ""}`);

  const infos = await conn.getMultipleAccountsInfo(keys.map((k) => k.pk));
  for (let i = 0; i < keys.length; i++) {
    const a = infos[i];
    const sol = a ? a.lamports : 0;
    const owner = a ? a.owner.toBase58() : "missing";
    if (sol > 0) console.log(`SOL ${short(keys[i].pk)} ${sol} owner ${owner} ${keys[i].file}`);
  }

  // Orca configs where a local key is one of the three authorities (8 / 40 / 72)
  const seenCfg = new Set<string>();
  for (const off of [8, 40, 72]) {
    for (const k of keys) {
      let rows: Awaited<ReturnType<typeof conn.getProgramAccounts>> = [];
      try {
        rows = await conn.getProgramAccounts(ORCA, {
          filters: [{ dataSize: 108 }, { memcmp: { offset: off, bytes: k.pk.toBase58() } }],
        });
      } catch (e) {
        console.log(`ORCA_CFG_ERR off ${off} ${short(k.pk)} ${e instanceof Error ? e.message.split("\n")[0] : e}`);
        continue;
      }
      for (const c of rows) {
        if (seenCfg.has(c.pubkey.toBase58())) continue;
        seenCfg.add(c.pubkey.toBase58());
        const d = c.account.data;
        console.log(`ORCA_CFG ${c.pubkey.toBase58()} fee=${short(pkAt(d, 8))} collect=${short(pkAt(d, 40))} reward=${short(pkAt(d, 72))} via ${short(k.pk)}@${off}`);
      }
    }
  }
  console.log(`orca configs matched ${seenCfg.size}`);

  // DBC configs where a local key is fee_claimer (40) or leftover_receiver (72)
  for (const off of [40, 72]) {
    for (const k of keys) {
      const rows = await conn.getProgramAccounts(DBC, {
        filters: [{ memcmp: { offset: off, bytes: k.pk.toBase58() } }],
        dataSlice: { offset: 0, length: 8 },
      });
      if (rows.length) console.log(`DBC off ${off} ${short(k.pk)} n=${rows.length} ${rows.slice(0, 8).map((r) => r.pubkey.toBase58()).join(" ")}`);
    }
  }

  // Pump + PumpSwap creator-vault token accounts
  for (const k of keys) {
    const pumpVault = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), k.pk.toBuffer()], PUMP)[0];
    const ammVault = PublicKey.findProgramAddressSync([Buffer.from("creator_vault"), k.pk.toBuffer()], PUMPSWAP)[0];
    for (const [label, owner] of [["pump", pumpVault], ["amm", ammVault]] as const) {
      for (const prog of [TOKEN, TOKEN22]) {
        const tas = await conn.getParsedTokenAccountsByOwner(owner, { programId: prog });
        for (const t of tas.value) {
          const amt = BigInt(t.account.data.parsed.info.tokenAmount.amount);
          if (amt > 0n) console.log(`PUMPFEE ${label} ${short(k.pk)} mint ${t.account.data.parsed.info.mint} amt ${amt}`);
        }
      }
    }
  }

  // LaunchLab platform (admin = key) and creator fee vaults for WSOL/USDC/$100XBRO
  for (const k of keys) {
    const plat = getPdaPlatformId(LAUNCHPAD_PROGRAM, k.pk).publicKey;
    const info = await conn.getAccountInfo(plat);
    if (info) console.log(`LAUNCH_PLATFORM ${short(k.pk)} platform ${plat.toBase58()} len ${info.data.length} lamports ${info.lamports}`);
    for (const mint of QUOTES) {
      const vault = getPdaCreatorVault(LAUNCHPAD_PROGRAM, k.pk, mint).publicKey;
      const v = await conn.getAccountInfo(vault);
      if (v && v.data.length >= 72) {
        const amt = u64(v.data, 64);
        if (amt > 0n) console.log(`LAUNCH_CREATOR ${short(k.pk)} mint ${mint.toBase58()} vault ${vault.toBase58()} amt ${amt}`);
      }
      if (info) {
        const pv = getPdaPlatformVault(LAUNCHPAD_PROGRAM, plat, mint).publicKey;
        const pinfo = await conn.getAccountInfo(pv);
        if (pinfo && pinfo.data.length >= 72) {
          const amt = u64(pinfo.data, 64);
          if (amt > 0n) console.log(`LAUNCH_PLAT_VAULT ${short(k.pk)} mint ${mint.toBase58()} amt ${amt}`);
        }
      }
    }
  }

  // Wallet token accounts (nonzero)
  for (const k of keys) {
    if (k.pk.equals(DEST)) continue;
    for (const prog of [TOKEN, TOKEN22]) {
      const tas = await conn.getParsedTokenAccountsByOwner(k.pk, { programId: prog });
      for (const t of tas.value) {
        const info = t.account.data.parsed.info;
        const amt = BigInt(info.tokenAmount.amount);
        if (amt > 0n) console.log(`TOK ${short(k.pk)} ${info.mint} amt ${amt} dec ${info.tokenAmount.decimals} acct ${t.pubkey.toBase58()}`);
      }
    }
  }

  // Meteora DLMM positions owned by a local key (owner at offset 40)
  for (const k of keys) {
    const rows = await conn.getProgramAccounts(LB, {
      filters: [{ dataSize: 8120 }, { memcmp: { offset: 40, bytes: k.pk.toBase58() } }],
      dataSlice: { offset: 72, length: 16 },
    });
    for (const r of rows) {
      const liq = r.account.data.readBigUInt64LE(0) + (r.account.data.readBigUInt64LE(8) << 64n);
      console.log(`DLMM ${short(k.pk)} pos ${r.pubkey.toBase58()} liqWord ${liq}`);
    }
  }

  // Orca / Raydium position NFTs held by the keys
  for (const k of keys) {
    for (const prog of [TOKEN, TOKEN22]) {
      const tas = await conn.getParsedTokenAccountsByOwner(k.pk, { programId: prog });
      const nfts = tas.value.filter((t) => {
        const info = t.account.data.parsed.info;
        return info.tokenAmount.decimals === 0 && info.tokenAmount.amount === "1";
      });
      if (!nfts.length) continue;
      const mints = nfts.map((t) => new PublicKey(t.account.data.parsed.info.mint));
      const orcaPos = mints.map((m) => PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer()], ORCA)[0]);
      const rayPos = mints.map((m) => PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer()], RAY)[0]);
      const [oa, ra] = await Promise.all([conn.getMultipleAccountsInfo(orcaPos), conn.getMultipleAccountsInfo(rayPos)]);
      for (let i = 0; i < mints.length; i++) {
        const o = oa[i];
        if (o && o.owner.equals(ORCA) && o.data.length >= 88) {
          const liq = o.data.readBigUInt64LE(72) + (o.data.readBigUInt64LE(80) << 64n);
          console.log(`ORCA_POS ${short(k.pk)} pos ${orcaPos[i].toBase58()} mint ${short(mints[i])} liq ${liq} pool ${pkAt(o.data, 8).toBase58()}`);
        }
        const r = ra[i];
        if (r && r.owner.equals(RAY)) console.log(`RAY_POS ${short(k.pk)} pos ${rayPos[i].toBase58()} mint ${short(mints[i])} len ${r.data.length}`);
      }
    }
  }
  console.log("SCAN_DONE");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
