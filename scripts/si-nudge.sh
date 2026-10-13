#!/bin/bash
# Waits until the SI market's 66-min window has moved past the pool ring's first point (01:32:48 UTC + 3960 s), then makes one
# dust swap (fresh ring end point) and one poke (recompute TWAP) so the oracle reads the real tick and the vault can deploy.
export RPC="https://mainnet.helius-rpc.com/?api-key=REDACTED" PAYER=$HOME/hooked.json
target=$(( $(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "2026-10-11T02:40:30Z" +%s) ))
now=$(date +%s)
[ $now -lt $target ] && sleep $(( target - now ))
cd /Users/stacc/hooked/scripts
LAMPORTS=1500000 bun si-kick.ts 2>&1 | grep "swap" | tail -2
sleep 8
bun _poke.ts 2>&1 | grep -v node_modules | grep -A2 "before\|after" | tr '\n' ' '
echo
sleep 40
fly logs -a hundredx-keeper --no-tail 2>/dev/null | grep "68NpjK" | tail -4 | cut -c1-200
