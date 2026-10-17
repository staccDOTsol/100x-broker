#!/usr/bin/env bash
# Bring up the walkthrough stack: mainnet proxy (:8877) -> fresh surfpool fork (:8899) -> fork-mode site (:5180).
# Then: bun tour.ts [scene,...]   (FAST=1 for a dry run)   and   bun cut.ts   for the MP4s.
# down: pkill -f "bun rpcproxy.ts"; pkill -f "surfpool start --rpc-url http://127.0.0.1:8877"; pkill -f "bun serve.ts"
set -euo pipefail
cd "$(dirname "$0")"

pkill -f "bun rpcproxy.ts" || true
pkill -f "surfpool start --rpc-url http://127.0.0.1:8877" || true
pkill -f "bun serve.ts" || true
sleep 1

nohup bun rpcproxy.ts > rpcproxy.log 2>&1 &
sleep 1
nohup surfpool start --rpc-url http://127.0.0.1:8877 --no-tui --no-studio --no-deploy --disable-instruction-profiling \
  --port 8899 --ws-port 18900 --studio-port 18489 --skip-blockhash-check -y > surfpool.log 2>&1 &
until curl -s -m 2 -X POST localhost:8899 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' | grep -q result; do sleep 1; done

if [ "${BUILD:-0}" = 1 ] || [ ! -f site/index.html ]; then
  (cd ../app && VITE_NETWORK=fork bunx vite build --outDir ../walkthrough/site --emptyOutDir)
fi
nohup bun serve.ts > serve.log 2>&1 &
sleep 1
echo "fork :8899, site http://localhost:5180"
