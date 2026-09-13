import { beforeAll, describe, expect, it } from "vitest";
import { readSeasons } from "../../scripts/league.ts";
import { asOf } from "../../src/model/asof.ts";
import {
  LEVEL_DRIFT_POINTS,
  MAX_HELD_OUT_CALIBRATION_GAP,
  MEASURED_WITHIN_PLAYER_SD,
  VOLATILITY_LADDER,
} from "../../src/model/calibration.ts";
import {
  calibrationError,
  reliability,
  spikeLiftByDecile,
  walkForward,
  type Graded,
} from "../../src/model/backtest.ts";
import { gammaFromMeanSd, gammaSurvival } from "../../src/model/distribution.ts";
import { SPIKE_POINTS, type PlayerWeek } from "../../src/shared/player.ts";
import { sdForMean } from "../../src/model/volatility.ts";

/**
 * THE RECALIBRATION GUARD, against real football rather than against the model's own assumptions.
 *
 * Everything else in this suite checks that the model does what it says. This checks that what
 * it says is true, by re-measuring from the committed season files in `public/data` and grading
 * predictions on seasons the constants were not fitted on.
 *
 * It exists because of a defect that every other test in this repo passed straight through. The
 * simulator drew its spread from the measured ladder, which is the scatter of a player's weeks
 * around THAT PLAYER'S OWN SEASON MEAN. It is a correct measurement and the wrong quantity: the
 * model centres on an average of the games played so far, not on the season mean, and the
 * outcome scatters around an estimate more widely than around the truth. Every reliability band
 * under-promised, by +0.8 points of percentage at the bottom and +12.8 at the top, and nothing
 * in the suite noticed, because the synthetic league it was tested against had been built from
 * the same assumption.
 *
 * The positive control at the bottom of this file is the important part: it reruns the OLD
 * behaviour and asserts it fails the bar. Without that, a bar set too loosely would pass
 * silently forever.
 *
 * Fitted on 2022 and 2023. Graded on 2024 and 2025, which none of the constants have seen.
 */

const FIT_SEASONS = [2022, 2023];
const HELD_OUT_SEASONS = [2024, 2025];
/** The ladder check is a question about football, not about held-out prediction, so it uses the lot. */
const ALL_SEASONS = [...FIT_SEASONS, ...HELD_OUT_SEASONS];
const seasonPath = (year: number) => `public/data/season-${year}.json`;

const mean = (v: readonly number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const rms = (v: readonly number[]) => Math.sqrt(mean(v.map((x) => x * x)));
const sampleSd = (v: readonly number[]) => {
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1));
};

/** Fewest games before a player-season says anything about that player's own spread. */
const MIN_GAMES_FOR_A_SEASON = 8;

let allWeeks: PlayerWeek[] = [];
let heldOut: Graded[] = [];
let fitGraded: Graded[] = [];

beforeAll(() => {
  allWeeks = readSeasons(ALL_SEASONS.map(seasonPath)).weeks;
  fitGraded = walkForward(readSeasons(FIT_SEASONS.map(seasonPath)));
  heldOut = walkForward(readSeasons(HELD_OUT_SEASONS.map(seasonPath)));
}, 240_000);

describe("the ladder against the real seasons", () => {
  it("still describes the within-player spread it claims to", () => {
    // This is the check that settled which of two hypotheses was right when the calibration
    // defect turned up. The ladder is NOT fitted to the wrong quantity: bucket each
    // player-season by its own mean, take the sd of that player's own weeks, and the measured
    // numbers land on the tabulated ones. So the spec is right and the model's use of it was not.
    const byPlayerSeason = new Map<string, number[]>();
    for (const row of allWeeks) {
      const key = `${row.playerId}:${row.season}`;
      const points = byPlayerSeason.get(key) ?? [];
      points.push(row.points);
      byPlayerSeason.set(key, points);
    }
    const byTier: number[][] = VOLATILITY_LADDER.map(() => []);
    for (const points of byPlayerSeason.values()) {
      if (points.length < MIN_GAMES_FOR_A_SEASON) continue;
      const seasonMean = mean(points);
      const tier = VOLATILITY_LADDER.findIndex(
        (t) => seasonMean >= t.minMean && seasonMean < t.maxMean,
      );
      if (tier < 0) continue;
      byTier[tier]?.push(sampleSd(points));
    }
    VOLATILITY_LADDER.forEach((tier, i) => {
      const measured = byTier[i];
      expect(measured?.length ?? 0, `tier ${i} has no player-seasons`).toBeGreaterThan(50);
      if (!measured) return;
      const value = mean(measured);
      expect(value, `tier ${i}: measured ${value.toFixed(3)} against a ladder of ${tier.sd}`)
        .toBeCloseTo(tier.sd, 0);
      expect(value).toBeCloseTo(MEASURED_WITHIN_PLAYER_SD[i] ?? -1, 1);
    });
  });
});

