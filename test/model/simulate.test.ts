import { describe, expect, it } from "vitest";
import { DRAWS_PER_PLAYER } from "../../src/model/calibration.ts";
import { gammaFromMeanSd } from "../../src/model/distribution.ts";
import type { ExpectedOutcome } from "../../src/model/expected.ts";
import {
  paramsFor,
  quantile,
  rateAtOrAbove,
  rateAtOrBelow,
  seedForPlayerWeek,
  simulate,
  simulateMean,
  TYPICAL_GAMES_OF_HISTORY,
} from "../../src/model/simulate.ts";
import { BUST_POINTS, SPIKE_POINTS } from "../../src/shared/player.ts";
import { predictiveSdFor, sdForMean } from "../../src/model/volatility.ts";

const BOUNDARY = { season: 2024, week: 9 };

function outcome(overrides: Partial<ExpectedOutcome> = {}): ExpectedOutcome {
  return {
    playerId: "A",
    position: "WR",
    boundary: BOUNDARY,
    mean: 12,
    sdMultiplier: 1,
    games: TYPICAL_GAMES_OF_HISTORY,
    reasons: [],
    ...overrides,
  };
}

describe("determinism", () => {
  it("gives byte-identical draws for the same player-week, twice", () => {
    // Without this, no test of the simulator means anything and no screenshot of the page can be
    // reproduced when a user asks why the number changed.
    const a = simulate(outcome());
    const b = simulate(outcome());
    expect(Array.from(a.draws)).toEqual(Array.from(b.draws));
    expect(a.outlook).toEqual(b.outlook);
  });

  it("does not depend on who else was in the slate", () => {
    // The seed is keyed on the player and the week, never on a loop counter. A counter is
    // perfectly deterministic in a test, where the input is a fixed array, and quietly different
    // in production, where the slate is filtered.
    expect(seedForPlayerWeek(BOUNDARY, "A")).toBe(seedForPlayerWeek(BOUNDARY, "A"));
    expect(seedForPlayerWeek(BOUNDARY, "A")).not.toBe(seedForPlayerWeek(BOUNDARY, "B"));
    expect(seedForPlayerWeek(BOUNDARY, "A")).not.toBe(
      seedForPlayerWeek({ season: 2024, week: 10 }, "A"),
    );
  });

  it("gives different players different draws", () => {
    const a = simulate(outcome({ playerId: "A" }));
    const b = simulate(outcome({ playerId: "B" }));
    expect(Array.from(a.draws)).not.toEqual(Array.from(b.draws));
  });
});

describe("the Outlook it builds", () => {
  const sim = simulate(outcome({ mean: 12 }));

  it("draws the production count", () => {
    expect(sim.draws.length).toBe(DRAWS_PER_PLAYER);
  });

  it("orders the quantiles and keeps them non-negative", () => {
    expect(sim.outlook.p10).toBeGreaterThanOrEqual(0);
    expect(sim.outlook.p10).toBeLessThan(sim.outlook.p50);
    expect(sim.outlook.p50).toBeLessThan(sim.outlook.p90);
  });

  it("puts the median below the mean, because the family is right-skewed", () => {
    expect(sim.outlook.p50).toBeLessThan(12);
  });

  it("uses the contract's thresholds, inclusive on both, as the contract says", () => {
    const draws = Array.from(sim.draws);
    expect(sim.outlook.spike).toBeCloseTo(
      draws.filter((d) => d >= SPIKE_POINTS).length / draws.length,
      12,
    );
    expect(sim.outlook.bust).toBeCloseTo(
      draws.filter((d) => d <= BUST_POINTS).length / draws.length,
      12,
    );
  });

  it("carries the reasons through untouched", () => {
    const reasons = [{ label: "x", value: "y", effect: 1.5, basis: "z" }];
    expect(simulate(outcome({ reasons })).outlook.because).toEqual(reasons);
  });

  it("refuses a draw count that is not a positive integer", () => {
    expect(() => simulate(outcome(), 0)).toThrow(/positive integer/);
    expect(() => simulate(outcome(), 2.5)).toThrow(/positive integer/);
  });
});

