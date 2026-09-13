/**
 * The per-player features, every one of them a pure function of an `AsOfWindow`.
 *
 * Two rules hold this file together and both are enforced rather than asked for.
 *
 * A feature takes `(window, playerId)` and returns a number or null. Null means "not enough
 * history to say", never zero - a player with two games has no opportunity gap, and calling it
 * 0.0 would put them in the middle quartile alongside players who were actually measured there.
 *
 * Every exported feature must appear in `FEATURES`. `asof.test.ts` walks that registry and
 * poisons the future for each entry, and a separate test asserts the registry lists every
 * exported feature function in this module, so adding one without a leakage check fails the
 * build rather than quietly shipping an unguarded feature.
 *
 * The cross-sectional features - the quartile and the tercile - are where the leakage risk
 * actually lives, because they need the whole league and the whole league is the easiest place
 * to reach into next week by accident. They read the same window as everything else.
 */

import type { PlayerWeek } from "../shared/player.ts";
import { type AsOfWindow, touchdownsFor, weeksFor } from "./asof.ts";
import { MIN_GAMES_FOR_BASELINE } from "./calibration.ts";

/** Fewest league rows before a cross-sectional fit is trusted at all. */
const MIN_ROWS_FOR_FIT = 30;
/** Fewest players before quartiles of the league mean anything. */
const MIN_PLAYERS_FOR_RANKING = 12;

// ---------------------------------------------------------------------------------------------
// Per-player features.
// ---------------------------------------------------------------------------------------------

/**
 * The baseline, and the thing to beat: the player's average points in the season to date.
 *
 * CONCEPT.md measures this at RMSE 6.208 and a fitted model on past points, target share, WOPR
 * and the Vegas line at 6.119, with a WORSE MAE. So this is not a starting point that gets
 * improved on; it is close to the ceiling of the category, and everything downstream of it is
 * an adjustment of a point or so, not a replacement.
 *
 * Prior seasons are deliberately not included. Rosters, roles and offences turn over, and the
 * measurement that backs this number was computed within-season.
 */
export function seasonAverage(window: AsOfWindow, playerId: string): number | null {
  const rows = currentSeasonRows(window, playerId);
  if (rows.length < MIN_GAMES_FOR_BASELINE) return null;
  return mean(rows.map((r) => r.points));
}

/** Games of usable history in the current season. Drives the "not enough to say" answer. */
export function gamesPlayed(window: AsOfWindow, playerId: string): number | null {
  return currentSeasonRows(window, playerId).length;
}

/**
 * Production minus what that player's opportunity usually buys, in points per game.
 *
 * Positive means outrunning the opportunity, which the measurement says gives itself back.
 * "What opportunity buys" is a league-wide fit on the SAME window, so it moves as the season
 * goes on, which is correct: the exchange rate between a target share and a point is not a
 * constant of nature.
 *
 * WOPR is preferred over target share because it is the stickier of the two, 0.878 against
 * 0.860. Neither is used as a predictor in its own right, because the measurement is blunt about
 * that: opportunity predicts points WORSE than past points do, 0.634 against 0.780. It is only
 * useful as the reference that production is compared against.
 */
export function opportunityGap(window: AsOfWindow, playerId: string): number | null {
  const rows = currentSeasonRows(window, playerId);
  if (rows.length < MIN_GAMES_FOR_BASELINE) return null;
  const league = leagueFits(window);
  const wopr = meanOrNull(rows.map((r) => r.wopr));
  const share = meanOrNull(rows.map((r) => r.targetShare));
  const expected =
    wopr !== null && league.pointsOnWopr
      ? apply(league.pointsOnWopr, wopr)
      : share !== null && league.pointsOnShare
        ? apply(league.pointsOnShare, share)
        : null;
  if (expected === null) return null;
  return mean(rows.map((r) => r.points)) - expected;
}

