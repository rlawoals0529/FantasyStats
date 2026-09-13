import { describe, expect, it } from "vitest";
import {
  POPULATION_CV,
  POPULATION_MEAN_POINTS,
  SEASON_WEEKS,
  TOP_THREE_SHARE_OF_SEASON,
} from "../../src/model/calibration.ts";
import {
  gammaCdf,
  gammaFromMeanSd,
  gammaSurvival,
  logGamma,
  meanForSpikeRate,
  sampleGamma,
} from "../../src/model/distribution.ts";
import { mulberry32, standardNormal, type Rng } from "../../src/model/rng.ts";
import { LADDER_ANCHORS, sdForMean } from "../../src/model/volatility.ts";

/**
 * WHY THIS FILE EXISTS.
 *
 * The choice of distribution family is the single decision that most affects the number the page
 * leads with, and it is easy to make badly and impossible to notice afterwards: a normal
 * distribution produces a perfectly plausible-looking spike percentage that is wrong in a way no
 * amount of staring at the UI reveals. So the family is held to measurements that were taken
 * independently of it - the concentration figure and the CV - and the rejected families are held
 * to the same ones here, so "we chose gamma" is a result rather than a preference.
 */

/** Share of a season's points that arrive in the best three weeks, by simulation. */
function topThreeShare(draw: (rng: Rng) => number, seed: number, seasons = 20000): number {
  const rng = mulberry32(seed);
  let total = 0;
  for (let s = 0; s < seasons; s++) {
    const weeks: number[] = [];
    for (let w = 0; w < SEASON_WEEKS; w++) weeks.push(Math.max(0, draw(rng)));
    const seasonTotal = weeks.reduce((a, b) => a + b, 0);
    if (seasonTotal <= 0) continue;
    weeks.sort((a, b) => b - a);
    total += ((weeks[0] ?? 0) + (weeks[1] ?? 0) + (weeks[2] ?? 0)) / seasonTotal;
  }
  return total / seasons;
}

const MEAN = POPULATION_MEAN_POINTS;
const SD = POPULATION_MEAN_POINTS * POPULATION_CV;

const gammaDraw = (params = gammaFromMeanSd(MEAN, SD)) => (rng: Rng) => sampleGamma(rng, params);
const normalDraw = (rng: Rng) => MEAN + SD * standardNormal(rng);
const lognormalDraw = (rng: Rng) => {
  const variance = Math.log(1 + (SD / MEAN) ** 2);
  return Math.exp(Math.log(MEAN) - variance / 2 + Math.sqrt(variance) * standardNormal(rng));
};

describe("the chosen family reproduces the measurements it was not fitted to", () => {
  it("puts about 40 per cent of a season in the best three weeks, as measured", () => {
    // CONCEPT.md: "about 40 per cent of a season comes from a player's best 3 weeks". Nothing in
    // the gamma was fitted to this. It falls out of the mean and the sd, which is the check.
    //
    // The band is two points either side because the measurement is quoted as "about 40 per
    // cent" and asserting tighter than the thing being asserted against is false precision. It
    // is still a discriminating band: the normal below misses it by three and a half points.
    const share = topThreeShare(gammaDraw(), 1);
    expect(share).toBeGreaterThan(TOP_THREE_SHARE_OF_SEASON - 0.02);
    expect(share).toBeLessThan(TOP_THREE_SHARE_OF_SEASON + 0.02);
  });

  it("never produces a negative week", () => {
    const rng = mulberry32(5);
    const params = gammaFromMeanSd(MEAN, SD);
    for (let i = 0; i < 50000; i++) expect(sampleGamma(rng, params)).toBeGreaterThanOrEqual(0);
  });

  it("is right-skewed by exactly 2 CV, so a low-mean player is the more lopsided one", () => {
    for (const anchor of LADDER_ANCHORS) {
      const params = gammaFromMeanSd(anchor.mean, sdForMean(anchor.mean, "WR"));
      const skew = 2 / Math.sqrt(params.shape);
      const cv = sdForMean(anchor.mean, "WR") / anchor.mean;
      expect(skew).toBeCloseTo(2 * cv, 6);
    }
    const bottom = LADDER_ANCHORS[0];
    const top = LADDER_ANCHORS[LADDER_ANCHORS.length - 1];
    if (!bottom || !top) throw new Error("ladder is empty");
    const skewOf = (mean: number) => (2 * sdForMean(mean, "WR")) / mean;
    expect(skewOf(bottom.mean)).toBeGreaterThan(skewOf(top.mean));
  });
});

