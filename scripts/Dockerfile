FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY lib.ts stakepool.ts alt.ts keeper.ts sweep.ts start.sh ./
COPY dn/lib.ts dn/ops.ts dn/clmm-math.ts dn/keeper.ts ./dn/
CMD ["sh", "start.sh"]