/**
 * Touchdowns per game against what this player's opportunity implies, positive being hot.
 *
 * Touchdown stickiness is 0.453, so roughly half of a hot rate is signal and half is a run of
 * balls bouncing right, and the half that is luck comes back. This is the feature the regression
 * list is built on, and it is computed off an explicit touchdown count rather than inferred from
 * points, because points cannot be decomposed: a 6-point week is one touchdown or sixty yards
 * and nothing in `PlayerWeek` can tell them apart.
 */
export function touchdownLuck(window: AsOfWindow, playerId: string): number | null {
  const rows = currentSeasonRows(window, playerId);
  if (rows.length < MIN_GAMES_FOR_BASELINE) return null;
  const scores = touchdownsFor(window, playerId).filter((r) => r.season === window.boundary.season);
  if (scores.length < MIN_GAMES_FOR_BASELINE) return null;
  const league = leagueFits(window);
  const wopr = meanOrNull(rows.map((r) => r.wopr));
  const share = meanOrNull(rows.map((r) => r.targetShare));
  const expected =
    wopr !== null && league.touchdownsOnWopr
      ? apply(league.touchdownsOnWopr, wopr)
      : share !== null && league.touchdownsOnShare
        ? apply(league.touchdownsOnShare, share)
        : null;
  if (expected === null) return null;
  return mean(scores.map((r) => r.touchdowns)) - expected;
}

/**
 * Which quartile of the league's opportunity gap this player sits in. 0 is the biggest shortfall.
 *
 * Quartile rather than the raw gap because that is how the effect was measured - as a ladder
 * across quartiles, 2.3 to 2.8 ppg between the extremes - and applying a measured-by-bucket
 * effect as a continuous slope would be quoting an effect size that was never estimated.
 */
export function opportunityGapQuartile(window: AsOfWindow, playerId: string): number | null {
  const gap = opportunityGap(window, playerId);
  if (gap === null) return null;
  return bucketOf(gap, leagueRanks(window).opportunityGap, 4);
}

/** Cold, neutral or hot on touchdown rate, by tercile of the league's as-of distribution. */
export function touchdownLuckTercile(window: AsOfWindow, playerId: string): number | null {
  const luck = touchdownLuck(window, playerId);
  if (luck === null) return null;
  return bucketOf(luck, leagueRanks(window).touchdownLuck, 3);
}

/**
 * The registry the leakage test walks. Every exported feature above appears here.
 *
 * `registry.test.ts` checks that claim by reflecting over this module's exports, so a new
 * feature that is not listed fails a named test instead of shipping unguarded.
 */
export const FEATURES: Readonly<Record<string, (w: AsOfWindow, id: string) => number | null>> = {
  seasonAverage,
  gamesPlayed,
  opportunityGap,
  touchdownLuck,
  opportunityGapQuartile,
  touchdownLuckTercile,
};

// ---------------------------------------------------------------------------------------------
// League-wide work, computed once per window.
// ---------------------------------------------------------------------------------------------

type Line = { intercept: number; slope: number };
type LeagueFits = {
  pointsOnWopr: Line | null;
  pointsOnShare: Line | null;
  touchdownsOnWopr: Line | null;
  touchdownsOnShare: Line | null;
};
type LeagueRanks = { opportunityGap: readonly number[]; touchdownLuck: readonly number[] };

/**
 * Memoised per window object, which is safe precisely because a window is immutable and is cut
 * at exactly one boundary. Cache it on anything mutable and the cache becomes a leakage route
 * of its own: week 9's fit answering a week 4 question is the same bug wearing a hat.
 */
const FIT_CACHE = new WeakMap<AsOfWindow, LeagueFits>();
const RANK_CACHE = new WeakMap<AsOfWindow, LeagueRanks>();

