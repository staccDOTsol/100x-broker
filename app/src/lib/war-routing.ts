/** The API fields that define a game's quote asset, options, and current clock. */
export type WarRoutingGame = {
  id: number;
  asset: { mint: string | null };
  roundSecs: number;
  antiSnipeSecs: number;
  antiSnipeExtendSecs: number;
  minBid: { raw: string };
  lastBid?: { raw: string };
  minNext?: { raw: string };
  pct: { winner: number; dev: number; creator: number; referrer: number };
  deadline: number;
  over: boolean;
};

export const WAR_SPAWN_CHANCE = 0.25;
export const WAR_SPAWN_WINDOW_SECS = 120;

const U64_MAX = (1n << 64n) - 1n;

function validateWarTokenDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Token decimals must be a whole number from 0 to 255.");
  }
}

/** Format raw token units exactly, including aggregate amounts above u64. */
export function formatWarTokenAmount(raw: bigint, decimals: number): string {
  validateWarTokenDecimals(decimals);
  if (typeof raw !== "bigint" || raw < 0n) throw new Error("The raw token amount must be a non-negative integer.");
  if (decimals === 0) return raw.toString();
  const digits = raw.toString().padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${digits.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}

/** Parse human token units without floating-point rounding or excess precision. */
export function parseWarTokenAmount(value: string, decimals: number): bigint {
  validateWarTokenDecimals(decimals);
  const input = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(input)) {
    throw new Error("Enter an amount using digits and a decimal point only.");
  }
  const [whole = "", fraction = ""] = input.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Use at most ${decimals} decimal places for this token.`);
  }
  const raw = BigInt(whole || "0") * (10n ** BigInt(decimals))
    + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (raw === 0n) throw new Error("Enter an amount greater than zero.");
  if (raw > U64_MAX) throw new Error(`Amount must be no greater than ${formatWarTokenAmount(U64_MAX, decimals)}.`);
  return raw;
}

/** Games in the same set share one asset and every game option. SOL uses null. */
export function sameWarSet(a: WarRoutingGame, b: WarRoutingGame): boolean {
  return a.asset.mint === b.asset.mint
    && a.roundSecs === b.roundSecs
    && a.antiSnipeSecs === b.antiSnipeSecs
    && a.antiSnipeExtendSecs === b.antiSnipeExtendSecs
    && a.minBid.raw === b.minBid.raw
    && a.pct.winner === b.pct.winner
    && a.pct.dev === b.pct.dev
    && a.pct.creator === b.pct.creator
    && a.pct.referrer === b.pct.referrer;
}

export function matchingWarGames<T extends WarRoutingGame>(games: readonly T[], template: WarRoutingGame): T[] {
  return games.filter((game) => sameWarSet(game, template));
}

/** Quote-wide routing groups every game using the same asset, regardless of rules. */
export function matchingQuoteWarGames<T extends WarRoutingGame>(games: readonly T[], template: WarRoutingGame): T[] {
  return games.filter((game) => game.asset.mint === template.asset.mint);
}

const clockRank = (game: WarRoutingGame, now: number): number =>
  game.over ? 3 : game.deadline === 0 ? 1 : game.deadline > now ? 0 : 2;

/** Recompute with the current time: running clocks first, then waiting, expired, settled. */
export function compareWarGames(a: WarRoutingGame, b: WarRoutingGame, now: number): number {
  const aRank = clockRank(a, now), bRank = clockRank(b, now);
  if (aRank !== bRank) return aRank - bRank;
  if (aRank === 0) return a.deadline - b.deadline || a.id - b.id;
  if (aRank === 1) return a.id - b.id;
  // Show the most recently completed games first after every playable game.
  return b.deadline - a.deadline || b.id - a.id;
}

/** Return a new display list; pots and cached phase labels never affect priority. */
export function sortWarGames<T extends WarRoutingGame>(games: readonly T[], now: number): T[] {
  return [...games].sort((a, b) => compareWarGames(a, b, now));
}

/** The exact current amount required to place a bid, in raw quote units. */
export function effectiveWarMinBid(game: WarRoutingGame): bigint {
  return [BigInt(game.minBid.raw), BigInt(game.lastBid?.raw ?? "0") + 1n, BigInt(game.minNext?.raw ?? "0")]
    .reduce((highest, value) => value > highest ? value : highest, 0n);
}

/** Compare games within one quote by the lowest next required bid; clocks break ties. */
export function compareQuoteWarGames(a: WarRoutingGame, b: WarRoutingGame, now: number): number {
  const aPlayable = !a.over && (a.deadline === 0 || a.deadline > now);
  const bPlayable = !b.over && (b.deadline === 0 || b.deadline > now);
  if (aPlayable !== bPlayable) return aPlayable ? -1 : 1;
  if (aPlayable) {
    const aMinimum = effectiveWarMinBid(a), bMinimum = effectiveWarMinBid(b);
    if (aMinimum !== bMinimum) return aMinimum < bMinimum ? -1 : 1;
  }
  return compareWarGames(a, b, now);
}

/** Return a new quote-wide list with the cheapest playable game first. */
export function sortQuoteWarGames<T extends WarRoutingGame>(games: readonly T[], now: number): T[] {
  return [...games].sort((a, b) => compareQuoteWarGames(a, b, now));
}

export type WarTarget<T extends WarRoutingGame> = {
  game: T;
  op: "bid" | "fork" | "next";
  spawnEligible: boolean;
};

/**
 * Route one play within the template's shared quote. Pass a random roll only when
 * playing; omitting it gives a stable preview and never creates a new game.
 * An unstarted game has no clock, so it neither satisfies nor blocks the roll.
 */
export function chooseWarTarget<T extends WarRoutingGame>(
  games: readonly T[],
  template: T,
  now: number,
  randomValue?: number,
): WarTarget<T> {
  // Include a directly linked game when it has not reached the list endpoint yet.
  // If the list already has it, prefer that copy's refreshed clock/state.
  const available = games.some((game) => game.id === template.id) ? games : [...games, template];
  const matching = sortWarGames(matchingWarGames(available, template), now);
  const running = matching.filter((game) => !game.over && game.deadline > now && game.deadline !== 0);
  const spawnEligible = running.length > 0 && running.every((game) => game.deadline - now > WAR_SPAWN_WINDOW_SECS);
  if (spawnEligible && randomValue !== undefined && randomValue >= 0 && randomValue < WAR_SPAWN_CHANCE) {
    return { game: template, op: "fork", spawnEligible };
  }
  const target = running[0] ?? matching.find((game) => !game.over && game.deadline === 0);
  if (target) return { game: target, op: "bid", spawnEligible };
  return { game: template, op: "next", spawnEligible };
}

/**
 * Route to the lowest next required bid across running and waiting quote games.
 * Every running quote clock participates in the spawn condition; a fork copies
 * the selected cheapest game's exact options.
 */
export function chooseQuoteWarTarget<T extends WarRoutingGame>(
  games: readonly T[],
  template: T,
  now: number,
  randomValue?: number,
): WarTarget<T> {
  const available = games.some((game) => game.id === template.id) ? games : [...games, template];
  const matching = sortQuoteWarGames(matchingQuoteWarGames(available, template), now);
  const running = matching.filter((game) => !game.over && game.deadline > now && game.deadline !== 0);
  const spawnEligible = running.length > 0 && running.every((game) => game.deadline - now > WAR_SPAWN_WINDOW_SECS);
  const target = matching.find((game) => !game.over && (game.deadline === 0 || game.deadline > now));
  if (target && spawnEligible && randomValue !== undefined && randomValue >= 0 && randomValue < WAR_SPAWN_CHANCE) {
    return { game: target, op: "fork", spawnEligible };
  }
  if (target) return { game: target, op: "bid", spawnEligible };
  return { game: template, op: "next", spawnEligible };
}

export type WarBidPlanningGame = WarRoutingGame & {
  bids: number;
  lastBid: { raw: string };
  minNext?: { raw: string };
};

/**
 * `from` refers to the zero-based earlier move that created the target game.
 * A fork pays two opening bids: amount and amount + 1 atom.
 */
export type WarBidMove = {
  op: "bid" | "fork" | "next";
  amount: string;
} & ({ g: number; from?: never } | { from: number; g?: never });

type ProjectedGame = WarBidPlanningGame & { from?: number };

/**
 * Plan requested plays with an independent roll for each play. Each fork includes
 * its mandatory second paid opening bid, which starts the new game's clock.
 * All paid amounts stay contiguous: base, base + 1 atom, ... across every play.
 * Projected copies keep the caller's polled game data unchanged.
 */
export function planWarBids<T extends WarBidPlanningGame>(
  games: readonly T[],
  template: T,
  now: number,
  count: number,
  firstAmount: bigint,
  random: () => number = Math.random,
  firstOp?: "next",
  scope: "set" | "quote" = "set",
): WarBidMove[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error("Choose a whole number of plays from 1 to 20.");
  if (firstAmount < 1n || firstAmount + BigInt(count - 1) > U64_MAX) throw new Error("The bid amounts must fit within the token's raw amount range.");
  const source = games.some((game) => game.id === template.id) ? games : [...games, template];
  const matching = scope === "quote" ? matchingQuoteWarGames(source, template) : matchingWarGames(source, template);
  const projected: ProjectedGame[] = matching.filter((game) => game.id >= 0).map((game) => ({
    ...game,
    lastBid: { ...game.lastBid },
    minNext: game.minNext ? { ...game.minNext } : undefined,
  }));
  let projectedTemplate: ProjectedGame = projected.find((game) => game.id === template.id) ?? { ...template };
  if (template.id < 0 && projected.length > 0 && !firstOp) projectedTemplate = (scope === "quote" ? sortQuoteWarGames : sortWarGames)(projected, now)[0];
  let virtualId = Math.max(template.id, ...projected.map((game) => game.id)) + 1;
  const moves: WarBidMove[] = [];
  let amount = firstAmount;

  for (let index = 0; index < count; index++) {
    const roll = random();
    const selected: WarTarget<ProjectedGame> = index === 0 && (firstOp || projectedTemplate.id < 0)
      ? { game: projectedTemplate, op: "next", spawnEligible: false }
      : (scope === "quote" ? chooseQuoteWarTarget : chooseWarTarget)(projected, projectedTemplate, now, roll);
    const paidBids = selected.op === "fork" ? 2 : 1;
    if (amount + BigInt(paidBids - 1) > U64_MAX) throw new Error("The bid amounts must fit within the token's raw amount range.");
    const reference = selected.game.from === undefined ? { g: selected.game.id } : { from: selected.game.from };
    const move: WarBidMove = { ...reference, op: selected.op, amount: amount.toString() };
    let target = selected.game;
    if (move.op !== "bid") {
      target = {
        ...selected.game,
        id: virtualId++,
        from: index,
        deadline: 0,
        over: false,
        bids: 0,
        lastBid: { raw: "0" },
        minNext: undefined,
      };
      projected.push(target);
      // An uncreated quote uses id -1. Subsequent creations clone the game from
      // this earlier move, whose actual on-chain id the API will resolve.
      if (projectedTemplate.id < 0) projectedTemplate = target;
    }
    const minimum = effectiveWarMinBid(target);
    if (amount < minimum) {
      throw new Error(`Bid ${index + 1} needs at least ${minimum} raw units for its selected game. Increase the first bid amount.`);
    }
    moves.push(move);
    for (let paidIndex = 0; paidIndex < paidBids; paidIndex++) {
      const paidAmount = amount + BigInt(paidIndex);
      target.bids += 1;
      target.lastBid = { raw: paidAmount.toString() };
      target.minNext = { raw: (paidAmount + 1n).toString() };
      if (target.deadline === 0 && target.bids >= 2) target.deadline = now + target.roundSecs;
      // Verified against the deployed program with unsigned simulations: the
      // threshold is inclusive and the extension adds to the existing deadline.
      else if (target.deadline > now && target.deadline - now <= target.antiSnipeSecs) target.deadline += target.antiSnipeExtendSecs;
    }
    amount += BigInt(paidBids);
  }
  return moves;
}

/** Exact paid bid count and amount for a prepared plan, including both fork openers. */
export function warPlanTotals(moves: readonly { op: WarBidMove["op"] | "start"; amount: string }[]): {
  plays: number;
  bids: number;
  total: bigint;
  lastAmount: bigint;
} {
  let bids = 0, total = 0n, lastAmount = 0n;
  for (const move of moves) {
    const amount = BigInt(move.amount);
    const fork = move.op === "fork";
    bids += fork ? 2 : 1;
    total += amount + (fork ? amount + 1n : 0n);
    lastAmount = amount + (fork ? 1n : 0n);
  }
  return { plays: moves.length, bids, total, lastAmount };
}