describe("paramsFor", () => {
  it("takes the centre from the model and the PREDICTIVE spread, not the ladder", () => {
    // The ladder is the scatter around a season mean nobody knows yet. Drawing with it is what
    // made every spike probability on the page too low against 23,510 real player-weeks.
    const games = TYPICAL_GAMES_OF_HISTORY;
    expect(paramsFor(outcome({ mean: 12 }))).toEqual(
      gammaFromMeanSd(12, predictiveSdFor(12, "WR", games)),
    );
    expect(predictiveSdFor(12, "WR", games)).toBeGreaterThan(sdForMean(12, "WR"));
  });

  it("widens the spread when the centre rests on fewer games", () => {
    const sdOf = (p: { shape: number; scale: number }) => Math.sqrt(p.shape) * p.scale;
    expect(sdOf(paramsFor(outcome({ games: 3 })))).toBeGreaterThan(
      sdOf(paramsFor(outcome({ games: 14 }))),
    );
  });

  it("applies the Vegas multiplier to the spread and leaves the mean alone", () => {
    const widened = paramsFor(outcome({ mean: 12, sdMultiplier: 1.2 }));
    expect(widened.shape * widened.scale).toBeCloseTo(12, 9);
    expect(Math.sqrt(widened.shape) * widened.scale).toBeCloseTo(
      predictiveSdFor(12, "WR", TYPICAL_GAMES_OF_HISTORY) * 1.2,
      9,
    );
  });

  it("widens the spike as it widens the spread, which is what the Vegas row claims", () => {
    const flat = simulate(outcome({ mean: 12, sdMultiplier: 1 }));
    const wide = simulate(outcome({ mean: 12, sdMultiplier: 1.25 }));
    expect(wide.outlook.spike).toBeGreaterThan(flat.outlook.spike);
    expect(wide.outlook.bust).toBeGreaterThan(flat.outlook.bust);
  });
});

describe("quantile", () => {
  it("interpolates between order statistics, the R type 7 convention", () => {
    const sorted = Float64Array.from([0, 1, 2, 3, 4]);
    expect(quantile(sorted, 0)).toBe(0);
    expect(quantile(sorted, 0.5)).toBe(2);
    expect(quantile(sorted, 1)).toBe(4);
    expect(quantile(sorted, 0.25)).toBe(1);
    expect(quantile(sorted, 0.375)).toBeCloseTo(1.5, 9);
  });

  it("throws on an empty sample rather than returning zero", () => {
    expect(() => quantile(new Float64Array(0), 0.5)).toThrow(/empty sample/);
  });
});

describe("rate helpers", () => {
  const sorted = Float64Array.from([1, 2, 3, 4, 5, 20, 21]);

  it("counts at-or-above inclusively", () => {
    expect(rateAtOrAbove(sorted, 20)).toBeCloseTo(2 / 7, 12);
    expect(rateAtOrAbove(sorted, 21)).toBeCloseTo(1 / 7, 12);
    expect(rateAtOrAbove(sorted, 22)).toBe(0);
    expect(rateAtOrAbove(sorted, 0)).toBe(1);
  });

  it("counts at-or-below inclusively", () => {
    expect(rateAtOrBelow(sorted, 5)).toBeCloseTo(5 / 7, 12);
    expect(rateAtOrBelow(sorted, 0)).toBe(0);
    expect(rateAtOrBelow(sorted, 100)).toBe(1);
  });
});

describe("simulateMean", () => {
  it("is the same thing as simulate with no adjustments", () => {
    expect(Array.from(simulateMean("A", "WR", 12, BOUNDARY).draws)).toEqual(
      Array.from(simulate(outcome({ mean: 12 })).draws),
    );
  });
});
