/**
 * The family a week of fantasy points is drawn from, and why it is not a normal.
 *
 * WHY GAMMA
 *
 * Three things are true of a weekly score and a normal distribution respects none of them.
 *
 * 1. It cannot go below zero, and it piles up just above it. A normal centred on 7 with the
 *    measured sd of 5.10 puts 8.4 per cent of its mass below zero. Those are not rare tail
 *    events, they are impossible events, and every one of them is stolen from the right tail
 *    that this product exists to report.
 * 2. It is right-skewed, hard. A 40-point week happens; a minus-26-point week does not. The
 *    measured concentration says so directly - about 40 per cent of a season arrives in a
 *    player's best three weeks, which a symmetric distribution cannot produce at this spread.
 * 3. Its spread scales with its mean. The measured ladder is sd 2.93 at a mean under 5 rising
 *    to 8.42 at 14 or more. A family whose variance is free of its mean has to be told the
 *    relationship; gamma has it built in, because variance = mean * scale.
 *
 * Gamma gives all three: support [0, inf), skewness fixed at 2 * CV so a low-mean player is
 * automatically the more lopsided one, and a shape below 1 - which is what the lowest measured
 * tier's CV of 1.16 implies - puts a genuine pile-up of near-zero weeks in the model, which is
 * what a bench player's season actually looks like.
 *
 * The families this was chosen over:
 *
 * - Normal. Negative mass, symmetric, understates the spike. Rejected on all three counts, and
 *   `distribution.test.ts` holds it to that so the rejection is a measurement, not a claim.
 * - Lognormal. Right sign, wrong amount. Its skew is (CV^2 + 3) * CV, so at the lowest tier's
 *   CV of 1.16 it is 5.0 against gamma's 2.3, and it has zero density AT zero, which is the
 *   opposite of the pile-up we want. It overstates the spike rate for exactly the low-mean
 *   players where being wrong is cheapest to hide.
 * - Zero-inflated gamma. Almost certainly closer to the truth, and deliberately not used: the
 *   inflation probability is not in the measured set, so it would be a knob fitted to nothing.
 *   The shape < 1 branch already puts mass near zero without inventing a parameter.
 *
 * Gamma is still wrong in one known way. A real week has a discrete point mass at exactly zero
 * (inactive, ejected, benched) and gamma is continuous, so P(exactly 0) is 0 here. That is a
 * misfit on the bust boundary, not the spike boundary, and BUST_POINTS is 5 rather than 0,
 * which keeps it out of the number the page leads with.
 */

import { gammaVariate, type Rng } from "./rng.ts";

/** A gamma in the parameterisation everything here actually has: a mean and an sd. */
export type GammaParams = {
  /** k. Below 1 the density is monotone decreasing, which is the near-zero pile-up. */
  shape: number;
  /** theta. mean = shape * scale, variance = shape * scale^2. */
  scale: number;
};

/** The smallest mean the simulator will centre on. A gamma needs a strictly positive mean. */
export const MIN_MEAN_POINTS = 0.25;

/** Moment-match a gamma to a mean and an sd. The only way params are ever built. */
export function gammaFromMeanSd(mean: number, sd: number): GammaParams {
  if (!(mean > 0) || !Number.isFinite(mean)) {
    throw new Error(`gamma needs a positive finite mean, got ${mean}`);
  }
  if (!(sd > 0) || !Number.isFinite(sd)) {
    throw new Error(`gamma needs a positive finite sd, got ${sd}`);
  }
  const cv = sd / mean;
  return { shape: 1 / (cv * cv), scale: mean * cv * cv };
}

/** One draw. */
export function sampleGamma(rng: Rng, params: GammaParams): number {
  return gammaVariate(rng, params.shape) * params.scale;
}

/** Log of the gamma function, Lanczos g=7, n=9. Accurate to ~1e-13 over the range used here. */
const LANCZOS: readonly number[] = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

export function logGamma(x: number): number {
  if (x < 0.5) {
    // Reflection, so the caller never has to care which side of 0.5 they are on.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = LANCZOS[0] ?? 0;
  const t = z + 7.5;
  for (let i = 1; i < LANCZOS.length; i++) a += (LANCZOS[i] ?? 0) / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * P(X <= x) for a gamma, via the regularised lower incomplete gamma function.
 *
 * This exists so the tails have an answer that does not come from the sampler. A Monte Carlo
 * spike rate checked against a Monte Carlo spike rate proves the arithmetic is consistent with
 * itself and nothing else; checked against this, it proves the sampler draws from the
 * distribution it claims to. The calibration suite uses both, deliberately.
 *
 * Series below x < shape + 1, continued fraction above, which is the standard split because
 * each converges quickly only on its own side of it.
 */
export function gammaCdf(x: number, params: GammaParams): number {
  if (x <= 0) return 0;
  const a = params.shape;
  const z = x / params.scale;
  if (z < a + 1) return lowerSeries(a, z);
  return 1 - upperContinuedFraction(a, z);
}

/** P(X >= x). Spelled out because that is the question the product asks. */
export function gammaSurvival(x: number, params: GammaParams): number {
  return 1 - gammaCdf(x, params);
}

const MAX_ITERATIONS = 1000;
const EPSILON = 1e-14;
const TINY = 1e-300;

function lowerSeries(a: number, x: number): number {
  let ap = a;
  let sum = 1 / a;
  let term = sum;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    ap += 1;
    term *= x / ap;
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * EPSILON) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function upperContinuedFraction(a: number, x: number): number {
  // Modified Lentz. `TINY` stands in for a zero denominator, which the method is otherwise
  // undefined at and which does occur for the shapes in the ladder.
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/**
 * The mean a gamma on this volatility ladder needs in order to spike at `targetRate`.
 *
 * Used once, to convert the Vegas table - which is measured as spike rates, not as points -
 * into a points effect that a `Reason` can carry. Bisection rather than anything cleverer
 * because the function is monotone in the mean and this runs a handful of times at startup.
 */
export function meanForSpikeRate(
  targetRate: number,
  threshold: number,
  sdForMean: (mean: number) => number,
  bounds: readonly [number, number] = [MIN_MEAN_POINTS, 40],
): number {
  let [lo, hi] = bounds;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const rate = gammaSurvival(threshold, gammaFromMeanSd(mid, sdForMean(mid)));
    if (rate < targetRate) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
