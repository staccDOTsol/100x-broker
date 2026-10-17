import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseQuoteWarTarget,
  chooseWarTarget,
  effectiveWarMinBid,
  formatWarTokenAmount,
  matchingWarGames,
  matchingQuoteWarGames,
  parseWarTokenAmount,
  planWarBids,
  sameWarSet,
  sortWarGames,
  sortQuoteWarGames,
  warPlanTotals,
  type WarRoutingGame,
  type WarBidPlanningGame,
} from "../src/lib/war-routing.ts";

test("human token amounts preserve SOL's full nine decimal places", () => {
  assert.equal(parseWarTokenAmount("0.000000001", 9), 1n);
  assert.equal(parseWarTokenAmount("  .1  ", 9), 100_000_000n);
  assert.equal(parseWarTokenAmount("1.", 9), 1_000_000_000n);
  assert.equal(parseWarTokenAmount("0001.234567890", 9), 1_234_567_890n);
  assert.equal(formatWarTokenAmount(1n, 9), "0.000000001");
  assert.equal(formatWarTokenAmount(1_234_567_890n, 9), "1.23456789");
});

test("token amounts use each mint's precision, including zero and eighteen decimals", () => {
  assert.equal(parseWarTokenAmount("12.345678", 6), 12_345_678n);
  assert.equal(parseWarTokenAmount("12", 0), 12n);
  assert.equal(parseWarTokenAmount("12.", 0), 12n);
  assert.equal(formatWarTokenAmount(12n, 0), "12");
  const aboveNumberPrecision = 1_000_000_000_000_000_001n;
  assert.equal(parseWarTokenAmount("1.000000000000000001", 18), aboveNumberPrecision);
  assert.equal(formatWarTokenAmount(aboveNumberPrecision, 18), "1.000000000000000001");
  assert.equal(parseWarTokenAmount("0.000000000000000001", 18), 1n);
});

test("token parsing accepts the exact u64 maximum and rejects one atom more", () => {
  const max = (1n << 64n) - 1n;
  for (const [decimals, maximum, overflow] of [
    [0, "18446744073709551615", "18446744073709551616"],
    [9, "18446744073.709551615", "18446744073.709551616"],
    [18, "18.446744073709551615", "18.446744073709551616"],
  ] as const) {
    assert.equal(parseWarTokenAmount(maximum, decimals), max);
    assert.equal(formatWarTokenAmount(max, decimals), maximum);
    assert.throws(() => parseWarTokenAmount(overflow, decimals), /no greater than/);
  }
});

test("excess token precision is rejected even for trailing zeroes", () => {
  for (const [value, decimals] of [["0.0000000001", 9], ["1.0000000", 6], ["1.0", 0]] as const) {
    assert.throws(() => parseWarTokenAmount(value, decimals), new RegExp(`at most ${decimals} decimal places`));
  }
});

test("token parsing rejects zero and non-decimal input without coercion", () => {
  for (const value of ["0", "00", "0.000000000", ".0", "0."]) {
    assert.throws(() => parseWarTokenAmount(value, 9), /greater than zero/);
  }
  for (const value of ["", " ", ".", "-1", "+1", "1e-9", "1E3", "1,000", "NaN", "Infinity", "0x10", "1 2", "1.2.3", "1\n2"]) {
    assert.throws(() => parseWarTokenAmount(value, 9), /digits and a decimal point only/);
  }
});

test("decimal metadata is bounded and exact formatting covers zero and large totals", () => {
  for (const decimals of [-1, 0.5, 256, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => parseWarTokenAmount("1", decimals), /whole number from 0 to 255/);
    assert.throws(() => formatWarTokenAmount(1n, decimals), /whole number from 0 to 255/);
  }
  const smallest = `0.${"0".repeat(254)}1`;
  assert.equal(parseWarTokenAmount(smallest, 255), 1n);
  assert.equal(formatWarTokenAmount(1n, 255), smallest);
  assert.equal(formatWarTokenAmount(0n, 9), "0");
  assert.equal(formatWarTokenAmount(1_000_000_000n, 9), "1");
  assert.equal(formatWarTokenAmount(40n * ((1n << 64n) - 1n), 9), "737869762948.3820646");
  assert.throws(() => formatWarTokenAmount(-1n, 9), /non-negative integer/);
});

