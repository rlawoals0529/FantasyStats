/**
 * Ten thousand draws, and the `Outlook` they add up to.
 *
 * The seed is derived from the player and the week, never from a counter and never from the
 * clock. That is not tidiness: an unseeded simulator makes the calibration suite a coin toss
 * that passes most of the time, and it makes a screenshot of the page unreproducible, so a user
 * who says "it said 34 per cent yesterday" cannot be answered.
 *
 * Ten thousand is the figure from CONCEPT.md. At that count the Monte Carlo standard error on a
 * 10 per cent spike probability is 0.3 points of percentage, which is well inside the width of
 * the thing being estimated, and p10/p90 are stable to about a tenth of a point.
 */

import { type Outlook, type Position, BUST_POINTS, SPIKE_POINTS } from "../shared/player.ts";
import type { AsOfBoundary } from "./asof.ts";
import { DRAWS_PER_PLAYER } from "./calibration.ts";
import { gammaFromMeanSd, sampleGamma, type GammaParams } from "./distribution.ts";
import type { ExpectedOutcome } from "./expected.ts";
import { mulberry32, seedFor } from "./rng.ts";
import { sdForMean } from "./volatility.ts";

/**
 * An `Outlook` plus the things that produced it.
 *
 * `Outlook` is a fixed contract and carries only what the page needs. The draws and the fitted
 * params stay here, because tie detection needs the distributions and the calibration suite
 * needs to check the sampler against the closed form.
 */
export type Simulation = {
  outlook: Outlook;
  params: GammaParams;
  /** Sorted ascending. Sorting once is what makes the quantiles cheap and the ties cheap. */
  draws: Float64Array;
};

/** The parameters a player-week is drawn with. Mean from `expected`, spread from the ladder. */
export function paramsFor(expected: ExpectedOutcome): GammaParams {
  const sd = sdForMean(expected.mean, expected.position) * expected.sdMultiplier;
  return gammaFromMeanSd(expected.mean, sd);
}

/**
 * The seed for one player-week.
 *
 * Keyed on the week and the player and nothing else, so simulating a five-player lineup gives
 * each of them the same draws they would get in a full 400-player slate. Seeding off a loop
 * counter is the trap: it is perfectly deterministic in a test, where the input is a fixed
 * array, and quietly different in production, where the slate is filtered.
 */
export function seedForPlayerWeek(boundary: AsOfBoundary, playerId: string): number {
  return seedFor([boundary.season, boundary.week, playerId]);
}

export function simulate(expected: ExpectedOutcome, draws: number = DRAWS_PER_PLAYER): Simulation {
  if (!Number.isInteger(draws) || draws < 1) {
    throw new Error(`draws must be a positive integer, got ${draws}`);
  }
  const params = paramsFor(expected);
  const rng = mulberry32(seedForPlayerWeek(expected.boundary, expected.playerId));
  const values = new Float64Array(draws);
  for (let i = 0; i < draws; i++) values[i] = sampleGamma(rng, params);
  values.sort();

  return {
    params,
    draws: values,
    outlook: {
      playerId: expected.playerId,
      p10: quantile(values, 0.1),
      p50: quantile(values, 0.5),
      p90: quantile(values, 0.9),
      spike: rateAtOrAbove(values, SPIKE_POINTS),
      bust: rateAtOrBelow(values, BUST_POINTS),
      because: expected.reasons,
    },
  };
}

/**
 * Linear interpolation between order statistics, the same convention as R's type 7.
 *
 * Picking a convention and naming it matters more than which one: the nearest-rank and the
 * interpolated answers differ by a tenth of a point at the tails, and two call sites disagreeing
 * about it is how a p90 on the page stops matching the p90 in the scorecard.
 */
export function quantile(sorted: Float64Array, q: number): number {
  const n = sorted.length;
  if (n === 0) throw new Error("quantile of an empty sample");
  if (n === 1) return sorted[0] ?? 0;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const frac = pos - lo;
  return (sorted[lo] ?? 0) * (1 - frac) + (sorted[hi] ?? 0) * frac;
}

/** Fraction of draws at or above a threshold. Binary search, since `sorted` is sorted. */
export function rateAtOrAbove(sorted: Float64Array, threshold: number): number {
  return (sorted.length - lowerBound(sorted, threshold)) / sorted.length;
}

/** Fraction at or below. `<=` matters: BUST_POINTS is inclusive in the contract. */
export function rateAtOrBelow(sorted: Float64Array, threshold: number): number {
  return upperBound(sorted, threshold) / sorted.length;
}

/** First index whose value is >= target. */
function lowerBound(sorted: Float64Array, target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] ?? 0) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose value is > target. */
function upperBound(sorted: Float64Array, target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] ?? 0) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Convenience for callers that only have a mean and a position, such as the calibration suite. */
export function simulateMean(
  playerId: string,
  position: Position,
  mean: number,
  boundary: AsOfBoundary,
  draws: number = DRAWS_PER_PLAYER,
): Simulation {
  return simulate(
    { playerId, position, boundary, mean, sdMultiplier: 1, reasons: [] },
    draws,
  );
}