describe("the families this was chosen over, held to the same measurements", () => {
  it("normal: misses the measured concentration", () => {
    // 0.365 against a measured 0.40. A symmetric family cannot concentrate a season this hard.
    const share = topThreeShare(normalDraw, 1);
    expect(share).toBeLessThan(TOP_THREE_SHARE_OF_SEASON - 0.02);
  });

  it("normal: puts a tenth of the league's weeks below zero points", () => {
    // Not rare tail events. Impossible events, and every one is stolen from the right tail that
    // this product exists to report.
    const belowZero = normalCdf(0, MEAN, SD);
    expect(belowZero).toBeGreaterThan(0.1);
    expect(gammaCdf(0, gammaFromMeanSd(MEAN, SD))).toBe(0);
  });

  it("normal: says a low-mean player's spike is impossible, which is not a tail, it is a claim", () => {
    const anchor = LADDER_ANCHORS[0];
    if (!anchor) throw new Error("ladder is empty");
    const sd = sdForMean(anchor.mean, "WR");
    const underNormal = 1 - normalCdf(20, anchor.mean, sd);
    const underGamma = gammaSurvival(20, gammaFromMeanSd(anchor.mean, sd));
    expect(underNormal).toBeLessThan(1e-6);
    expect(underGamma).toBeGreaterThan(1e-3);
  });

  it("lognormal: clears the concentration bar, and more than doubles the low tier's spike", () => {
    // The honest position: concentration does NOT separate lognormal from gamma, and this test
    // records that rather than hiding it. What separates them is the bottom tier, where
    // lognormal's heavier tail more than doubles the spike rate for exactly the players whose
    // spike nobody checks, and where its zero density AT zero is the wrong shape for a bench
    // player's season. That second point is a judgement, not a measurement, and is argued in
    // the header of distribution.ts rather than asserted here as though it were measured.
    expect(topThreeShare(lognormalDraw, 1)).toBeGreaterThan(TOP_THREE_SHARE_OF_SEASON - 0.02);

    const anchor = LADDER_ANCHORS[0];
    if (!anchor) throw new Error("ladder is empty");
    const sd = sdForMean(anchor.mean, "WR");
    const variance = Math.log(1 + (sd / anchor.mean) ** 2);
    const mu = Math.log(anchor.mean) - variance / 2;
    const underLognormal = 1 - normalCdf(Math.log(20), mu, Math.sqrt(variance));
    const underGamma = gammaSurvival(20, gammaFromMeanSd(anchor.mean, sd));
    expect(underLognormal).toBeGreaterThan(2 * underGamma);
  });
});

describe("gammaFromMeanSd", () => {
  it("moment-matches", () => {
    const params = gammaFromMeanSd(9.4, 6.21);
    expect(params.shape * params.scale).toBeCloseTo(9.4, 9);
    expect(Math.sqrt(params.shape) * params.scale).toBeCloseTo(6.21, 9);
  });

  it("refuses a non-positive mean or sd rather than returning a silent NaN", () => {
    expect(() => gammaFromMeanSd(0, 3)).toThrow(/positive finite mean/);
    expect(() => gammaFromMeanSd(-1, 3)).toThrow(/positive finite mean/);
    expect(() => gammaFromMeanSd(5, 0)).toThrow(/positive finite sd/);
    expect(() => gammaFromMeanSd(5, Number.NaN)).toThrow(/positive finite sd/);
  });
});

describe("the closed form", () => {
  it("agrees with the sampler at every tier, which is what makes it usable as a reference", () => {
    for (const anchor of LADDER_ANCHORS) {
      const params = gammaFromMeanSd(anchor.mean, sdForMean(anchor.mean, "WR"));
      const rng = mulberry32(21);
      const n = 200000;
      let above = 0;
      for (let i = 0; i < n; i++) if (sampleGamma(rng, params) >= 20) above++;
      const analytic = gammaSurvival(20, params);
      const standardError = Math.sqrt((analytic * (1 - analytic)) / n);
      expect(Math.abs(above / n - analytic)).toBeLessThan(4 * standardError + 1e-4);
    }
  });

  it("is a proper CDF", () => {
    const params = gammaFromMeanSd(9.4, 6.21);
    expect(gammaCdf(-1, params)).toBe(0);
    expect(gammaCdf(0, params)).toBe(0);
    expect(gammaCdf(1e6, params)).toBeCloseTo(1, 9);
    let previous = 0;
    for (let x = 0.5; x < 60; x += 0.5) {
      const value = gammaCdf(x, params);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("has a log-gamma that matches the factorials it should", () => {
    expect(Math.exp(logGamma(1))).toBeCloseTo(1, 9);
    expect(Math.exp(logGamma(5))).toBeCloseTo(24, 6);
    expect(Math.exp(logGamma(0.5))).toBeCloseTo(Math.sqrt(Math.PI), 9);
  });
});

describe("meanForSpikeRate", () => {
  it("inverts the survival function it is built on", () => {
    const ladder = (m: number) => sdForMean(m, "WR");
    for (const target of [0.02, 0.05, 0.1, 0.25]) {
      const mean = meanForSpikeRate(target, 20, ladder);
      expect(gammaSurvival(20, gammaFromMeanSd(mean, ladder(mean)))).toBeCloseTo(target, 5);
    }
  });

  it("is monotone: a higher spike rate needs a higher centre", () => {
    const ladder = (m: number) => sdForMean(m, "WR");
    expect(meanForSpikeRate(0.2, 20, ladder)).toBeGreaterThan(meanForSpikeRate(0.05, 20, ladder));
  });
});

/** Only used to hold the rejected families to account. The model never draws from a normal. */
function normalCdf(x: number, mean: number, sd: number): number {
  return 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));
}

function erf(x: number): number {
  // Abramowitz and Stegun 7.1.26. Good to 1.5e-7, which is far tighter than anything asserted.
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
