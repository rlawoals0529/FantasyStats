/**
 * Grading the model against weeks it had not seen, and the arithmetic behind the scorecard.
 *
 * This lives in `src/model` rather than in the script so it can be tested. A backtest that only
 * exists inside a CLI is a backtest nobody checks, and the failure mode here is not a crash - it
 * is a table of numbers that look fine and were computed from the future.
 *
 * The walk is strictly forward. Week N is predicted from an `AsOfWindow` cut at week N, the
 * actual result is fetched separately and only to grade with, and the two never meet in the same
 * function. `test/model/asof.test.ts` plants a poisoned future row and asserts the graded output
 * does not move.
 */

import type { PlayerWeek, Position } from "../shared/player.ts";
import { SPIKE_POINTS } from "../shared/player.ts";
import { asOf, type AsOfBoundary } from "./asof.ts";
import { outlookFor } from "./index.ts";
import type { KickoffFacts, TouchdownWeek } from "./inputs.ts";

/** One graded prediction: what was said beforehand, and what happened. */
export type Graded = {
  playerId: string;
  season: number;
  week: number;
  /** Probability of a spike the model gave before kickoff. */
  predictedSpike: number;
  /** The distribution's median, which is the figure the page leads a player card with. */
  p50: number;
  /** The distribution's centre, which is the RMSE-optimal point estimate of the two. */
  mean: number;
  /** The player's season average to date. The thing to beat. */
  baseline: number;
  /** What they actually scored. Used only here, never upstream of a prediction. */
  actual: number;
};

export type BacktestInput = {
  weeks: readonly PlayerWeek[];
  touchdowns?: readonly TouchdownWeek[];
  kickoffs?: readonly KickoffFacts[];
  /** First week to grade. Earlier weeks are history only, never predictions. */
  fromWeek?: number;
};

/**
 * Walk the season forward, predicting each week from the weeks before it.
 *
 * The roster for a week is taken from the rows that exist for that week, which is a convenience
 * of grading and NOT available before kickoff in real life - knowing who played is itself
 * information. It cannot leak into a prediction, because the roster only ever selects WHICH
 * players to grade; every number in the prediction comes out of the as-of window. It does mean
 * the scorecard is graded on players who were active, which flatters any model slightly and
 * flatters all of them equally, the baseline included.
 */
export function walkForward(input: BacktestInput): Graded[] {
  const { weeks, touchdowns = [], kickoffs = [], fromWeek = 5 } = input;
  const positions = new Map<string, Position>();
  for (const row of weeks) positions.set(row.playerId, row.position);

  const kickoffByKey = new Map<string, KickoffFacts>();
  for (const fact of kickoffs) {
    kickoffByKey.set(`${fact.playerId}:${fact.season}:${fact.week}`, fact);
  }

  const boundaries = [...new Set(weeks.map((r) => `${r.season}:${r.week}`))]
    .map((k) => {
      const [season, week] = k.split(":");
      return { season: Number(season), week: Number(week) };
    })
    .filter((b) => b.week >= fromWeek)
    .sort((a, b) => a.season - b.season || a.week - b.week);

  const graded: Graded[] = [];
  for (const boundary of boundaries) {
    const window = asOf(boundary, weeks, touchdowns);
    const actuals = weeks.filter((r) => r.season === boundary.season && r.week === boundary.week);
    for (const actual of actuals) {
      const position = positions.get(actual.playerId);
      if (!position) continue;
      const kickoff =
        kickoffByKey.get(`${actual.playerId}:${boundary.season}:${boundary.week}`) ?? null;
      const sim = outlookFor(window, actual.playerId, position, kickoff);
      if (!sim) continue;
      const baseline = baselineFor(window, actual.playerId);
      if (baseline === null) continue;
      graded.push({
        playerId: actual.playerId,
        season: boundary.season,
        week: boundary.week,
        predictedSpike: sim.outlook.spike,
        p50: sim.outlook.p50,
        mean: sim.params.shape * sim.params.scale,
        baseline,
        actual: actual.points,
      });
    }
  }
  return graded;
}

function baselineFor(
  window: ReturnType<typeof asOf>,
  playerId: string,
): number | null {
  const rows = window.weeks.filter(
    (r) => r.playerId === playerId && r.season === window.boundary.season,
  );
  if (rows.length === 0) return null;
  return rows.reduce((a, r) => a + r.points, 0) / rows.length;
}

// ---------------------------------------------------------------------------------------------
// Calibration.
// ---------------------------------------------------------------------------------------------

