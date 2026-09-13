/**
 * How wide a player's week is. Note what this file does not import: a player's own past spread.
 *
 * THE WHOLE POINT. Residual volatility - spread with the mean's effect removed - correlates at
 * r = 0.152 between halves of a season. About 85 per cent noise. So a player's measured
 * boom-bust-ness tells you almost nothing about their next half-season, and fitting a spread
 * from their own history, which is the obvious implementation and the one every draft of this
 * started with, produces a confident number built on a coin toss.
 *
 * What IS stable is the relationship between a player's mean and their spread, which is the
 * measured ladder in `calibration.ts`. So spread is drawn from position and mean, and a
 * player's own variance never enters. `volatility.test.ts` asserts that by construction: two
 * players with identical means and wildly different histories get identical spreads.
 *
 * Position is a parameter here and currently does nothing, which is deliberate and is flagged
 * rather than hidden. The ladder was measured across the flex positions; CONCEPT.md quotes the
 * CV of 0.82 for RB/WR/TE specifically and does not tabulate QB separately. Applying an invented
 * QB multiplier would be worse than applying none, so QB gets the same ladder and the gap is
 * recorded in `POSITION_ADJUSTMENT` where a measurement can replace it.
 */

import type { Position } from "../shared/player.ts";
import { VOLATILITY_LADDER, type VolatilityTier } from "./calibration.ts";

/**
 * The mean each tier's sd was measured at, recovered as sd / (sd/mean).
 *
 * Sorted ascending, and `assertLadderIsUsable` checks each one lands inside its own tier, so a
 * mistyped table fails at import rather than producing a plausible curve through wrong knots.
 */
export const LADDER_ANCHORS: readonly { mean: number; sd: number }[] = VOLATILITY_LADDER.map(
  (tier: VolatilityTier) => ({ mean: tier.sd / tier.sdOverMean, sd: tier.sd }),
);

/** The steepest sd/mean the ladder measures, at the bottom tier. Used as a floor-side cap. */
const MAX_MEASURED_CV = Math.max(...VOLATILITY_LADDER.map((t) => t.sdOverMean));

function assertLadderIsUsable(): void {
  let previous = -Infinity;
  VOLATILITY_LADDER.forEach((tier, i) => {
    const anchor = LADDER_ANCHORS[i];
    if (!anchor) throw new Error(`volatility ladder anchor ${i} missing`);
    if (anchor.mean < tier.minMean || anchor.mean >= tier.maxMean) {
      throw new Error(
        `volatility tier ${i} is inconsistent: sd ${tier.sd} over sd/mean ${tier.sdOverMean} ` +
          `implies a mean of ${anchor.mean.toFixed(2)}, outside [${tier.minMean}, ${tier.maxMean})`,
      );
    }
    if (anchor.mean <= previous) throw new Error(`volatility ladder anchors are not ascending`);
    previous = anchor.mean;
  });
}
assertLadderIsUsable();

/**
 * Per-position multiplier on the ladder's sd. All 1, and that is a stated absence.
 *
 * Not measured. CONCEPT.md gives one CV for RB/WR/TE together and nothing for QB. A QB's week
 * is plausibly tighter - more of the scoring is yardage, less of it is one touchdown landing -
 * but plausibly is not measured, so the value stays 1 and the model under-claims instead of
 * inventing. This is the hook for the measurement when someone runs it.
 */
export const POSITION_ADJUSTMENT: Readonly<Record<Position, number>> = {
  QB: 1,
  RB: 1,
  WR: 1,
  TE: 1,
};

/**
 * The tier a season mean falls in, by the table's own bounds. Exported for the calibration test.
 */
export function tierForMean(mean: number): VolatilityTier {
  const tier = VOLATILITY_LADDER.find((t) => mean >= t.minMean && mean < t.maxMean);
  if (!tier) throw new Error(`no volatility tier covers a mean of ${mean}`);
  return tier;
}

/**
 * sd of weekly points for a player expected to average `mean`, at `position`.
 *
 * Linear between the tier anchors rather than a step per tier. A step function would hand a
 * player averaging 10.99 an sd of 6.21 and a player averaging 11.01 an sd of 7.13 - a 15 per
 * cent jump in spread, and therefore a visible jump in the page's headline spike number, across
 * a boundary that is an artefact of how the table was bucketed. Nobody could defend that on
 * screen. The anchors are exactly the measured pairs, so the interpolation passes through every
 * measured point: `sdForMean(anchor.mean)` returns the tabulated sd exactly, which is what
 * `calibration.test.ts` pins.
 *
 * Outside the anchors it holds flat, not extrapolates. Below the bottom anchor it also honours
 * the steepest CV the ladder measures, because holding sd flat at 2.93 down to a mean of 0.5
 * would imply a CV of 5.9, six times anything ever measured, and would report a bench player as
 * a lottery ticket.
 */
export function sdForMean(mean: number, position: Position): number {
  const base = interpolateSd(mean);
  const adjustment = POSITION_ADJUSTMENT[position];
  return base * adjustment;
}

function interpolateSd(mean: number): number {
  const first = LADDER_ANCHORS[0];
  const last = LADDER_ANCHORS[LADDER_ANCHORS.length - 1];
  if (!first || !last) throw new Error("volatility ladder is empty");
  if (mean <= first.mean) return Math.min(first.sd, mean * MAX_MEASURED_CV);
  if (mean >= last.mean) return last.sd;
  for (let i = 1; i < LADDER_ANCHORS.length; i++) {
    const lo = LADDER_ANCHORS[i - 1];
    const hi = LADDER_ANCHORS[i];
    if (!lo || !hi) continue;
    if (mean <= hi.mean) {
      const t = (mean - lo.mean) / (hi.mean - lo.mean);
      return lo.sd + t * (hi.sd - lo.sd);
    }
  }
  return last.sd;
}