function leagueFits(window: AsOfWindow): LeagueFits {
  const cached = FIT_CACHE.get(window);
  if (cached) return cached;
  const scoreByKey = new Map<string, number>();
  for (const row of window.touchdowns) scoreByKey.set(key(row), row.touchdowns);
  const rows = window.weeks.filter((r) => r.season === window.boundary.season);
  const fits: LeagueFits = {
    pointsOnWopr: fit(rows, (r) => r.wopr, (r) => r.points),
    pointsOnShare: fit(rows, (r) => r.targetShare, (r) => r.points),
    touchdownsOnWopr: fit(rows, (r) => r.wopr, (r) => scoreByKey.get(key(r)) ?? null),
    touchdownsOnShare: fit(rows, (r) => r.targetShare, (r) => scoreByKey.get(key(r)) ?? null),
  };
  FIT_CACHE.set(window, fits);
  return fits;
}

function leagueRanks(window: AsOfWindow): LeagueRanks {
  const cached = RANK_CACHE.get(window);
  if (cached) return cached;
  const ids = [...new Set(window.weeks.map((r) => r.playerId))].sort();
  const gaps: number[] = [];
  const luck: number[] = [];
  for (const id of ids) {
    const gap = opportunityGap(window, id);
    if (gap !== null) gaps.push(gap);
    const td = touchdownLuck(window, id);
    if (td !== null) luck.push(td);
  }
  const ranks: LeagueRanks = {
    opportunityGap: gaps.sort((a, b) => a - b),
    touchdownLuck: luck.sort((a, b) => a - b),
  };
  RANK_CACHE.set(window, ranks);
  return ranks;
}

/**
 * Which of `buckets` equal-sized slices of `sorted` a value falls in.
 *
 * Ties go to the lower bucket, by counting strictly-less-than. With a small league and a lot of
 * identical zeros that matters, and picking a side deterministically is what keeps the simulator
 * reproducible.
 */
function bucketOf(value: number, sorted: readonly number[], buckets: number): number | null {
  if (sorted.length < MIN_PLAYERS_FOR_RANKING) return null;
  // A degenerate distribution has no buckets, only a tie. Without this, every player in the
  // league lands in bucket 0 - because nothing is strictly less than anything else - and the
  // whole league silently collects the bottom bucket effect. That is a free adjustment paid to
  // everyone on the strength of no information at all, and it is exactly the kind of thing that
  // shows up as a small unexplained bias in a backtest months later.
  if ((sorted[sorted.length - 1] ?? 0) - (sorted[0] ?? 0) <= 0) return null;
  let below = 0;
  for (const v of sorted) if (v < value) below++;
  const index = Math.floor((below / sorted.length) * buckets);
  return Math.min(buckets - 1, Math.max(0, index));
}

/** Ordinary least squares, returning null rather than a line through nothing. */
function fit(
  rows: readonly PlayerWeek[],
  x: (r: PlayerWeek) => number | null,
  y: (r: PlayerWeek) => number | null,
): Line | null {
  const pairs: { x: number; y: number }[] = [];
  for (const row of rows) {
    const xv = x(row);
    const yv = y(row);
    if (xv === null || yv === null || !Number.isFinite(xv) || !Number.isFinite(yv)) continue;
    pairs.push({ x: xv, y: yv });
  }
  if (pairs.length < MIN_ROWS_FOR_FIT) return null;
  const mx = mean(pairs.map((p) => p.x));
  const my = mean(pairs.map((p) => p.y));
  let sxy = 0;
  let sxx = 0;
  for (const p of pairs) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) * (p.x - mx);
  }
  if (sxx <= 0) return null;
  const slope = sxy / sxx;
  return { intercept: my - slope * mx, slope };
}

function apply(line: Line, x: number): number {
  return line.intercept + line.slope * x;
}

function currentSeasonRows(window: AsOfWindow, playerId: string): readonly PlayerWeek[] {
  return weeksFor(window, playerId).filter((r) => r.season === window.boundary.season);
}

function key(row: { playerId: string; season: number; week: number }): string {
  return `${row.playerId}:${row.season}:${row.week}`;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function meanOrNull(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (present.length === 0) return null;
  return mean(present);
}