const NOW = 1_000;
const game = (id: number, changes: Partial<WarRoutingGame> & { pot?: number } = {}): WarRoutingGame & { pot?: number } => ({
  id,
  asset: { mint: null },
  roundSecs: 600,
  antiSnipeSecs: 30,
  antiSnipeExtendSecs: 60,
  minBid: { raw: "1000" },
  pct: { winner: 7000, dev: 500, creator: 1500, referrer: 1000 },
  deadline: NOW + 300,
  over: false,
  ...changes,
});

test("shared quotes match the mint and every game option, regardless of current bid or pot", () => {
  const template = game(1);
  assert.ok(sameWarSet(template, game(2, { deadline: NOW + 20, pot: 1_000_000 })));
  const changes: Partial<WarRoutingGame>[] = [
    { asset: { mint: "other-mint" } },
    { roundSecs: 601 },
    { antiSnipeSecs: 31 },
    { antiSnipeExtendSecs: 61 },
    { minBid: { raw: "1001" } },
    ...(["winner", "dev", "creator", "referrer"] as const).map((key) => ({ pct: { ...template.pct, [key]: template.pct[key] + 1 } })),
  ];
  for (const change of changes) assert.equal(sameWarSet(template, game(2, change)), false);
  const token = game(3, { asset: { mint: "same-mint" } });
  assert.ok(sameWarSet(token, game(4, { asset: { mint: "same-mint" } })));
  assert.deepEqual(matchingWarGames([template, token, game(5)], template).map((g) => g.id), [1, 5]);
});

test("plays prioritize the smallest future deadline even when another game has a larger pot", () => {
  const template = game(1, { pot: 1_000_000 });
  const earliest = game(2, { deadline: NOW + 10, pot: 1 });
  const result = chooseWarTarget([template, earliest, game(3, { deadline: NOW + 5, over: true })], template, NOW, 0);
  assert.equal(result.game, earliest);
  assert.equal(result.op, "bid");
  assert.equal(result.spawnEligible, false);
});

test("only a running clock set strictly above two minutes permits the 25% roll", () => {
  const template = game(1);
  const games = [template, game(2, { deadline: NOW + 121 })];
  for (const roll of [0, 0.1, 0.249999]) {
    const result = chooseWarTarget(games, template, NOW, roll);
    assert.equal(result.op, "fork");
    assert.equal(result.game, template);
    assert.equal(result.spawnEligible, true);
  }
  for (const roll of [0.25, 0.5, 0.999999]) assert.equal(chooseWarTarget(games, template, NOW, roll).op, "bid");
  const boundary = game(2, { deadline: NOW + 120 });
  assert.equal(chooseWarTarget([template, boundary], template, NOW, 0).spawnEligible, false);
  assert.equal(chooseWarTarget([template, boundary], template, NOW, 0).op, "bid");
});

test("polling previews do not roll or fork, and invalid supplied rolls do not fork", () => {
  const template = game(1);
  const earlier = game(2, { deadline: NOW + 200 });
  const result = chooseWarTarget([template, earlier], template, NOW);
  assert.equal(result.game, earlier);
  assert.equal(result.op, "bid");
  assert.equal(result.spawnEligible, true);
  for (const roll of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(chooseWarTarget([template], template, NOW, roll).op, "bid");
  }
});

test("unstarted games have no clock and are the bid fallback when no running clock remains", () => {
  const template = game(1, { deadline: NOW });
  const open = game(2, { deadline: 0 });
  const result = chooseWarTarget([template, open, game(3, { deadline: 0, over: true })], template, NOW, 0);
  assert.equal(result.game, open);
  assert.equal(result.op, "bid");
  assert.equal(result.spawnEligible, false);
  assert.equal(chooseWarTarget([open], open, NOW, 0).op, "bid");
  // An unstarted sibling does not disable the user's condition for running clocks.
  assert.equal(chooseWarTarget([game(4), open], game(4), NOW, 0).op, "fork");
});

