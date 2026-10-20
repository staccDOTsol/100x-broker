// Read-only incremental rent/ALT estimate for the USDC/SOL replacement sibling.
import fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { marketAccounts, listAlts } from "./alt";
import { sideAccounts, type Market } from "./lib";
import { vaultAtas, solPda, sharesPda } from "./dn/lib";

const directory = "/Users/stacc/tmp/mainnet-salvage-2026-10-20";
const conn = new Connection(process.env.RPC!, "confirmed");
const plan = JSON.parse(fs.readFileSync(`${directory}/hooked-restoration-markets.json`, "utf8"));
const usdc = plan.markets.find((m: any) => m.symbol === "USDC");
const sol = plan.markets.find((m: any) => m.symbol === "SOL");
const asMarket = (p: any): Market => ({ key: new PublicKey(p.market), bullMint: new PublicKey(p.bullMint), bearMint: new PublicKey(p.bearMint), config: new PublicKey(p.config), oraclePool: new PublicKey(p.pool), oracleObs: new PublicKey(p.oracleObs), windowSecs: p.windowSecs, underlyingIsToken0: p.underlyingIsToken0 });
const old = asMarket(sol), next = asMarket(usdc);
const rentCache = new Map<number, number>();
const rent = async (size: number) => { if (!rentCache.has(size)) rentCache.set(size, await conn.getMinimumBalanceForRentExemption(size)); return rentCache.get(size)!; };
const das = await (await fetch(process.env.RPC!, { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({jsonrpc:"2.0",id:1,method:"getAsset",params:{id:usdc.underlying}}) })).json() as any;
if (!das.result) throw new Error("DAS metadata unavailable");
const symbol = String(das.result.content?.metadata?.symbol ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0,7) || "TOKEN";
const name = String(das.result.content?.metadata?.name ?? symbol).trim().slice(0,20) || symbol;
const existing = marketAccounts(old).filter(k => !k.equals(old.oraclePool) && !k.equals(old.oracleObs));
const infos = await conn.getMultipleAccountsInfo(existing);
const marketRows = [];
for (let i=0;i<existing.length;i++) {
  if (!infos[i]) throw new Error("Template market account missing");
  let size = infos[i]!.data.length;
  const side = existing[i].equals(old.bullMint) ? 0 : existing[i].equals(old.bearMint) ? 1 : null;
  if (side !== null) {
    const metadata = await getTokenMetadata(conn, existing[i], "confirmed", TOKEN_2022_PROGRAM_ID);
    if (!metadata) throw new Error("Template mint metadata missing");
    const fields = [`${name} 100x ${side === 0 ? "UP" : "DOWN"}`, `${symbol}${side === 0 ? "UP" : "DN"}`, `https://100x.broker/api/meta?mint=${usdc.underlying}&s=${side === 0 ? "up" : "down"}`];
    size += fields.reduce((a,b)=>a+Buffer.byteLength(b),0) - [metadata.name,metadata.symbol,metadata.uri].reduce((a,b)=>a+Buffer.byteLength(b),0);
  }
  marketRows.push({template:existing[i].toBase58(),size,rent:await rent(size)});
}
const marketRent = marketRows.reduce((a,b)=>a+b.rent,0);
const dnSizes=[488,82,0,165,165,165,175];
const dnRent=(await Promise.all(dnSizes.map(rent))).reduce((a,b)=>a+b,0);
const vault=new PublicKey(usdc.dn.vault), x=new PublicKey(usdc.underlying), atas=vaultAtas(vault,x,next.bearMint,false), down=sideAccounts(next,1);
const pool=(await conn.getAccountInfo(next.oraclePool))!.data;
const dnWanted=[vault,solPda(vault),sharesPda(vault),atas.wsol,atas.x,atas.quote,atas.down,next.key,next.oraclePool,x,next.bearMint,down.vault,down.baseVault,down.pool,new PublicKey(pool.subarray(137,169)),new PublicKey(pool.subarray(169,201)),next.oracleObs];
const tables=await listAlts(conn); const have=new Set(tables.flatMap(t=>t.state.addresses.map(k=>k.toBase58())));
const dedupe=(a:PublicKey[])=>[...new Map(a.map(k=>[k.toBase58(),k])).values()];
const dnMissing=dedupe(dnWanted).filter(k=>!have.has(k.toBase58()));
dnMissing.forEach(k=>have.add(k.toBase58()));
const marketMissing=dedupe(marketAccounts(next)).filter(k=>!have.has(k.toBase58()));
const free=tables.reduce((a,t)=>a+256-t.state.addresses.length,0);
if(free<dnMissing.length+marketMissing.length) throw new Error("A new ALT is needed; estimate its create/extend separately");
const bytes=32*(dnMissing.length+marketMissing.length);
const altRent=(await rent(56+bytes))-(await rent(56));
// Each phase starts with a separate ensureAlts call; account for boundaries of existing tables too.
const rooms=tables.map(t=>256-t.state.addresses.length);
const chunks=(n:number)=>{let count=0;for(let i=0;i<rooms.length&&n;i++){while(rooms[i]>0&&n){const k=Math.min(20,rooms[i],n);rooms[i]-=k;n-=k;count++;}}return count;};
const altTransactions=chunks(dnMissing.length)+chunks(marketMissing.length);
const marketFees=7*5000, dnFees=2*5000, altFees=altTransactions*5000;
const report={checkedAt:new Date().toISOString(),symbol,name,market:usdc.market,dnVault:usdc.dn.vault,marketRentLamports:marketRent,marketSignatureFeesLamports:marketFees,marketTotalLamports:marketRent+marketFees,dnRentLamports:dnRent,dnSignatureFeesLamports:dnFees,dnTotalLamports:dnRent+dnFees,alt:{tables:tables.map(t=>({key:t.key.toBase58(),addresses:t.state.addresses.length})),dnMissing:dnMissing.length,marketMissing:marketMissing.length,rentLamports:altRent,transactions:altTransactions,feesLamports:altFees,totalLamports:altRent+altFees},totalLamports:marketRent+marketFees+dnRent+dnFees+altRent+altFees,marketRows,dnSizes,noLiquidityOrSwaps:true};
fs.writeFileSync(`${directory}/hooked-usdc-cost.json`,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
