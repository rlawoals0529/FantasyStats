/**
 * The modelling slice's front door.
 *
 * Everything above this line is the model: history in, `Outlook` and `Tie` out, no fetching, no
 * clock, no randomness that is not seeded. The pipeline hands it `PlayerWeek[]` and the pre-
 * kickoff facts; the UI takes the `Outlook`s and the `Tie`s. Neither side reaches past this file
 * into a fitted line or a bin width, which is what keeps those changeable.
 */

import type { Outlook, PlayerWeek, Position, Tie } from "../shared/player.ts";
import { asOf, type AsOfBoundary, type AsOfWindow } from "./asof.ts";
import { expectedOutcome } from "./expected.ts";
import type { KickoffFacts, TouchdownWeek } from "./inputs.ts";
import { findTies } from "./overlap.ts";
import { simulate, type Simulation } from "./simulate.ts";

// The shared contract is re-exported so a consumer needs one import, not two, and so there is
// no temptation to reach into `src/shared` for a threshold and get a different one.
export {
  BUST_POINTS,
  SEPARABLE_OVERLAP,
  SPIKE_POINTS,
  type Outlook,
  type PlayerWeek,
  type Position,
  type Reason,
  type Tie,
} from "../shared/player.ts";
export { asOf, isBefore, type AsOfBoundary, type AsOfWindow } from "./asof.ts";
export {
  calibrationError,
  errorMetrics,
  quantileCoverage,
  reliability,
  spikeLiftByDecile,
  walkForward,
  type Graded,
} from "./backtest.ts";
export * from "./calibration.ts";
export {
  gammaCdf,
  gammaFromMeanSd,
  gammaSurvival,
  MIN_MEAN_POINTS,
  type GammaParams,
} from "./distribution.ts";
export { expectedOutcome, spikeRateForImpliedTotal, type ExpectedOutcome } from "./expected.ts";
export { FEATURES } from "./features.ts";
export type { Dated, InjuryDesignation, KickoffFacts, TouchdownWeek } from "./inputs.ts";
export { findTies, isSeparable, overlapOfGammas, overlapOfSamples } from "./overlap.ts";
export { paramsFor, quantile, simulate, simulateMean, type Simulation } from "./simulate.ts";
export { LADDER_ANCHORS, sdForMean, tierForMean } from "./volatility.ts";

/** One player's outlook for one week, or null when the history is too thin to say anything. */
export function outlookFor(
  window: AsOfWindow,
  playerId: string,
  position: Position,
  kickoff: KickoffFacts | null = null,
): Simulation | null {
  const expected = expectedOutcome(window, playerId, position, kickoff);
  if (!expected) return null;
  return simulate(expected);
}

/** Everything the model has to say about one week, including what it refuses to rank. */
export type WeekOutlook = {
  outlooks: Outlook[];
  ties: Tie[];
  /** Players skipped for want of history, so a caller can say so rather than drop them silently. */
  skipped: string[];
};

/**
 * Build a whole week from raw history.
 *
 * Note the shape of this: the caller passes EVERY row it has, including rows from the week being
 * predicted and after it, and `asOf` cuts them here. That is deliberate. The alternative - asking
 * the caller to pass pre-filtered history - puts the leakage barrier in the caller, which is
 * where it will eventually be got wrong, and the backtest is the caller that matters most.
 */
export function weekOutlook(
  boundary: AsOfBoundary,
  roster: readonly { playerId: string; position: Position }[],
  weeks: readonly PlayerWeek[],
  touchdowns: readonly TouchdownWeek[] = [],
  kickoffs: readonly KickoffFacts[] = [],
): WeekOutlook {
  const window = asOf(boundary, weeks, touchdowns);
  const kickoffById = new Map<string, KickoffFacts>();
  for (const fact of kickoffs) {
    if (fact.season === boundary.season && fact.week === boundary.week) {
      kickoffById.set(fact.playerId, fact);
    }
  }

  const sims: Simulation[] = [];
  const skipped: string[] = [];
  for (const entry of roster) {
    const sim = outlookFor(
      window,
      entry.playerId,
      entry.position,
      kickoffById.get(entry.playerId) ?? null,
    );
    if (sim) sims.push(sim);
    else skipped.push(entry.playerId);
  }

  return { outlooks: sims.map((s) => s.outlook), ties: findTies(sims), skipped };
}