test("expired and settled games cannot receive bids; unrelated clocks cannot change a set's roll", () => {
  const template = game(1, { deadline: NOW });
  const done = [template, game(2, { deadline: NOW - 1 }), game(3, { over: true })];
  assert.deepEqual(chooseWarTarget(done, template, NOW, 0), { game: template, op: "next", spawnEligible: false });
  const live = game(4);
  const foreign = game(5, { asset: { mint: "other-mint" }, deadline: NOW + 1 });
  const differentOptions = game(6, { roundSecs: 601, deadline: NOW + 1 });
  assert.equal(chooseWarTarget([live, ...done, foreign, differentOptions], live, NOW, 0).op, "fork");
});

test("display priority updates as time passes, does not mutate input, and uses ids for deadline ties", () => {
  const first = game(1, { deadline: NOW + 1 });
  const second = game(2, { deadline: NOW + 2 });
  const open = game(3, { deadline: 0 });
  const settled = game(4, { over: true });
  const input = [settled, open, second, first];
  assert.deepEqual(sortWarGames(input, NOW).map((g) => g.id), [1, 2, 3, 4]);
  assert.deepEqual(sortWarGames(input, NOW + 1).map((g) => g.id), [2, 3, 1, 4]);
  assert.deepEqual(input.map((g) => g.id), [4, 3, 2, 1]);
  assert.deepEqual(sortWarGames([game(6), game(5)], NOW).map((g) => g.id), [5, 6]);
});

test("a directly linked game is considered, while refreshed listed state wins for the same id", () => {
  const template = game(1);
  assert.equal(chooseWarTarget([], template, NOW).op, "bid");
  const expiredCopy = game(1, { deadline: NOW });
  assert.equal(chooseWarTarget([expiredCopy], template, NOW, 0).op, "next");
});

const planningGame = (id: number, changes: Partial<WarBidPlanningGame> = {}): WarBidPlanningGame => ({
  ...game(id),
  bids: 2,
  lastBid: { raw: "1000" },
  minNext: { raw: "1001" },
  ...changes,
});

test("multibid rolls once per requested play and keeps all paid amounts contiguous across two-bid forks", () => {
  const template = planningGame(1);
  const sibling = planningGame(2, { deadline: NOW + 200 });
  const rolls = [0.1, 0.6, 0.2, 0.25];
  let rollsUsed = 0;
  assert.deepEqual(planWarBids([template, sibling], template, NOW, 4, 1001n, () => rolls[rollsUsed++]), [
    { op: "fork", g: 1, amount: "1001" },
    { op: "bid", g: 2, amount: "1003" },
    { op: "fork", g: 1, amount: "1004" },
    { op: "bid", g: 2, amount: "1006" },
  ]);
  assert.equal(rollsUsed, 4);
  assert.equal(template.lastBid.raw, "1000");
  assert.equal(sibling.lastBid.raw, "1000");
  assert.equal(sibling.bids, 2);
});

test("multibid starts a clock on the second bid, then permits the independent third-bid fork roll", () => {
  const template = planningGame(1, { over: true, deadline: NOW - 1 });
  assert.deepEqual(planWarBids([template], template, NOW, 3, 1000n, () => 0), [
    { op: "next", g: 1, amount: "1000" },
    { op: "bid", from: 0, amount: "1001" },
    { op: "fork", g: 1, amount: "1002" },
  ]);
});

