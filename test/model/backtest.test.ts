import { describe, expect, it } from "vitest";
import {
  calibrationError,
  errorMetrics,
  reliability,
  RELIABILITY_EDGES,
  quantileCoverage,
  spikeLiftByDecile,
  walkForward,
  type Graded,
} from "../../src/model/backtest.ts";
import { report, syntheticLeague } from "../../scripts/backtest.ts";
import { SPIKE_POINTS } from "../../src/shared/player.ts";

function graded(rows: readonly Partial<Graded>[]): Graded[] {
  return rows.map((row, i) => ({
    playerId: row.playerId ?? `P${i}`,
    season: row.season ?? 2024,
    week: row.week ?? 9,
    predictedSpike: row.predictedSpike ?? 0,
    p50: row.p50 ?? 0,
    p10: row.p10 ?? 0,
    p90: row.p90 ?? 0,
    mean: row.mean ?? 0,
    baseline: row.baseline ?? 0,
    actual: row.actual ?? 0,
  }));
}

describe("reliability", () => {
  it("bins on the predicted probability and counts what actually happened", () => {
    const rows = reliability(
      graded([
        { predictedSpike: 0.01, actual: 0 },
        { predictedSpike: 0.015, actual: 25 },
        { predictedSpike: 0.22, actual: 30 },
        { predictedSpike: 0.25, actual: 4 },
      ]),
    );
    const low = rows.find((r) => r.label === "0 to 2%");
    const high = rows.find((r) => r.label === "20 to 30%");
    expect(low?.count).toBe(2);
    expect(low?.predicted).toBeCloseTo(0.0125, 9);
    expect(low?.observed).toBeCloseTo(0.5, 9);
    expect(high?.count).toBe(2);
    expect(high?.observed).toBeCloseTo(0.5, 9);
  });

  it("keeps empty bins in the table, because a gap in a curve is information", () => {
    const rows = reliability(graded([{ predictedSpike: 0.01, actual: 0 }]));
    expect(rows).toHaveLength(RELIABILITY_EDGES.length - 1);
    expect(rows.filter((r) => r.count === 0).length).toBe(rows.length - 1);
  });

  it("puts a prediction of exactly 1 in the top bin rather than dropping it off the end", () => {
    const rows = reliability(graded([{ predictedSpike: 1, actual: 30 }]));
    expect(rows[rows.length - 1]?.count).toBe(1);
  });

  it("uses the contract's spike threshold to decide what happened", () => {
    const justUnder = reliability(graded([{ predictedSpike: 0.3, actual: SPIKE_POINTS - 0.1 }]));
    const exactly = reliability(graded([{ predictedSpike: 0.3, actual: SPIKE_POINTS }]));
    expect(justUnder.find((r) => r.count === 1)?.observed).toBe(0);
    expect(exactly.find((r) => r.count === 1)?.observed).toBe(1);
  });
});

describe("calibrationError", () => {
  it("weights each bin by how often the claim was made", () => {
    const rows = [
      { label: "a", lower: 0, upper: 1, count: 90, predicted: 0.1, observed: 0.1 },
      { label: "b", lower: 0, upper: 1, count: 10, predicted: 0.5, observed: 0.7 },
    ];
    // 90 claims dead on, 10 claims out by 0.2, so 0.02 overall and not 0.1.
    expect(calibrationError(rows)).toBeCloseTo(0.02, 9);
  });

  it("is 0 on an empty table rather than NaN", () => {
    expect(calibrationError([])).toBe(0);
  });
});

describe("spikeLiftByDecile", () => {
  it("splits on the predicted probability and reports the lift against the whole sample", () => {
    // 100 rows, the top 10 of which all spike and none of the others do. The top decile's
    // observed rate is 1.0 against an overall 0.1, so the lift is 10x.
    const rows = spikeLiftByDecile(
      graded(
        Array.from({ length: 100 }, (_, i) => ({
          playerId: `P${String(i).padStart(3, "0")}`,
          predictedSpike: i / 100,
          actual: i >= 90 ? 25 : 3,
        })),
      ),
    );
    expect(rows).toHaveLength(10);
    expect(rows[9]?.observed).toBe(1);
    expect(rows[9]?.lift).toBeCloseTo(10, 9);
    expect(rows[0]?.observed).toBe(0);
  });

  it("is empty on no input rather than dividing by zero", () => {
    expect(spikeLiftByDecile([])).toEqual([]);
  });

  it("breaks ties on the player-week key, so the table does not move between runs", () => {
    const flat = graded(
      Array.from({ length: 40 }, (_, i) => ({
        playerId: `P${String(i).padStart(3, "0")}`,
        predictedSpike: 0.1,
        actual: i % 2 ? 25 : 1,
      })),
    );
    expect(spikeLiftByDecile(flat)).toEqual(spikeLiftByDecile([...flat].reverse()));
  });
});

