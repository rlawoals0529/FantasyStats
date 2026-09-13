/**
 * What the simulation is centred on, and how wide the Vegas line makes it.
 *
 * THE STARTING POINT IS THE BASELINE, AND THAT IS NOT MODESTY. CONCEPT.md put a fitted model on
 * past points, target share, WOPR and the Vegas line against the player's season average to
 * date: RMSE 6.119 against 6.208, so 1.4 per cent better, and MAE 4.426 against 4.373, so WORSE.
 * A cleverer centre is not available. What is available is a handful of small measured
 * adjustments, each worth about a point, and the honest thing to do is apply exactly those and
 * nothing else.
 *
 * So every adjustment below is in `calibration.ts` with its measurement attached, every one of
 * them emits a `Reason` carrying its own effect size, and there is no term here that somebody
 * thought sounded right.
 */

import type { Position, Reason } from "../shared/player.ts";
import { SPIKE_POINTS } from "../shared/player.ts";
import type { AsOfBoundary, AsOfWindow } from "./asof.ts";
import {
  IMPLIED_TOTAL_BASIS,
  IMPLIED_TOTAL_HIGH,
  IMPLIED_TOTAL_LOW,
  IMPLIED_TOTAL_REFERENCE,
  INJURY_BASIS_MEASURED,
  INJURY_BASIS_UNMEASURED,
  INJURY_EFFECT,
  OPPORTUNITY_GAP_BASIS_INTERPOLATED,
  OPPORTUNITY_GAP_BASIS_MEASURED,
  OPPORTUNITY_GAP_EFFECT,
  SOURCE,
  TOUCHDOWN_LUCK_BASIS,
  TOUCHDOWN_LUCK_EFFECT,
} from "./calibration.ts";
import { gammaFromMeanSd, gammaSurvival, meanForSpikeRate, MIN_MEAN_POINTS } from "./distribution.ts";
import {
  gamesPlayed,
  opportunityGap,
  opportunityGapQuartile,
  seasonAverage,
  touchdownLuck,
  touchdownLuckTercile,
} from "./features.ts";
import type { KickoffFacts } from "./inputs.ts";
import { sdForMean } from "./volatility.ts";

/** Below this spike probability there are no odds worth scaling. See `applyImpliedTotal`. */
const MIN_SPIKE_RATE_TO_SCALE = 1e-4;
/** A spike probability the bisection can actually reach without an unbounded spread. */
const MAX_SPIKE_RATE = 0.95;

/** The centre and width the simulator draws from, with the working shown. */
export type ExpectedOutcome = {
  playerId: string;
  position: Position;
  /** The week this is an outlook FOR. Carried so the simulator can seed from it. */
  boundary: AsOfBoundary;
  /** Where the distribution sits, in points. Always at least `MIN_MEAN_POINTS`. */
  mean: number;
  /** Multiplier on the volatility ladder's sd. 1 unless the Vegas line says otherwise. */
  sdMultiplier: number;
  /** Every input that moved it, in the order they were applied. */
  reasons: Reason[];
};

/**
 * The centre for one player in one week, or null when there is not enough history to speak.
 *
 * Null rather than a default. A player with two games has no season average worth the name, and
 * the page would rather show nothing than show a distribution built on a guess, which is the
 * same rule the rest of this project runs on.
 */
export function expectedOutcome(
  window: AsOfWindow,
  playerId: string,
  position: Position,
  kickoff: KickoffFacts | null,
): ExpectedOutcome | null {
  if (kickoff) assertKickoffMatchesBoundary(window, playerId, kickoff);

  const baseline = seasonAverage(window, playerId);
  if (baseline === null) return null;
  const games = gamesPlayed(window, playerId) ?? 0;

  const reasons: Reason[] = [
    {
      label: "season average to date",
      value: `${baseline.toFixed(1)} ppg over ${games} games`,
      effect: baseline,
      basis: `the baseline a fitted model could not beat: RMSE 6.208 against the model's 6.119, and the model's MAE is worse at 4.426 against 4.373 (${SOURCE})`,
    },
  ];

  let centre = baseline;
  centre += applyOpportunityGap(window, playerId, reasons);
  centre += applyTouchdownLuck(window, playerId, reasons);
  centre += applyInjury(kickoff, reasons);
  // Clamped BEFORE the Vegas step, which reads the centre to work out the player's own spike odds.
  const mean = Math.max(MIN_MEAN_POINTS, centre);

  const sdMultiplier = applyImpliedTotal(kickoff, mean, position, reasons);

  return { playerId, position, boundary: window.boundary, mean, sdMultiplier, reasons };
}