test("an existing one-bid open game starts its clock before the next multibid roll", () => {
  const template = planningGame(1, { bids: 1, deadline: 0 });
  assert.deepEqual(planWarBids([template], template, NOW, 2, 1001n, () => 0), [
    { op: "bid", g: 1, amount: "1001" },
    { op: "fork", g: 1, amount: "1002" },
  ]);
  const shortRound = planningGame(2, { bids: 0, deadline: 0, roundSecs: 120, lastBid: { raw: "0" }, minNext: { raw: "1000" } });
  assert.deepEqual(planWarBids([shortRound], shortRound, NOW, 3, 1000n, () => 0), [
    { op: "bid", g: 2, amount: "1000" },
    { op: "bid", g: 2, amount: "1001" },
    { op: "bid", g: 2, amount: "1002" },
  ]);
});

test("multibid rejects invalid count, overflow, and insufficient amounts without changing the requested base", () => {
  const template = planningGame(1);
  for (const count of [0, -1, 1.5, 21, Number.NaN]) assert.throws(() => planWarBids([template], template, NOW, count, 1001n), /whole number/);
  assert.throws(() => planWarBids([template], template, NOW, 2, (1n << 64n) - 1n), /raw amount range/);
  assert.throws(() => planWarBids([template], template, NOW, 1, 1000n, () => 0.9), /Bid 1 needs at least 1001/);
});

test("multibid never routes to a different quote's clock", () => {
  const template = planningGame(1);
  const foreign = planningGame(2, { deadline: NOW + 1, asset: { mint: "other-mint" } });
  assert.deepEqual(planWarBids([template, foreign], template, NOW, 2, 1001n, () => 0), [
    { op: "fork", g: 1, amount: "1001" },
    { op: "fork", g: 1, amount: "1003" },
  ]);
});

test("anti-snipe adds to the current deadline and reprioritizes the next bid", () => {
  const first = planningGame(1, { deadline: NOW + 20 });
  const second = planningGame(2, { deadline: NOW + 40 });
  assert.deepEqual(planWarBids([first, second], first, NOW, 2, 1001n, () => 0), [
    { op: "bid", g: 1, amount: "1001" },
    { op: "bid", g: 2, amount: "1002" },
  ]);
  // If the extension reset to now + 30, the first game would remain earliest.
  const inclusive = planningGame(3, { deadline: NOW + 60, antiSnipeSecs: 60, antiSnipeExtendSecs: 30 });
  const later = planningGame(4, { deadline: NOW + 80, antiSnipeSecs: 60, antiSnipeExtendSecs: 30 });
  assert.deepEqual(planWarBids([inclusive, later], inclusive, NOW, 2, 1001n, () => 0), [
    { op: "bid", g: 3, amount: "1001" },
    { op: "bid", g: 4, amount: "1002" },
  ]);
});

test("an anti-snipe extension can make the next independent roll eligible", () => {
  const template = planningGame(1, { deadline: NOW + 60, antiSnipeSecs: 60, antiSnipeExtendSecs: 120 });
  assert.deepEqual(planWarBids([template], template, NOW, 2, 1001n, () => 0), [
    { op: "bid", g: 1, amount: "1001" },
    { op: "fork", g: 1, amount: "1002" },
  ]);
});

test("rerouting after an extension reports a higher sibling minimum without altering the sequence", () => {
  const first = planningGame(1, { deadline: NOW + 20 });
  const second = planningGame(2, { deadline: NOW + 40, lastBid: { raw: "2000" }, minNext: { raw: "2001" } });
  assert.throws(() => planWarBids([first, second], first, NOW, 2, 1001n, () => 0), /Bid 2 needs at least 2001/);
});

test("an uncreated quote uses the first creation's move reference on subsequent forks", () => {
  const template = planningGame(-1, { bids: 0, deadline: 0, lastBid: { raw: "0" }, minNext: { raw: "1000" } });
  assert.deepEqual(planWarBids([], template, NOW, 3, 1000n, () => 0, "next"), [
    { op: "next", g: -1, amount: "1000" },
    { op: "bid", from: 0, amount: "1001" },
    { op: "fork", from: 0, amount: "1002" },
  ]);
  const existing = planningGame(4, { deadline: NOW + 200 });
  assert.deepEqual(planWarBids([existing], template, NOW, 2, 1001n, () => 0, "next"), [
    { op: "next", g: -1, amount: "1001" },
    { op: "fork", from: 0, amount: "1002" },
  ]);
});

