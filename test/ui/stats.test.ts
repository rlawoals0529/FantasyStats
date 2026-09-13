import { describe, expect, it } from "vitest";
import {
  estimate,
  marginDensity,
  mass,
  overlap,
  pairOverlap,
  peak,
  quantile,
  rankRanges,
  smooth,
  tailAbove,
  tailBelow,
} from "../../src/ui/stats.ts";
import { GRID_SIZE, GRID_STEP, gridPoints } from "../../src/ui/ports.ts";
import { SEPARABLE_OVERLAP } from "../../src/shared/player.ts";
import { lognormalDensity } from "../../src/ui/fixtures/generate.ts";

const flat = (): Float64Array => {
  const a = new Float64Array(GRID_SIZE);
  a.fill(1 / (GRID_SIZE * GRID_STEP));
  return a;
};

describe("overlap", () => {
  it("is 1 for a distribution against itself", () => {
    const a = lognormalDensity(14, 7);
    expect(overlap(a, a)).toBeCloseTo(1, 6);
  });

  it("is 0 for two distributions that never take the same value", () => {
    const a = new Float64Array(GRID_SIZE);
    const b = new Float64Array(GRID_SIZE);
    a[10] = 1 / GRID_STEP;
    b[120] = 1 / GRID_STEP;
    expect(overlap(a, b)).toBe(0);
  });

  it("falls as the means separate", () => {
    const base = lognormalDensity(14, 7);
    const near = lognormalDensity(15, 7);
    const far = lognormalDensity(30, 7);
    expect(overlap(base, near)).toBeGreaterThan(overlap(base, far));
  });

  it("is symmetric", () => {
    const a = lognormalDensity(9, 6);
    const b = lognormalDensity(17, 8);
    expect(overlap(a, b)).toBeCloseTo(overlap(b, a), 12);
  });
});

describe("quantile", () => {
  it("puts the median of a flat density in the middle of the grid", () => {
    // gridPoints(i) is a cell LEFT edge, so the uniform runs to gridPoints(last) + one step and
    // its true midpoint sits half a step past the midpoint of the endpoints.
    const mid = quantile(flat(), 0.5);
    const expected = (gridPoints(0) + gridPoints(GRID_SIZE - 1) + GRID_STEP) / 2;
    expect(mid).toBeCloseTo(expected, 6);
  });

  it("is monotonic in q", () => {
    const pdf = lognormalDensity(12, 7);
    const qs = [0.1, 0.25, 0.5, 0.75, 0.9].map((q) => quantile(pdf, q));
    for (let i = 1; i < qs.length; i++) expect(qs[i]!).toBeGreaterThan(qs[i - 1]!);
  });

  it("interpolates inside a cell rather than snapping to the grid", () => {
    // A tight distribution has p50 and p60 inside the same 0.25 point cell. Snapping would
    // report them as equal and the row would claim a range of zero.
    const pdf = lognormalDensity(10, 2.9);
    expect(quantile(pdf, 0.5)).not.toBe(quantile(pdf, 0.52));
  });
});

describe("tails", () => {
  it("agree with the total mass", () => {
    const pdf = lognormalDensity(14, 8);
    expect(mass(pdf)).toBeCloseTo(1, 6);
    expect(tailAbove(pdf, 20) + tailBelow(pdf, 19.9)).toBeCloseTo(1, 3);
  });

  it("puts more mass past 20 for a higher mean at the same spread", () => {
    expect(tailAbove(lognormalDensity(18, 8), 20)).toBeGreaterThan(
      tailAbove(lognormalDensity(10, 8), 20),
    );
  });

  it("caps at 1 and floors at 0", () => {
    const pdf = lognormalDensity(12, 7);
    expect(tailAbove(pdf, -100)).toBeLessThanOrEqual(1);
    expect(tailAbove(pdf, 500)).toBe(0);
  });
});

describe("peak and smooth", () => {
  it("smoothing preserves mass", () => {
    const pdf = lognormalDensity(14, 7);
    expect(mass(smooth(pdf, 3))).toBeCloseTo(mass(pdf), 3);
  });

  it("smoothing lowers the peak", () => {
    const pdf = lognormalDensity(6, 5);
    expect(peak(smooth(pdf, 4))).toBeLessThan(peak(pdf));
  });
});