export type ReliabilityRow = {
  label: string;
  lower: number;
  upper: number;
  count: number;
  /** Mean probability the model gave in this bin. */
  predicted: number;
  /** Share of those player-weeks that actually spiked. */
  observed: number;
};

/** The bin edges the reliability table uses. Fine at the bottom, where most of the mass is. */
export const RELIABILITY_EDGES: readonly number[] = [0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1];

/**
 * Did 20 per cent happen 20 per cent of the time?
 *
 * This is the only question this project can be held to, because it is the only one it makes a
 * claim about. A projection site that says 12.4 can always say the week was unlucky; a site that
 * says 20 per cent, a thousand times, cannot.
 *
 * Empty bins are kept in the table rather than dropped. A gap in a reliability curve is
 * information - it says the model never made that claim - and silently omitting the row makes a
 * sparse curve look complete.
 */
export function reliability(
  graded: readonly Graded[],
  edges: readonly number[] = RELIABILITY_EDGES,
  threshold: number = SPIKE_POINTS,
): ReliabilityRow[] {
  const rows: ReliabilityRow[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lower = edges[i] ?? 0;
    const upper = edges[i + 1] ?? 1;
    const isLast = i === edges.length - 2;
    const inBin = graded.filter(
      (g) => g.predictedSpike >= lower && (isLast ? g.predictedSpike <= upper : g.predictedSpike < upper),
    );
    rows.push({
      label: `${(lower * 100).toFixed(0)} to ${(upper * 100).toFixed(0)}%`,
      lower,
      upper,
      count: inBin.length,
      predicted: inBin.length ? average(inBin.map((g) => g.predictedSpike)) : 0,
      observed: inBin.length ? average(inBin.map((g) => (g.actual >= threshold ? 1 : 0))) : 0,
    });
  }
  return rows;
}

/**
 * Mean absolute gap between what was promised and what happened, weighted by how often each
 * claim was made. One number for "is this calibrated", to sit under the table.
 */
export function calibrationError(rows: readonly ReliabilityRow[]): number {
  const total = rows.reduce((a, r) => a + r.count, 0);
  if (total === 0) return 0;
  return rows.reduce((a, r) => a + r.count * Math.abs(r.predicted - r.observed), 0) / total;
}

export type DecileRow = {
  decile: number;
  count: number;
  predicted: number;
  observed: number;
  /** Observed rate over the whole sample's rate. 1.0 means the ranking bought nothing. */
  lift: number;
};

/**
 * Spike rate by predicted decile, which asks a different question from calibration: not "is the
 * number right" but "does the ORDER carry information". A model can be badly calibrated and
 * still usefully ranked, and vice versa, and a lineup decision only needs the second one.
 *
 * Ties are broken on the player-week key rather than left to the sort's stability, so the table
 * is reproducible across engines.
 */
export function spikeLiftByDecile(
  graded: readonly Graded[],
  threshold: number = SPIKE_POINTS,
): DecileRow[] {
  if (graded.length === 0) return [];
  const sorted = [...graded].sort(
    (a, b) =>
      a.predictedSpike - b.predictedSpike ||
      `${a.playerId}:${a.season}:${a.week}`.localeCompare(`${b.playerId}:${b.season}:${b.week}`),
  );
  const overall = average(sorted.map((g) => (g.actual >= threshold ? 1 : 0)));
  const rows: DecileRow[] = [];
  for (let d = 0; d < 10; d++) {
    const start = Math.floor((d * sorted.length) / 10);
    const end = Math.floor(((d + 1) * sorted.length) / 10);
    const slice = sorted.slice(start, end);
    if (slice.length === 0) continue;
    const observed = average(slice.map((g) => (g.actual >= threshold ? 1 : 0)));
    rows.push({
      decile: d + 1,
      count: slice.length,
      predicted: average(slice.map((g) => g.predictedSpike)),
      observed,
      lift: overall > 0 ? observed / overall : 0,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Point-estimate error, against the baseline that is expected to win.
// ---------------------------------------------------------------------------------------------

export type ErrorMetrics = { rmse: number; mae: number; n: number };

export function errorMetrics(
  graded: readonly Graded[],
  predict: (g: Graded) => number,
): ErrorMetrics {
  if (graded.length === 0) return { rmse: 0, mae: 0, n: 0 };
  let squared = 0;
  let absolute = 0;
  for (const g of graded) {
    const error = predict(g) - g.actual;
    squared += error * error;
    absolute += Math.abs(error);
  }
  return {
    rmse: Math.sqrt(squared / graded.length),
    mae: absolute / graded.length,
    n: graded.length,
  };
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