test("a fork's two paid openers start its clock before the next requested play", () => {
  const template = planningGame(1, { roundSecs: 180 });
  const rolls = [0, 0.9];
  let rollsUsed = 0;
  assert.deepEqual(planWarBids([template], template, NOW, 2, 1001n, () => rolls[rollsUsed++]), [
    { op: "fork", g: 1, amount: "1001" },
    { op: "bid", from: 0, amount: "1003" },
  ]);
  assert.equal(rollsUsed, 2, "the mandatory opener does not consume a roll");
});

test("a new fork clock at or below two minutes prevents another fork until clocks allow it", () => {
  for (const roundSecs of [60, 120]) {
    const template = planningGame(1, { roundSecs });
    assert.deepEqual(planWarBids([template], template, NOW, 3, 1001n, () => 0), [
      { op: "fork", g: 1, amount: "1001" },
      { op: "bid", from: 0, amount: "1003" },
      { op: "bid", from: 0, amount: "1004" },
    ]);
  }
});

test("created-game references use requested move indexes even when forks add paid bids", () => {
  const template = planningGame(1, { roundSecs: 180, antiSnipeSecs: 180, antiSnipeExtendSecs: 600 });
  const rolls = [0, 0, 0.9, 0.9];
  let index = 0;
  assert.deepEqual(planWarBids([template], template, NOW, 4, 1001n, () => rolls[index++]), [
    { op: "fork", g: 1, amount: "1001" },
    { op: "fork", g: 1, amount: "1003" },
    { op: "bid", from: 0, amount: "1005" },
    { op: "bid", from: 1, amount: "1006" },
  ]);
});

test("overflow validation includes every mandatory second fork opener", () => {
  const template = planningGame(1);
  const max = (1n << 64n) - 1n;
  assert.throws(() => planWarBids([template], template, NOW, 1, max, () => 0), /raw amount range/);
  assert.throws(() => planWarBids([template], template, NOW, 2, max - 2n, () => 0), /raw amount range/);
  const plan = planWarBids([template], template, NOW, 1, max - 1n, () => 0);
  assert.deepEqual(warPlanTotals(plan), { plays: 1, bids: 2, total: 2n * max - 1n, lastAmount: max });
});

test("prepared totals include every paid bid while start and next each remain one bid", () => {
  const template = planningGame(1);
  const rolls = [0, 0.9, 0, 0.9];
  let index = 0;
  const plan = planWarBids([template], template, NOW, 4, 1001n, () => rolls[index++]);
  assert.deepEqual(warPlanTotals(plan), { plays: 4, bids: 6, total: 6021n, lastAmount: 1006n });
  assert.deepEqual(warPlanTotals([
    { op: "bid", amount: "2000" },
    { op: "fork", amount: "2001" },
    { op: "next", amount: "2003" },
    { op: "start", amount: "2004" },
  ]), { plays: 4, bids: 5, total: 10010n, lastAmount: 2004n });
  assert.deepEqual(warPlanTotals([]), { plays: 0, bids: 0, total: 0n, lastAmount: 0n });
});

test("quote-wide routing prioritizes the lowest next required bid ahead of a shorter clock", () => {
  const template = planningGame(1);
  const closest = planningGame(2, {
    roundSecs: 180,
    minBid: { raw: "5000" },
    deadline: NOW + 10,
    lastBid: { raw: "5000" },
    minNext: { raw: "5001" },
  });
  const differentAsset = planningGame(3, { asset: { mint: "other-mint" }, deadline: NOW + 1 });
  const games = [template, closest, differentAsset];
  const result = chooseQuoteWarTarget(games, template, NOW, 0);
  assert.equal(result.game, template);
  assert.equal(result.op, "bid");
  assert.equal(result.spawnEligible, false);
  assert.deepEqual(matchingQuoteWarGames(games, template).map((g) => g.id), [1, 2]);
  assert.equal(chooseWarTarget(games, template, NOW, 0).op, "fork", "exact-set routing retains its existing behavior");
});

