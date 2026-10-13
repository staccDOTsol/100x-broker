#!/usr/bin/env bash
# Upgrades the hooked program on mainnet with the memecoin CA baked in, then creates the burn pot.
#   HOOKED_MEME_MINT=<CA> scripts/deploy-mainnet.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${HOOKED_MEME_MINT:?set HOOKED_MEME_MINT=<memecoin CA>}"
RPC="${RPC:-https://mainnet.helius-rpc.com/?api-key=REDACTED}"
PAYER="${PAYER:-$HOME/hooked.json}"
PROGRAM=T8EKHG9mJhwWNAYWisFKvbYynGMvSHP5Fb7kxSDh7cb

echo "building with MEME_MINT=$HOOKED_MEME_MINT"
HOOKED_MEME_MINT="$HOOKED_MEME_MINT" cargo build-sbf --manifest-path programs/hooked/Cargo.toml --force-tools-install=false >/dev/null 2>&1 || HOOKED_MEME_MINT="$HOOKED_MEME_MINT" cargo build-sbf --manifest-path programs/hooked/Cargo.toml
NEW=$(stat -f %z target/deploy/hooked.so)
CUR=$(solana -u "$RPC" program show "$PROGRAM" | awk '/Data Length/{print $3}')
echo "binary $NEW bytes, on-chain capacity $CUR, payer $(solana -u "$RPC" balance -k "$PAYER")"
if [ "$NEW" -gt "$CUR" ]; then
  EXTRA=$(( NEW - CUR + 4096 ))
  # ExtendProgram refuses anything under 10240 bytes
  [ "$EXTRA" -lt 10240 ] && EXTRA=10240
  echo "extending program data by $EXTRA bytes"
  solana -u "$RPC" program extend "$PROGRAM" "$EXTRA" -k "$PAYER"
fi
solana program deploy target/deploy/hooked.so --program-id "$PROGRAM" -k "$PAYER" -u "$RPC" --use-rpc --max-sign-attempts 60 --with-compute-unit-price 50000
solana -u "$RPC" program show "$PROGRAM"
echo "creating burn pot (idempotent)"
( cd scripts && RPC="$RPC" PAYER="$PAYER" bun init-burn.ts )
echo "done. now: cd app && vercel deploy --prod --yes"
