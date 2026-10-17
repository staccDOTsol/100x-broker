#!/bin/bash
# Runs the keepers in one Fly machine: the 100x chores/burn keeper and the dnvault keeper. If either dies, the machine restarts.
bun keeper.ts &
bun dn/keeper.ts &
# Wrapped-twin liquidity: recycles the dev cut (r-freestacc) into Orca bids and re-adds LP fees. Only when its key is set.
if [ -n "$FACTORY_KEY" ]; then bun wrapfactory.ts recycle --loop & fi
wait -n
exit 1
