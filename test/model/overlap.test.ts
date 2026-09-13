import { describe, expect, it } from "vitest";
import { gammaFromMeanSd } from "../../src/model/distribution.ts";
import { findTies, isSeparable, overlapOfGammas, overlapOfSamples } from "../../src/model/overlap.ts";
import { simulateMean, type Simulation } from "../../src/model/simulate.ts";
import { SEPARABLE_OVERLAP } from "../../src/shared/player.ts";
import { sdForMean } from "../../src/model/volatility.ts";

const BOUNDARY = { season: 2024, week: 9 };

/** A distribution as the model would actually build it: mean from the model, spread from the ladder. */
const atLadder = (mean: number) => gammaFromMeanSd(mean, sdForMean(mean, "WR"));

describe("overlapOfGammas", () => {
  it("is 1 for two identical distributions", () => {
    const params = gammaFromMeanSd(10, 6.4);
    expect(overlapOfGammas(params, params)).toBeCloseTo(1, 6);
  });

  it("is near 0 for two that barely meet", () => {
    expect(overlapOfGammas(gammaFromMeanSd(1, 1.16), gammaFromMeanSd(40, 8.42))).toBeLessThan(0.02);
  });

  it("falls as the means separate, and never leaves [0, 1]", () => {
    let previous = 1.01;
    for (const mean of [10, 11, 12, 14, 17, 21, 26]) {
      const value = overlapOfGammas(atLadder(10), atLadder(mean));
      expect(value).toBeLessThan(previous);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      previous = value;
    }
  });

  it("is symmetric", () => {
    const a = gammaFromMeanSd(8, 6);
    const b = gammaFromMeanSd(13, 7.2);
    expect(overlapOfGammas(a, b)).toBeCloseTo(overlapOfGammas(b, a), 9);
  });

  it("refuses to rank two players about three points apart, which is most of a ranking page", () => {
    // Measured off this model, not asserted: at the volatility the ladder gives, the overlap
    // crosses SEPARABLE_OVERLAP at a gap of roughly 3.3 points per game. Two points apart is a
    // tie; four points apart can be ordered. That is the concrete meaning of "at CV 0.82 the
    // seventh and eleventh ranked players are routinely indistinguishable", and it is why the
    // page has a tie state at all.
    expect(overlapOfGammas(atLadder(10), atLadder(12))).toBeGreaterThan(SEPARABLE_OVERLAP);
    expect(overlapOfGammas(atLadder(10), atLadder(14))).toBeLessThan(SEPARABLE_OVERLAP);
  });
});

describe("overlapOfSamples", () => {
  it("is biased downward against the closed form, which is why ties do not use it", () => {
    // Binning noise, not a modelling difference. Two identical distributions read about 0.94
    // here, and that bias points the wrong way for this product: it makes two identical players
    // look separable and gets them ranked.
    const a = simulateMean("A", "WR", 11, BOUNDARY, 10000);
    const b = simulateMean("B", "WR", 11, BOUNDARY, 10000);
    const sampled = overlapOfSamples(a.draws, b.draws);
    expect(sampled).toBeGreaterThan(0.9);
    expect(sampled).toBeLessThan(0.98);
    expect(overlapOfGammas(a.params, b.params)).toBeGreaterThan(sampled);
  });

  it("is near 0 for samples that do not meet", () => {
    const a = simulateMean("A", "WR", 1, BOUNDARY, 10000);
    const b = simulateMean("B", "WR", 22, BOUNDARY, 10000);
    expect(overlapOfSamples(a.draws, b.draws)).toBeLessThan(0.15);
  });

  it("returns 0 rather than dividing by nothing on an empty sample", () => {
    expect(overlapOfSamples(new Float64Array(0), Float64Array.from([1, 2]))).toBe(0);
  });
});

describe("findTies", () => {
  const slate: Simulation[] = [
    simulateMean("close-a", "WR", 11, BOUNDARY, 2000),
    simulateMean("close-b", "WR", 11.4, BOUNDARY, 2000),
    simulateMean("far", "WR", 1.5, BOUNDARY, 2000),
  ];

  it("ties the pair it cannot separate and leaves the one it can alone", () => {
    const ties = findTies(slate);
    expect(ties.map((t) => [t.a, t.b])).toEqual([["close-a", "close-b"]]);
    expect(ties[0]?.overlap).toBeGreaterThan(SEPARABLE_OVERLAP);
  });

  it("reports the overlap it used, so the page can state it rather than assert a tie", () => {
    const tie = findTies(slate)[0];
    expect(tie?.overlap).toBeGreaterThan(0);
    expect(tie?.overlap).toBeLessThanOrEqual(1);
  });

  it("comes back in a stable order whatever order the slate arrives in", () => {
    const shuffled = [slate[2], slate[0], slate[1]].filter((s): s is Simulation => Boolean(s));
    expect(findTies(shuffled)).toEqual(findTies(slate));
  });

  it("ties everything at a threshold of 0 and nothing at 1", () => {
    expect(findTies(slate, 0)).toHaveLength(3);
    expect(findTies(slate, 1)).toHaveLength(0);
  });

  it("uses the contract's threshold by default", () => {
    expect(SEPARABLE_OVERLAP).toBe(0.8);
    expect(findTies(slate)).toEqual(findTies(slate, SEPARABLE_OVERLAP));
  });
});

describe("isSeparable", () => {
  it("is the negative of a tie", () => {
    const a = simulateMean("a", "WR", 11, BOUNDARY, 2000);
    const b = simulateMean("b", "WR", 11.4, BOUNDARY, 2000);
    const c = simulateMean("c", "WR", 1.5, BOUNDARY, 2000);
    expect(isSeparable(a, b)).toBe(false);
    expect(isSeparable(a, c)).toBe(true);
  });
});