test("every quote clock forms the two-minute roll barrier regardless of options", () => {
  const template = game(1);
  for (const seconds of [1, 120]) {
    const otherRules = game(2, { deadline: NOW + seconds, minBid: { raw: "5000" }, roundSecs: 180 });
    assert.equal(chooseQuoteWarTarget([template, otherRules], template, NOW, 0).spawnEligible, false);
  }
  const otherRules = game(2, { deadline: NOW + 121, minBid: { raw: "5000" }, roundSecs: 180 });
  const foreignClock = game(3, { deadline: NOW + 1, asset: { mint: "other-mint" } });
  assert.equal(chooseQuoteWarTarget([template, otherRules, foreignClock], template, NOW, 0).op, "fork");
  assert.equal(chooseQuoteWarTarget([template, otherRules], template, NOW, 0.25).op, "bid");
  assert.equal(chooseQuoteWarTarget([template, otherRules], template, NOW).op, "bid", "previews never roll");
});

test("a quote fork selects the cheapest game's exact rules as its source", () => {
  const template = game(1, { minBid: { raw: "9000" } });
  const cheapest = game(2, {
    deadline: NOW + 400,
    roundSecs: 240,
    antiSnipeSecs: 10,
    antiSnipeExtendSecs: 15,
    minBid: { raw: "7000" },
    pct: { winner: 8000, dev: 500, creator: 1000, referrer: 500 },
  });
  assert.deepEqual(chooseQuoteWarTarget([template, cheapest], template, NOW, 0), {
    game: cheapest,
    op: "fork",
    spawnEligible: true,
  });
  const freshCopy = { ...cheapest, deadline: NOW + 5 };
  assert.equal(chooseQuoteWarTarget([template, freshCopy], cheapest, NOW).game, freshCopy);
});

test("quote-wide routing uses open games across rules, then starts next when only closed games remain", () => {
  const template = game(1, { deadline: NOW });
  const open = game(2, { deadline: 0, roundSecs: 180, minBid: { raw: "5000" } });
  assert.deepEqual(chooseQuoteWarTarget([template, open], template, NOW, 0), { game: open, op: "bid", spawnEligible: false });
  assert.deepEqual(chooseQuoteWarTarget([template, { ...open, over: true }], template, NOW, 0), {
    game: template,
    op: "next",
    spawnEligible: false,
  });
});

test("quote-scoped multibid forks the cheapest rules and the new clock affects only roll eligibility", () => {
  const template = planningGame(1, { minBid: { raw: "10000" }, lastBid: { raw: "10000" }, minNext: { raw: "10001" } });
  const cheapest = planningGame(2, { deadline: NOW + 200, roundSecs: 60, minBid: { raw: "5000" }, lastBid: { raw: "5000" }, minNext: { raw: "5001" } });
  assert.deepEqual(planWarBids([template, cheapest], template, NOW, 2, 5000n, () => 0, undefined, "quote"), [
    { op: "fork", g: 2, amount: "5000" },
    { op: "bid", g: 2, amount: "5002" },
  ]);
  assert.throws(() => planWarBids([template, cheapest], template, NOW, 1, 4999n, () => 0, undefined, "quote"), /Bid 1 needs at least 5000/);
  assert.deepEqual(planWarBids([template, cheapest], template, NOW, 1, 10001n, () => 0), [
    { op: "fork", g: 1, amount: "10001" },
  ], "the default scope still uses exact sets");
});