describe("rankRanges", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("gives a separable player a range of one rank", () => {
    const ranges = rankRanges(order, []);
    for (const r of ranges) {
      expect(r.lo).toBe(r.rank);
      expect(r.hi).toBe(r.rank);
      expect(r.tiedWith).toEqual([]);
    }
  });

  it("widens a range to cover every partner, adjacent or not", () => {
    const ranges = rankRanges(order, [{ a: "a", b: "d", overlap: 0.9 }]);
    expect(ranges[0]).toMatchObject({ rank: 1, lo: 1, hi: 4 });
    expect(ranges[3]).toMatchObject({ rank: 4, lo: 1, hi: 4 });
    // And says nothing about the rows in between, which is the whole point.
    expect(ranges[1]).toMatchObject({ rank: 2, lo: 2, hi: 2 });
  });

  it("does NOT chain through a shared partner", () => {
    // a ties b and b ties c, but a and c do not. Treating tie as transitive was the first
    // implementation and it collapsed 34 of 36 real players into one meaningless band.
    const ranges = rankRanges(order, [
      { a: "a", b: "b", overlap: 0.9 },
      { a: "b", b: "c", overlap: 0.9 },
    ]);
    expect(ranges[0]).toMatchObject({ lo: 1, hi: 2 });
    expect(ranges[2]).toMatchObject({ lo: 2, hi: 3 });
  });

  it("ignores a pair below the separability threshold", () => {
    const ranges = rankRanges(order, [{ a: "a", b: "e", overlap: SEPARABLE_OVERLAP - 0.01 }]);
    expect(ranges[0]!.hi).toBe(1);
  });

  it("ignores a pair naming somebody not on the board", () => {
    const ranges = rankRanges(order, [{ a: "a", b: "ghost", overlap: 0.99 }]);
    expect(ranges[0]!.tiedWith).toEqual([]);
  });

  it("reports the weakest and strongest overlap in the set", () => {
    const ranges = rankRanges(order, [
      { a: "a", b: "b", overlap: 0.83 },
      { a: "a", b: "c", overlap: 0.97 },
    ]);
    expect(ranges[0]!.minOverlap).toBeCloseTo(0.83, 6);
    expect(ranges[0]!.maxOverlap).toBeCloseTo(0.97, 6);
  });
});

describe("pairOverlap", () => {
  it("finds a pair whichever way round it was recorded", () => {
    const ties = [{ a: "x", b: "y", overlap: 0.91 }];
    expect(pairOverlap(ties, "x", "y")).toBeCloseTo(0.91, 6);
    expect(pairOverlap(ties, "y", "x")).toBeCloseTo(0.91, 6);
    expect(pairOverlap(ties, "x", "z")).toBeNull();
  });
});

describe("estimate", () => {
  const pair = (mineValues: number[], theirValues: number[]) =>
    estimate(Float64Array.from(mineValues), Float64Array.from(theirValues), mineValues.length);

  it("counts a draw as neither a win nor a loss", () => {
    const e = pair([10, 10, 10, 10], [5, 10, 20, 10]);
    expect(e.p).toBeCloseTo(0.25, 6);
    expect(e.level).toBeCloseTo(0.5, 6);
  });

  it("narrows the interval as the sample grows", () => {
    const mine = new Float64Array(10000);
    const theirs = new Float64Array(10000);
    for (let i = 0; i < 10000; i++) {
      mine[i] = i % 3 === 0 ? 0 : 1;
      theirs[i] = 0.5;
    }
    const small = estimate(mine, theirs, 100);
    const large = estimate(mine, theirs, 10000);
    expect(large.halfWidth).toBeLessThan(small.halfWidth / 5);
    expect(large.hi - large.lo).toBeLessThan(small.hi - small.lo);
  });

  it("keeps the interval inside 0 and 1 at the extremes", () => {
    const mine = Float64Array.from(Array(40).fill(10));
    const theirs = Float64Array.from(Array(40).fill(1));
    const e = estimate(mine, theirs, 40);
    expect(e.p).toBe(1);
    expect(e.hi).toBeLessThanOrEqual(1);
    expect(e.lo).toBeGreaterThanOrEqual(0);
    // And the interval contains the figure printed beside it, at both extremes.
    expect(e.lo).toBeLessThanOrEqual(e.p);
    expect(e.hi).toBeGreaterThanOrEqual(e.p);
    const flatLoss = estimate(theirs, mine, 40);
    expect(flatLoss.p).toBe(0);
    expect(flatLoss.lo).toBe(0);
    expect(flatLoss.hi).toBeLessThanOrEqual(1);
  });

  it("reports nothing rather than dividing by zero on an empty run", () => {
    const e = estimate(new Float64Array(4), new Float64Array(4), 0);
    expect(e).toMatchObject({ p: 0, drawn: 0 });
    // The widest interval there is: nothing has been observed, so nothing is ruled out.
    expect(e.lo).toBe(0);
    expect(e.hi).toBe(1);
  });
});

describe("marginDensity", () => {
  it("integrates to 1", () => {
    const mine = new Float64Array(500);
    const theirs = new Float64Array(500);
    for (let i = 0; i < 500; i++) {
      mine[i] = 100 + (i % 30);
      theirs[i] = 100 + ((i * 7) % 30);
    }
    const pdf = marginDensity(mine, theirs, 500, 40, 80);
    const width = 80 / 80;
    let total = 0;
    for (let i = 0; i < pdf.length; i++) total += pdf[i]! * width;
    expect(total).toBeCloseTo(1, 6);
  });

  it("returns an empty density rather than NaN for no draws", () => {
    const pdf = marginDensity(new Float64Array(4), new Float64Array(4), 0, 40, 20);
    expect([...pdf].every((v) => v === 0)).toBe(true);
  });
});
