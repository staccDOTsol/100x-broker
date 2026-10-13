#!/bin/bash
# Runs both keepers in one Fly machine: the 100x chores/burn keeper and the dnvault keeper. If either dies, the machine restarts.
bun keeper.ts &
bun dn/keeper.ts &
wait -n
exit 1