test("quote-scoped multibid recalculates the cheapest current bid after each play and preserves amounts", () => {
  const template = planningGame(1, { deadline: NOW + 20 });
  const otherRules = planningGame(2, { deadline: NOW + 40, roundSecs: 180, minBid: { raw: "1001" } });
  assert.deepEqual(planWarBids([template, otherRules], template, NOW, 2, 1001n, () => 0, undefined, "quote"), [
    { op: "bid", g: 1, amount: "1001" },
    { op: "bid", g: 2, amount: "1002" },
  ]);
  const higherMinimum = { ...otherRules, minBid: { raw: "5000" }, minNext: { raw: "5000" } };
  assert.deepEqual(planWarBids([template, higherMinimum], template, NOW, 2, 1001n, () => 0, undefined, "quote"), [
    { op: "bid", g: 1, amount: "1001" },
    { op: "bid", g: 1, amount: "1002" },
  ], "a shorter clock never displaces the cheaper playable game");
});

test("effective next minimum combines configured, last-paid, and reported amounts exactly", () => {
  assert.equal(effectiveWarMinBid(game(1)), 1000n);
  assert.equal(effectiveWarMinBid(game(1, { minBid: { raw: "0" } })), 1n);
  assert.equal(effectiveWarMinBid(game(1, { lastBid: { raw: "2000" }, minNext: { raw: "1500" } })), 2001n);
  assert.equal(effectiveWarMinBid(game(1, { lastBid: { raw: "2000" }, minNext: { raw: "3000" } })), 3000n);
  const lower = game(1, { minBid: { raw: "9007199254740992" }, deadline: NOW + 400 });
  const higher = game(2, { minBid: { raw: "9007199254740993" }, deadline: NOW + 1 });
  assert.equal(chooseQuoteWarTarget([higher, lower], higher, NOW).game, lower);
});

test("a cheaper waiting game beats running games and supplies the fork rules when clocks permit", () => {
  const template = planningGame(1);
  const waiting = planningGame(2, { deadline: 0, bids: 0, lastBid: { raw: "0" }, minNext: { raw: "500" }, minBid: { raw: "500" }, roundSecs: 180 });
  assert.equal(chooseQuoteWarTarget([template, waiting], template, NOW).game, waiting);
  assert.deepEqual(chooseQuoteWarTarget([template, waiting], template, NOW, 0), { game: waiting, op: "fork", spawnEligible: true });
  const urgent = { ...template, deadline: NOW + 1 };
  assert.deepEqual(chooseQuoteWarTarget([urgent, waiting], urgent, NOW, 0), { game: waiting, op: "bid", spawnEligible: false });
});

test("quote sorting uses clock and id only for equal minima, and never bids on ended games", () => {
  const waiting = game(3, { deadline: 0 });
  const later = game(2, { deadline: NOW + 20 });
  const sooner = game(1, { deadline: NOW + 10 });
  const expired = game(4, { deadline: NOW, minBid: { raw: "1" } });
  const settled = game(5, { over: true, minBid: { raw: "1" } });
  const input = [settled, expired, waiting, later, sooner];
  assert.deepEqual(sortQuoteWarGames(input, NOW).map((g) => g.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(input.map((g) => g.id), [5, 4, 3, 2, 1]);
  assert.deepEqual(sortQuoteWarGames([game(7, { deadline: 0 }), game(6, { deadline: 0 })], NOW).map((g) => g.id), [6, 7]);
  assert.deepEqual(sortQuoteWarGames([game(9), game(8)], NOW).map((g) => g.id), [8, 9]);
  assert.equal(chooseQuoteWarTarget(input, waiting, NOW).game, sooner);
  assert.equal(chooseQuoteWarTarget(input, waiting, NOW + 20).game, waiting);
});

test("quote planning selects the dynamically lowest next bid independently of clock order", () => {
  const first = planningGame(1, { deadline: NOW + 300 });
  const second = planningGame(2, { deadline: NOW + 10, minNext: { raw: "1002" } });
  assert.deepEqual(planWarBids([first, second], second, NOW, 4, 1001n, () => 0.9, undefined, "quote"), [
    { op: "bid", g: 1, amount: "1001" },
    { op: "bid", g: 2, amount: "1002" },
    { op: "bid", g: 1, amount: "1003" },
    { op: "bid", g: 2, amount: "1004" },
  ]);
});