describe("the level drift constant", () => {
  it("is what the data says it is, re-measured from the committed seasons", () => {
    // The one fitted number in the predictive spread. Everything else is arithmetic. If the data
    // is refreshed and this moves, the constant is stale and the page is mis-stating its odds.
    const games = gamesOfHistory(readSeasons(FIT_SEASONS.map(seasonPath)).weeks);
    const excess = fitGraded.map((g) => {
      const n = games.get(`${g.playerId}:${g.season}:${g.week}`) ?? 1;
      const ladder = sdForMean(g.mean, "WR");
      return (g.actual - g.mean) ** 2 - ladder * ladder * (1 + 1 / n);
    });
    const measured = Math.sqrt(Math.max(0, mean(excess)));
    expect(measured, `level drift re-measured at ${measured.toFixed(3)}`).toBeCloseTo(
      LEVEL_DRIFT_POINTS,
      1,
    );
  });

  it("is a constant addition in variance, not a multiplier, across the whole range", () => {
    // The reason it is carried in points rather than as an inflation factor. If this ever came
    // back trending with the centre, the shape of the fix would be wrong, not just its size.
    const edges = [3, 5, 7, 9, 11, 13, 15, 18];
    const implied: number[] = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i] ?? 0;
      const hi = edges[i + 1] ?? 0;
      const bucket = fitGraded.filter((g) => g.mean >= lo && g.mean < hi);
      if (bucket.length < 200) continue;
      const ladder = rms(bucket.map((g) => sdForMean(g.mean, "WR")));
      const residual = rms(bucket.map((g) => g.actual - g.mean));
      implied.push(Math.sqrt(Math.max(0, residual * residual - ladder * ladder)));
    }
    expect(implied.length).toBeGreaterThan(4);
    for (const value of implied) {
      expect(value, `implied drift of ${value.toFixed(2)} is outside the measured band`)
        .toBeGreaterThan(1.5);
      expect(value).toBeLessThan(4.5);
    }
  });
});

describe("calibration on seasons nothing was fitted on", () => {
  it("keeps the weighted mean gap inside the bar", () => {
    const gap = calibrationError(reliability(heldOut));
    expect(
      gap,
      `held-out weighted mean calibration gap ${(gap * 100).toFixed(2)}%`,
    ).toBeLessThan(MAX_HELD_OUT_CALIBRATION_GAP);
  });

  it("does not miss badly in any band that carries real weight", () => {
    // The thin top bands are excluded by weight rather than by name: at 30 per cent and above
    // there are under a hundred player-weeks in two seasons, and a band of that size can be five
    // points out on chance alone. Excluding them is stated here so it is not mistaken for the
    // model being good there.
    for (const row of reliability(heldOut)) {
      if (row.count < 200) continue;
      expect(
        Math.abs(row.observed - row.predicted),
        `band ${row.label}: said ${(row.predicted * 100).toFixed(1)}%, happened ${(row.observed * 100).toFixed(1)}%, n = ${row.count}`,
      ).toBeLessThan(0.06);
    }
  });

  it("orders players better than it prices them, which is the honest summary", () => {
    const deciles = spikeLiftByDecile(heldOut);
    expect(deciles).toHaveLength(10);
    const top = deciles[9];
    const bottom = deciles[0];
    expect(top?.lift ?? 0).toBeGreaterThan(3);
    expect(bottom?.observed ?? 1).toBeLessThan(0.02);
    // Monotone across the half of the range where the counts support the claim.
    for (let i = 6; i < deciles.length; i++) {
      expect(deciles[i]?.observed ?? 0).toBeGreaterThan(deciles[i - 1]?.observed ?? 0);
    }
  });

  it("THE POSITIVE CONTROL: the spread this replaced fails the bar it has to fail", () => {
    // Reruns the old behaviour on the same held-out rows: the ladder as the spread, with no
    // allowance for the centre being an estimate. If this ever passes, the bar above has gone
    // slack and this whole file has stopped meaning anything.
    const old = heldOut.map((g) => ({
      ...g,
      predictedSpike: gammaSurvival(
        SPIKE_POINTS,
        gammaFromMeanSd(Math.max(0.25, g.mean), sdForMean(g.mean, "WR")),
      ),
    }));
    const oldGap = calibrationError(reliability(old));
    const newGap = calibrationError(reliability(heldOut));
    expect(
      oldGap,
      `the old conditional spread scores ${(oldGap * 100).toFixed(2)}%, which should be outside the bar`,
    ).toBeGreaterThan(MAX_HELD_OUT_CALIBRATION_GAP);
    expect(newGap).toBeLessThan(oldGap);
  });

  it("and the old spread missed the SAME WAY in every band, which is the signature to remember", () => {
    // Not one bad bucket. A systematic under-promise that widened as the prediction rose, which
    // is what a distribution that is uniformly too narrow looks like from the outside.
    const old = heldOut.map((g) => ({
      ...g,
      predictedSpike: gammaSurvival(
        SPIKE_POINTS,
        gammaFromMeanSd(Math.max(0.25, g.mean), sdForMean(g.mean, "WR")),
      ),
    }));
    const populated = reliability(old).filter((r) => r.count >= 200);
    expect(populated.length).toBeGreaterThan(4);
    for (const row of populated) {
      expect(
        row.observed,
        `band ${row.label} should have under-promised under the old spread`,
      ).toBeGreaterThan(row.predicted);
    }
  });
});

/** Games of history behind each prediction, recomputed rather than trusted. */
function gamesOfHistory(weeks: readonly PlayerWeek[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const key of new Set(weeks.map((r) => `${r.season}:${r.week}`))) {
    const [season, week] = key.split(":").map(Number);
    if (season === undefined || week === undefined) continue;
    const window = asOf({ season, week }, weeks, []);
    const counts = new Map<string, number>();
    for (const row of window.weeks) {
      if (row.season !== season) continue;
      counts.set(row.playerId, (counts.get(row.playerId) ?? 0) + 1);
    }
    for (const [id, n] of counts) out.set(`${id}:${season}:${week}`, n);
  }
  return out;
}
