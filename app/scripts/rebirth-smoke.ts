// Unsigned mainnet simulations only. No private keys, submission or investment capital.
import assert from "node:assert/strict";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { conn, dbc, loadMarketView, toV0 } from "../src/lib/chain.js";
import { claimFeesIx, cu, redeemIx, sideAccounts } from "../src/lib/hooked.js";
import { curveQuote } from "../src/lib/exit.js";
import { depositOut, depositSolIx, poolState } from "../src/lib/zap.js";
import { assertTransactionDeployment } from "../src/lib/deployment.js";
import { PROGRAM_ID, RFSTACC } from "../src/config.js";

const owner = new PublicKey("331nEBz4i3XjyaUHVyHnpw9xBoW7D6P1qMPnUPd76Mth");
const quoteAta = getAssociatedTokenAddressSync(RFSTACC, owner);
const pool = await poolState();
const solAmount = 100000n;
for (const address of process.argv.slice(2)) {
  const v = await loadMarketView(new PublicKey(address));
  assert(v, "fresh market must load");
  for (const side of [0, 1] as const) {
    const a = sideAccounts(v.keys, side);
    const amount = depositOut(pool, solAmount);
    const q = await curveQuote(v, side, amount, false);
    const buy = await dbc.pool.swap2WithTransferHook({owner,payer:owner,pool:a.pool,swapBaseForQuote:false,referralTokenAccount:null,swapMode:SwapMode.ExactIn,amountIn:new BN(amount.toString()),minimumAmountOut:new BN(q.min.toString())});
    const base = [cu(1200000),createAssociatedTokenAccountIdempotentInstruction(owner,quoteAta,owner,RFSTACC),depositSolIx(pool,owner,quoteAta,solAmount,quoteAta),...buy.instructions,claimFeesIx(v.keys,side)];
    for (const mode of ["buy", "buy-sell", "buy-redeem"] as const) {
      const ixs = [...base];
      if (mode === "buy-sell") {
        const sell = await dbc.pool.swap2WithTransferHook({owner,payer:owner,pool:a.pool,swapBaseForQuote:true,referralTokenAccount:null,swapMode:SwapMode.ExactIn,amountIn:new BN((q.min/2n).toString()),minimumAmountOut:new BN(1)});
        ixs.push(...sell.instructions);
      } else if (mode === "buy-redeem") {
        // The preceding simulated buy creates circulating supply; the pre-transaction view is empty.
        ixs.push(redeemIx(v.keys,owner,side,q.min/2n));
      }
      const tx = await toV0(ixs,owner);
      assert(tx.signatures.every(s=>s.every(b=>b===0)),"no signatures");
      await assertTransactionDeployment(conn,tx);
      const sim = await conn.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true});
      const hookInvoked = (sim.value.logs??[]).some(line=>line.includes(`Program ${PROGRAM_ID.toBase58()} invoke`));
      console.log(JSON.stringify({market:address,side,mode,slot:sim.context.slot,error:sim.value.err,hookInvoked,bytes:tx.serialize().length,units:sim.value.unitsConsumed,logs:sim.value.err?sim.value.logs:undefined}));
      assert.equal(sim.value.err,null);
      assert(hookInvoked,"hooked program invoked");
    }
  }
}
