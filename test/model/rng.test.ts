import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gammaVariate, hashSeed, mulberry32, seedFor, standardNormal } from "../../src/model/rng.ts";

/** Sample mean and sd, used by several of these to check a generator's moments. */
function moments(draw: () => number, n: number): { mean: number; sd: number } {
  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i < n; i++) {
    const x = draw();
    sum += x;
    sumSquares += x * x;
  }
  const mean = sum / n;
  return { mean, sd: Math.sqrt(sumSquares / n - mean * mean) };
}

describe("mulberry32", () => {
  it("gives the same stream twice from the same seed", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const first = Array.from({ length: 50 }, () => a());
    const second = Array.from({ length: 50 }, () => b());
    expect(first).toEqual(second);
  });

  it("gives a different stream from a different seed", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(Array.from({ length: 20 }, () => a())).not.toEqual(
      Array.from({ length: 20 }, () => b()),
    );
  });

  it("stays inside [0, 1)", () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 20000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("is roughly uniform, so the quantiles downstream mean anything", () => {
    const rng = mulberry32(7);
    const { mean, sd } = moments(rng, 200000);
    expect(mean).toBeCloseTo(0.5, 2);
    expect(sd).toBeCloseTo(Math.sqrt(1 / 12), 2);
  });
});

describe("seedFor", () => {
  it("is stable across runs, which is what makes a published number reproducible", () => {
    // Pinned. If this changes, every simulated figure the site has ever shown changes with it,
    // so it should change only deliberately.
    expect(seedFor([2024, 9, "00-0034796"])).toBe(hashSeed("2024:9:00-0034796"));
    expect(seedFor([2024, 9, "00-0034796"])).toBe(1867383096);
  });

  it("separates players and weeks", () => {
    const a = seedFor([2024, 9, "player-a"]);
    const b = seedFor([2024, 9, "player-b"]);
    const c = seedFor([2024, 10, "player-a"]);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("standardNormal", () => {
  it("has mean 0 and sd 1", () => {
    const rng = mulberry32(4);
    const { mean, sd } = moments(() => standardNormal(rng), 200000);
    expect(mean).toBeCloseTo(0, 1);
    expect(sd).toBeCloseTo(1, 1);
  });
});

describe("gammaVariate", () => {
  it("has the right moments above shape 1", () => {
    const rng = mulberry32(11);
    const shape = 4.165;
    const { mean, sd } = moments(() => gammaVariate(rng, shape), 200000);
    expect(mean).toBeCloseTo(shape, 1);
    expect(sd).toBeCloseTo(Math.sqrt(shape), 1);
  });

  it("has the right moments BELOW shape 1, which is the tier the ladder needs", () => {
    // sd/mean 1.16 at the bottom tier is shape 0.743. Marsaglia-Tsang is only valid for shape
    // >= 1 and the boost branch is what covers it below that.
    const rng = mulberry32(13);
    const shape = 0.743;
    const { mean, sd } = moments(() => gammaVariate(rng, shape), 200000);
    expect(mean).toBeCloseTo(shape, 1);
    expect(sd).toBeCloseTo(Math.sqrt(shape), 1);
  });

  it("is still right at a shape far below 1, where dropping the boost is unmistakable", () => {
    // MEASURED, not assumed: at shape 0.743 the unboosted algorithm is only about 1.5 per cent
    // low on the mean, which no sane tolerance at that shape would catch. At shape 0.35 it
    // returns 0.46 against a true 0.35, so this is the assertion that actually holds the branch
    // in place. Keeping it means the guard survives the ladder being re-measured downward.
    const rng = mulberry32(29);
    const shape = 0.35;
    const { mean, sd } = moments(() => gammaVariate(rng, shape), 200000);
    expect(mean).toBeCloseTo(shape, 2);
    expect(sd).toBeCloseTo(Math.sqrt(shape), 2);
  });

  it("never returns a negative, which is half the reason for choosing this family", () => {
    const rng = mulberry32(17);
    for (let i = 0; i < 50000; i++) expect(gammaVariate(rng, 0.743)).toBeGreaterThanOrEqual(0);
  });

  it("refuses a shape that is not a finite positive", () => {
    const rng = mulberry32(1);
    expect(() => gammaVariate(rng, 0)).toThrow(/finite positive shape/);
    expect(() => gammaVariate(rng, -1)).toThrow(/finite positive shape/);
    expect(() => gammaVariate(rng, Number.NaN)).toThrow(/finite positive shape/);
  });
});

describe("the model's randomness", () => {
  it("never calls Math.random", () => {
    // One stray call and every test of the simulator becomes a coin toss that usually passes.
    // Checked by reading the source rather than by trusting review.
    const offenders: string[] = [];
    for (const file of readdirSync("src/model")) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(`src/model/${file}`, "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      if (code.includes("Math.random")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