describe("quantileCoverage", () => {
  it("counts how often the actual came in at or below each published quantile", () => {
    // Four rows, p10 of 5 throughout: one actual at or below it, so 25 per cent coverage
    // against a published 10 per cent, which is the model over-covering its own floor.
    const rows = graded([
      { p10: 5, p50: 10, p90: 20, actual: 4 },
      { p10: 5, p50: 10, p90: 20, actual: 11 },
      { p10: 5, p50: 10, p90: 20, actual: 15 },
      { p10: 5, p50: 10, p90: 20, actual: 25 },
    ]);
    const coverage = quantileCoverage(rows);
    expect(coverage.map((c) => c.label)).toEqual(["p10", "p50", "p90"]);
    expect(coverage[0]?.covered).toBeCloseTo(0.25, 9);
    expect(coverage[1]?.covered).toBeCloseTo(0.25, 9);
    expect(coverage[2]?.covered).toBeCloseTo(0.75, 9);
  });

  it("is inclusive at the boundary, the same as the spike and bust thresholds", () => {
    expect(quantileCoverage(graded([{ p10: 5, p50: 5, p90: 5, actual: 5 }]))[0]?.covered).toBe(1);
  });

  it("is empty on no input rather than dividing by zero", () => {
    expect(quantileCoverage([])).toEqual([]);
  });
});

describe("errorMetrics", () => {
  it("computes RMSE and MAE off whichever estimator it is handed", () => {
    const rows = graded([
      { baseline: 10, mean: 12, actual: 10 },
      { baseline: 10, mean: 6, actual: 14 },
    ]);
    expect(errorMetrics(rows, (g) => g.baseline)).toEqual({
      rmse: Math.sqrt((0 + 16) / 2),
      mae: 2,
      n: 2,
    });
    expect(errorMetrics(rows, (g) => g.mean)).toEqual({
      rmse: Math.sqrt((4 + 64) / 2),
      mae: 5,
      n: 2,
    });
  });

  it("returns zeroes and an n of 0 on no input, so a caller cannot print a NaN", () => {
    expect(errorMetrics([], (g) => g.mean)).toEqual({ rmse: 0, mae: 0, n: 0 });
  });
});

describe("the walk itself", () => {
  // Small on purpose. The generator and the walk are the same code the script runs; only the
  // league size differs, and 10,000 draws per player-week makes a full-size walk a 30-second
  // test, which is a test people start skipping.
  const league = syntheticLeague(4242, { players: 60, weeks: 14 });
  const walked = walkForward(league);

  it("is deterministic, league and all", () => {
    expect(syntheticLeague(4242, { players: 60, weeks: 14 }).weeks).toEqual(league.weeks);
    expect(walkForward(league)).toEqual(walked);
  });

  it("grades nothing before the week it is told to start at", () => {
    const rows = walkForward({ ...league, fromWeek: 6 });
    expect(rows.length).toBeGreaterThan(0);
    expect(Math.min(...rows.map((r) => r.week))).toBeGreaterThanOrEqual(6);
  });

  it("grades every prediction against a real result and a real baseline", () => {
    const rows = walked;
    expect(rows.length).toBeGreaterThan(500);
    for (const row of rows) {
      expect(row.predictedSpike).toBeGreaterThanOrEqual(0);
      expect(row.predictedSpike).toBeLessThanOrEqual(1);
      expect(row.baseline).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(row.actual)).toBe(true);
    }
  });

  it("is calibrated to within a few points of percentage across the table", () => {
    // Against a synthetic league whose weekly points are zero-inflated lognormal with a drifting
    // mean - deliberately NOT the family the model draws from. This grades the machinery, not
    // the model against football, and the banner on the script says so on every run.
    const rows = reliability(walked);
    expect(calibrationError(rows)).toBeLessThan(0.05);
  });

  it("ranks: the top decile spikes far more often than the bottom", () => {
    const deciles = spikeLiftByDecile(walked);
    expect(deciles[9]?.observed ?? 0).toBeGreaterThan((deciles[0]?.observed ?? 0) + 0.1);
    expect(deciles[9]?.lift ?? 0).toBeGreaterThan(2);
  });

  it("renders a report without throwing, including the verdict line", () => {
    const lines: string[] = [];
    report(walked, (s) => lines.push(s));
    const text = lines.join("\n");
    expect(text).toContain("CALIBRATION");
    expect(text).toContain("SPIKE RATE BY PREDICTED DECILE");
    expect(text).toContain("POINT ESTIMATE");
    expect(text).toContain("VERDICT");
    expect(text).not.toContain("NaN");
  });
});
