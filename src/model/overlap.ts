/**
 * Refusing to rank what cannot be told apart.
 *
 * At CV 0.82 the seventh and the eleventh player on a ranking page are routinely
 * indistinguishable, and sorting them anyway is a lie told with a sort function - the reader
 * takes an ordering as a claim, because that is what an ordering is. So pairs whose
 * distributions overlap past `SEPARABLE_OVERLAP` come back as `Tie` and the caller is expected
 * to show them level, with the overlap stated.
 *
 * The statistic is the overlapping coefficient, the integral of min(f, g). It is 1 for two
 * identical distributions and 0 for two that never meet, it needs no assumption of a shared
 * shape, and it is the one a reader can be told in a sentence: the share of outcomes the two
 * players have in common.
 */

import type { Tie } from "../shared/player.ts";
import { SEPARABLE_OVERLAP } from "../shared/player.ts";
import { gammaCdf, type GammaParams } from "./distribution.ts";
import type { Simulation } from "./simulate.ts";

/**
 * Overlap of two fitted gammas, by integrating min(f, g) on a shared grid.
 *
 * This is the one `findTies` uses, and it is deliberately NOT the sample-based estimator below.
 * A histogram of 10k draws is biased DOWNWARD by roughly six points of overlap at this bin
 * width, purely from binning noise, and that bias points the wrong way for this product: it
 * makes two identical players look separable and gets them ranked. The closed form has no such
 * bias. `overlap.test.ts` measures the gap between the two so the claim stays true.
 *
 * Integrated as a difference of CDFs per cell rather than as a density times a width, so the
 * result is exact in each cell for whichever of the two is smaller there, and the grid only has
 * to be fine enough to catch the crossing point.
 */
export function overlapOfGammas(a: GammaParams, b: GammaParams, cells = 4000): number {
  const upper = Math.max(upperLimit(a), upperLimit(b));
  let total = 0;
  let previousA = 0;
  let previousB = 0;
  for (let i = 1; i <= cells; i++) {
    const x = (upper * i) / cells;
    const cdfA = gammaCdf(x, a);
    const cdfB = gammaCdf(x, b);
    total += Math.min(cdfA - previousA, cdfB - previousB);
    previousA = cdfA;
    previousB = cdfB;
  }
  return clamp01(total);
}

/**
 * Overlap from two sets of draws, for callers that have samples and no params.
 *
 * Present because the page's lineup simulator works on draws, and honest about its bias: with
 * 10k draws and 1-point bins it reads about 0.94 for two identical distributions. Do not compare
 * its output against `SEPARABLE_OVERLAP` without accounting for that.
 */
export function overlapOfSamples(a: Float64Array, b: Float64Array, binWidth = 1): number {
  if (a.length === 0 || b.length === 0) return 0;
  const upper = Math.max(a[a.length - 1] ?? 0, b[b.length - 1] ?? 0);
  const bins = Math.max(1, Math.ceil(upper / binWidth));
  const histA = histogram(a, binWidth, bins);
  const histB = histogram(b, binWidth, bins);
  let total = 0;
  for (let i = 0; i < bins; i++) total += Math.min(histA[i] ?? 0, histB[i] ?? 0);
  return clamp01(total);
}

/**
 * Every pair too close to order, with the overlap that made them a tie.
 *
 * O(n^2) on purpose. A week's slate is a few hundred players, so this is a few tens of
 * thousands of closed-form overlaps, and the alternative - pruning by a mean gap first - would
 * need a threshold that is not measured. Pairs come back in a stable order so a page rendering
 * them does not reshuffle between runs.
 */
export function findTies(
  sims: readonly Simulation[],
  threshold: number = SEPARABLE_OVERLAP,
): Tie[] {
  const ordered = [...sims].sort((x, y) => x.outlook.playerId.localeCompare(y.outlook.playerId));
  const ties: Tie[] = [];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const left = ordered[i];
      const right = ordered[j];
      if (!left || !right) continue;
      const overlap = overlapOfGammas(left.params, right.params);
      if (overlap > threshold) {
        ties.push({ a: left.outlook.playerId, b: right.outlook.playerId, overlap });
      }
    }
  }
  return ties;
}

/**
 * True when an ordering of these two can be defended. The negative of a tie, spelled out
 * because call sites read better asking whether they may rank than whether they must not.
 */
export function isSeparable(
  a: Simulation,
  b: Simulation,
  threshold: number = SEPARABLE_OVERLAP,
): boolean {
  return overlapOfGammas(a.params, b.params) <= threshold;
}

function histogram(sorted: Float64Array, binWidth: number, bins: number): Float64Array {
  const counts = new Float64Array(bins);
  for (const value of sorted) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(value / binWidth)));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  for (let i = 0; i < bins; i++) counts[i] = (counts[i] ?? 0) / sorted.length;
  return counts;
}

/** Far enough out that the tail left over is smaller than the rounding on the answer. */
function upperLimit(params: GammaParams): number {
  const mean = params.shape * params.scale;
  const sd = Math.sqrt(params.shape) * params.scale;
  return mean + 12 * sd;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