function applyOpportunityGap(window: AsOfWindow, playerId: string, reasons: Reason[]): number {
  const quartile = opportunityGapQuartile(window, playerId);
  const gap = opportunityGap(window, playerId);
  if (quartile === null || gap === null) return 0;
  const effect = OPPORTUNITY_GAP_EFFECT[quartile as 0 | 1 | 2 | 3];
  const isMeasuredEnd = quartile === 0 || quartile === OPPORTUNITY_GAP_EFFECT.length - 1;
  reasons.push({
    label: "opportunity gap",
    value: `${gap >= 0 ? "+" : ""}${gap.toFixed(2)} ppg against what the opportunity buys, quartile ${quartile + 1} of 4`,
    effect,
    basis: isMeasuredEnd ? OPPORTUNITY_GAP_BASIS_MEASURED : OPPORTUNITY_GAP_BASIS_INTERPOLATED,
  });
  return effect;
}

function applyTouchdownLuck(window: AsOfWindow, playerId: string, reasons: Reason[]): number {
  const tercile = touchdownLuckTercile(window, playerId);
  const luck = touchdownLuck(window, playerId);
  if (tercile === null || luck === null) return 0;
  const band = tercile === 0 ? "cold" : tercile === 2 ? "hot" : "neutral";
  const effect = TOUCHDOWN_LUCK_EFFECT[band];
  reasons.push({
    label: "touchdown rate against expectation",
    value: `${band}, ${luck >= 0 ? "+" : ""}${luck.toFixed(2)} touchdowns per game against what the opportunity implies`,
    effect,
    basis: TOUCHDOWN_LUCK_BASIS,
  });
  return effect;
}

/**
 * The injury adjustment, and the sign that looks wrong and is not.
 *
 * Questionable costs a point against the player's OWN baseline. The raw comparison across
 * players runs the other way because only players worth worrying about get listed. See
 * `INJURY_EFFECT` in `calibration.ts` before changing anything here.
 */
function applyInjury(kickoff: KickoffFacts | null, reasons: Reason[]): number {
  if (!kickoff) return 0;
  const status = kickoff.injuryStatus;
  const effect = status === null ? INJURY_EFFECT.unlisted : INJURY_EFFECT[status];
  const measured = status === null || status === "Questionable";
  reasons.push({
    label: "injury designation",
    value: status ?? "unlisted",
    effect,
    basis: measured ? INJURY_BASIS_MEASURED : INJURY_BASIS_UNMEASURED,
  });
  return effect;
}

/**
 * The Vegas line, applied to the SPREAD rather than to the mean, which is the whole finding.
 *
 * CONCEPT.md's row is titled "Vegas predicts spikes, not means", and the table under it is a
 * table of spike rates - 3.5 per cent under an implied total of 17, 10.1 per cent at 26 or more.
 * It is not a table of points. Shifting the centre with it would be applying an effect that the
 * same measurement reports as absent, so instead it widens or narrows the distribution until the
 * player's own spike odds have moved by the measured ratio for that bucket.
 *
 * Ratio rather than level, and that matters. The 3.5 and the 10.1 are population averages over
 * every player in the bucket, and the population's spike rate is not any one player's: a 17 ppg
 * player spikes 31 per cent of the time and a 2.5 ppg player 0.1 per cent, so "set this player to
 * 10.1 per cent" would be nonsense in both directions. What transfers is the ratio between the
 * buckets, referenced to the middle of the measured range.
 *
 * The `Reason` still carries a points figure, because `Reason.effect` is denominated in ppg and
 * a panel has to rank reasons against each other. That figure is the points-equivalent: the
 * shift of the centre that would have produced the same change in spike odds. The `basis` string
 * says so, so it is not read as a projection of extra points.
 */
function applyImpliedTotal(
  kickoff: KickoffFacts | null,
  mean: number,
  position: Position,
  reasons: Reason[],
): number {
  const total = kickoff?.impliedTeamTotal ?? null;
  if (total === null) return 1;

  const ratio =
    spikeRateForImpliedTotal(total) / spikeRateForImpliedTotal(IMPLIED_TOTAL_REFERENCE);
  const ladder = (m: number) => sdForMean(m, position);
  const baseSd = ladder(mean);
  const baseRate = gammaSurvival(SPIKE_POINTS, gammaFromMeanSd(mean, baseSd));

  // A player whose centre is far enough below the spike threshold has no spike odds to scale,
  // and bisecting towards a target of ~0 would collapse the spread instead. Say so and stop.
  if (baseRate < MIN_SPIKE_RATE_TO_SCALE) {
    reasons.push({
      label: "implied team total",
      value: `${total.toFixed(1)} implied points, not applied`,
      effect: 0,
      basis: `the measured effect is a ratio on spike odds and this player's are below ${MIN_SPIKE_RATE_TO_SCALE}, so scaling them would move the spread without moving the spike rate (${SOURCE})`,
    });
    return 1;
  }

  const targetRate = Math.min(MAX_SPIKE_RATE, baseRate * ratio);
  const multiplier = sdMultiplierForSpikeRate(targetRate, mean, baseSd);
  const pointsEquivalent = meanForSpikeRate(targetRate, SPIKE_POINTS, ladder) - mean;

  reasons.push({
    label: "implied team total",
    value: `${total.toFixed(1)} implied points, spike odds ${ratio >= 1 ? "up" : "down"} ${(Math.abs(ratio - 1) * 100).toFixed(0)} per cent against a ${IMPLIED_TOTAL_REFERENCE}-point reference`,
    effect: pointsEquivalent,
    basis: IMPLIED_TOTAL_BASIS,
  });
  return multiplier;
}

/**
 * Spike rate for an implied total, from the two measured ends.
 *
 * Log-linear between them, because a rate is positive and bounded and multiplicative
 * interpolation cannot walk it through zero. Flat outside them: 17 and 26 are where the
 * measurement stops, and a 33-point implied total is not licence to extrapolate the slope.
 * The interior of the curve is NOT measured, only its ends.
 */
export function spikeRateForImpliedTotal(total: number): number {
  const { total: lowTotal, spikeRate: lowRate } = IMPLIED_TOTAL_LOW;
  const { total: highTotal, spikeRate: highRate } = IMPLIED_TOTAL_HIGH;
  if (total <= lowTotal) return lowRate;
  if (total >= highTotal) return highRate;
  const t = (total - lowTotal) / (highTotal - lowTotal);
  return lowRate * Math.pow(highRate / lowRate, t);
}

/** The sd multiplier that makes a league-average player spike at `targetRate`. Bisection. */
function sdMultiplierForSpikeRate(targetRate: number, mean: number, baseSd: number): number {
  let lo = 0.25;
  let hi = 4;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const rate = gammaSurvival(SPIKE_POINTS, gammaFromMeanSd(mean, baseSd * mid));
    if (rate < targetRate) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Loud rather than silent. A kickoff row for the wrong week is leakage if it is a later one and
 * a stale line if it is an earlier one, and both of those are bugs that a null check would have
 * turned into a slightly-off number nobody ever notices.
 */
function assertKickoffMatchesBoundary(
  window: AsOfWindow,
  playerId: string,
  kickoff: KickoffFacts,
): void {
  const { season, week } = window.boundary;
  if (kickoff.playerId !== playerId || kickoff.season !== season || kickoff.week !== week) {
    throw new Error(
      `kickoff facts are for ${kickoff.playerId} ${kickoff.season} week ${kickoff.week}, ` +
        `but the outlook is for ${playerId} ${season} week ${week}`,
    );
  }
}
