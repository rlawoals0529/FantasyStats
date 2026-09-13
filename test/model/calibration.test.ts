import { describe, expect, it } from "vitest";
import {
  DRAWS_PER_PLAYER,
  LEVEL_DRIFT_POINTS,
  MAX_PREDICTIVE_CV,
  IMPLIED_TOTAL_HIGH,
  IMPLIED_TOTAL_LOW,
  IMPLIED_TOTAL_REFERENCE,
  INJURY_EFFECT,
  OPPORTUNITY_GAP_EFFECT,
  POPULATION_CV,
  POPULATION_MEAN_POINTS,
  RESIDUAL_VOLATILITY_R,
  SPIKE_RATE_BY_TIER_FIXTURE,
  TOP_THREE_SHARE_OF_SEASON,
  TOUCHDOWN_LUCK_EFFECT,
  VOLATILITY_LADDER,
} from "../../src/model/calibration.ts";
import { gammaFromMeanSd, gammaSurvival } from "../../src/model/distribution.ts";
import { SPIKE_POINTS } from "../../src/shared/player.ts";
import { drawFrom, rateAtOrAbove, simulateMean, TYPICAL_GAMES_OF_HISTORY } from "../../src/model/simulate.ts";
import { LADDER_ANCHORS, predictiveSdFor, sdForMean } from "../../src/model/volatility.ts";

/**
 * THE MOST IMPORTANT FILE IN THIS REPO.
 *
 * Two different jobs, kept separate on purpose.
 *
 * The first is to pin the measurements. Every figure in `calibration.ts` was measured over four
 * seasons and is quoted back to the reader inside a `Reason`, so a silent edit to one of them
 * makes the page lie about its own evidence. These tests exist to make that edit loud.
 *
 * The second is to check that the simulator actually draws what it claims to. Ten thousand draws
 * at each tier of the ladder, against the closed form and against the recorded fixture. Note
 * what that does and does not prove: it proves the sampler and the distribution agree, and it
 * catches any change to family, parameterisation, ladder or seed. It does NOT prove the family
 * is right about football - `distribution.test.ts` is where that is argued, against the two
 * measurements taken independently of the family.
 */

const BOUNDARY = { season: 2024, week: 9 };

describe("the measured ladder, pinned to CONCEPT.md", () => {
  it("is the table from the concept doc, verbatim", () => {
    expect(VOLATILITY_LADDER.map((t) => [t.minMean, t.maxMean, t.sd, t.sdOverMean])).toEqual([
      [0, 5, 2.93, 1.16],
      [5, 8, 5.1, 0.8],
      [8, 11, 6.21, 0.66],
      [11, 14, 7.13, 0.57],
      [14, Infinity, 8.42, 0.49],
    ]);
  });

  it("is internally consistent: sd over sd/mean lands inside each tier's own bounds", () => {
    // A real check on transcription. Swap two rows or mistype a decimal and this fails, because
    // the recovered mean walks outside the bucket it is supposed to describe.
    VOLATILITY_LADDER.forEach((tier, i) => {
      const anchor = LADDER_ANCHORS[i];
      expect(anchor).toBeDefined();
      expect(anchor?.mean).toBeGreaterThanOrEqual(tier.minMean);
      expect(anchor?.mean).toBeLessThan(tier.maxMean);
    });
  });

  it("rises in sd and falls in sd/mean, which is the finding it encodes", () => {
    // Better players are absolutely more variable and relatively more consistent.
    for (let i = 1; i < VOLATILITY_LADDER.length; i++) {
      const previous = VOLATILITY_LADDER[i - 1];
      const current = VOLATILITY_LADDER[i];
      if (!previous || !current) throw new Error("ladder is empty");
      expect(current.sd).toBeGreaterThan(previous.sd);
      expect(current.sdOverMean).toBeLessThan(previous.sdOverMean);
    }
  });

  it("interpolates exactly through every measured point", () => {
    for (let i = 0; i < LADDER_ANCHORS.length; i++) {
      const anchor = LADDER_ANCHORS[i];
      const tier = VOLATILITY_LADDER[i];
      if (!anchor || !tier) throw new Error("ladder is empty");
      expect(sdForMean(anchor.mean, "WR")).toBeCloseTo(tier.sd, 9);
    }
  });
});

describe("spike rate by mean tier", () => {
  /**
   * The calibration test proper. At each measured tier, simulate a season's worth of a player
   * at that tier's own mean and check the spike rate lands where the model says it should.
   *
   * Tolerance is four Monte Carlo standard errors, not a flat percentage. At the bottom tier the
   * rate is 0.14 per cent, so 10,000 draws produce about 14 spikes and a relative tolerance
   * would be meaningless; at the top the rate is 32 per cent and an absolute one would be
   * useless. The standard error is the only tolerance that means the same thing at both ends.
   */
  it("matches the recorded fixture at every tier, drawn at the production draw count", () => {
    // Drawn at the LADDER's own spread, not the predictive one. This is a check on the sampler
    // and the family, so it has to use the spread the fixture was computed from; the predictive
    // spread that players are actually simulated with is checked separately below.
    LADDER_ANCHORS.forEach((anchor, i) => {
      const expected = SPIKE_RATE_BY_TIER_FIXTURE[i];
      expect(expected).toBeDefined();
      if (expected === undefined) return;
      const params = gammaFromMeanSd(anchor.mean, sdForMean(anchor.mean, "WR"));
      const draws = drawFrom(params, 1000 + i, DRAWS_PER_PLAYER);
      const rate = rateAtOrAbove(draws, SPIKE_POINTS);
      const standardError = Math.sqrt((expected * (1 - expected)) / DRAWS_PER_PLAYER);
      expect(
        Math.abs(rate - expected),
        `tier ${i} at mean ${anchor.mean.toFixed(2)}: simulated ${(rate * 100).toFixed(3)}% against a fixture of ${(expected * 100).toFixed(3)}%`,
      ).toBeLessThan(4 * standardError + 5e-4);
    });
  });

  it("matches the closed form at every tier, which is the fixture's own provenance", () => {
    LADDER_ANCHORS.forEach((anchor, i) => {
      const analytic = gammaSurvival(
        SPIKE_POINTS,
        gammaFromMeanSd(anchor.mean, sdForMean(anchor.mean, "WR")),
      );
      expect(analytic).toBeCloseTo(SPIKE_RATE_BY_TIER_FIXTURE[i] ?? -1, 5);
    });
  });

  it("rises with the tier, and by a lot: the top tier spikes 200 times as often as the bottom", () => {
    for (let i = 1; i < SPIKE_RATE_BY_TIER_FIXTURE.length; i++) {
      expect(SPIKE_RATE_BY_TIER_FIXTURE[i] ?? 0).toBeGreaterThan(
        SPIKE_RATE_BY_TIER_FIXTURE[i - 1] ?? 0,
      );
    }
    const bottom = SPIKE_RATE_BY_TIER_FIXTURE[0] ?? 1;
    const top = SPIKE_RATE_BY_TIER_FIXTURE[SPIKE_RATE_BY_TIER_FIXTURE.length - 1] ?? 0;
    expect(top / bottom).toBeGreaterThan(100);
  });

  it("brackets the measured Vegas spike rates, which were measured on the same population", () => {
    // Not a calibration of this model, a sanity check on the two tables living in one world: the
    // 3.5 and the 10.1 per cent Vegas buckets are population averages, so they have to sit
    // inside the range the per-tier rates span. If they did not, one of the tables would be
    // describing a different sport.
    const bottom = SPIKE_RATE_BY_TIER_FIXTURE[0] ?? 1;
    const top = SPIKE_RATE_BY_TIER_FIXTURE[SPIKE_RATE_BY_TIER_FIXTURE.length - 1] ?? 0;
    expect(IMPLIED_TOTAL_LOW.spikeRate).toBeGreaterThan(bottom);
    expect(IMPLIED_TOTAL_HIGH.spikeRate).toBeLessThan(top);
  });

  it("reproduces the tier's mean and sd in the draws themselves", () => {
    // The spike rate could be right for the wrong reason. This checks the body of the
    // distribution too, which is what p10 and p50 are read off.
    for (const anchor of LADDER_ANCHORS) {
      const params = gammaFromMeanSd(anchor.mean, sdForMean(anchor.mean, "WR"));
      const draws = Array.from(drawFrom(params, 77, 200000));
      const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
      const sd = Math.sqrt(
        draws.reduce((a, b) => a + (b - mean) ** 2, 0) / draws.length,
      );
      expect(mean).toBeCloseTo(anchor.mean, 1);
      expect(sd).toBeCloseTo(anchor.sd, 0);
    }
  });
});

describe("the predictive spread, which is what a player is actually simulated with", () => {
  it("is wider than the ladder at every tier, because the centre is an estimate", () => {
    // The defect this replaced. The ladder is the scatter around a player's own season mean and
    // the simulator does not know that number; it knows an average of n games. Drawing at the
    // ladder made every reliability band on 23,510 real player-weeks under-promise.
    for (const anchor of LADDER_ANCHORS) {
      const ladder = sdForMean(anchor.mean, "WR");
      const predictive = predictiveSdFor(anchor.mean, "WR", TYPICAL_GAMES_OF_HISTORY);
      expect(predictive).toBeGreaterThan(ladder);
      expect(predictive / ladder).toBeLessThan(1.6);
    }
  });

  it("is the two derivable terms plus the one measured constant, and nothing else", () => {
    // Spelled out rather than trusted, because the whole defence of this number is that only
    // one part of it is fitted. If someone adds a term, this fails.
    for (const games of [3, 8, 17]) {
      for (const mean of [4, 9, 14, 19]) {
        const ladder = sdForMean(mean, "WR");
        expect(predictiveSdFor(mean, "WR", games)).toBeCloseTo(
          Math.sqrt(ladder * ladder * (1 + 1 / games) + LEVEL_DRIFT_POINTS ** 2),
          9,
        );
      }
    }
  });

  it("narrows towards the ladder as the history grows, but never reaches it", () => {
    const ladder = sdForMean(12, "WR");
    let previous = Infinity;
    for (const games of [3, 5, 8, 12, 17, 40]) {
      const predictive = predictiveSdFor(12, "WR", games);
      expect(predictive).toBeLessThan(previous);
      expect(predictive).toBeGreaterThan(ladder);
      previous = predictive;
    }
    // The floor is the drift term, which does not go away however many games you have.
    expect(predictiveSdFor(12, "WR", 1e9)).toBeCloseTo(
      Math.sqrt(ladder * ladder + LEVEL_DRIFT_POINTS ** 2),
      6,
    );
  });

  it("caps the CV at the steepest the data shows, so a bench player is not a lottery ticket", () => {
    // Below a centre of about 1 ppg there are 28 graded predictions in four seasons. Without the
    // cap the drift term alone gives a CV of 8.6 at the model floor.
    for (const mean of [0.25, 0.5, 1]) {
      expect(predictiveSdFor(mean, "WR", 4) / mean).toBeLessThanOrEqual(MAX_PREDICTIVE_CV + 1e-9);
    }
    // And it does not bind anywhere inside the measured range.
    for (const mean of [2, 4, 8, 12, 18]) {
      expect(predictiveSdFor(mean, "WR", 4) / mean).toBeLessThan(MAX_PREDICTIVE_CV);
    }
  });

  it("refuses a history it cannot compute a spread from", () => {
    expect(() => predictiveSdFor(10, "WR", 0)).toThrow(/at least one game/);
    expect(() => predictiveSdFor(10, "WR", Number.NaN)).toThrow(/at least one game/);
  });
});

describe("the population reference points", () => {
  it("holds the figures the rest of the model is anchored on", () => {
    expect(POPULATION_MEAN_POINTS).toBe(7);
    expect(POPULATION_CV).toBe(0.82);
    expect(TOP_THREE_SHARE_OF_SEASON).toBe(0.4);
    expect(RESIDUAL_VOLATILITY_R).toBe(0.152);
  });

  it("keeps residual volatility low enough to justify never fitting a player's own spread", () => {
    // 0.152 is about 85 per cent noise. If this ever came back above about 0.5, the design
    // decision in volatility.ts would need revisiting rather than defending.
    expect(RESIDUAL_VOLATILITY_R).toBeLessThan(0.5);
  });
});

describe("the measured adjustments", () => {
  it("keeps the opportunity gap ladder monotone with the measured ends intact", () => {
    expect(OPPORTUNITY_GAP_EFFECT[0]).toBeCloseTo(0.95, 10);
    expect(OPPORTUNITY_GAP_EFFECT[3]).toBeCloseTo(-1.53, 10);
    for (let i = 1; i < OPPORTUNITY_GAP_EFFECT.length; i++) {
      expect(OPPORTUNITY_GAP_EFFECT[i] ?? 0).toBeLessThan(OPPORTUNITY_GAP_EFFECT[i - 1] ?? 0);
    }
    // 2.48 ppg between the extremes, inside the measured 2.3 to 2.8.
    const spread = (OPPORTUNITY_GAP_EFFECT[0] ?? 0) - (OPPORTUNITY_GAP_EFFECT[3] ?? 0);
    expect(spread).toBeGreaterThanOrEqual(2.3);
    expect(spread).toBeLessThanOrEqual(2.8);
  });

  it("keeps the touchdown asymmetry, which is the measurement and not a rounding", () => {
    expect(TOUCHDOWN_LUCK_EFFECT.cold).toBe(0.53);
    expect(TOUCHDOWN_LUCK_EFFECT.neutral).toBe(0);
    expect(TOUCHDOWN_LUCK_EFFECT.hot).toBe(-1.26);
    // Hot costs more than cold gains. There is more room to fall than to rise.
    expect(Math.abs(TOUCHDOWN_LUCK_EFFECT.hot)).toBeGreaterThan(TOUCHDOWN_LUCK_EFFECT.cold);
  });

  it("keeps the injury sign the CONTROLLED one, which looks backwards and is not", () => {
    // Read INJURY_EFFECT in calibration.ts before touching this. The raw uncontrolled figure has
    // Questionable players OUTSCORING unlisted ones, because only players worth worrying about
    // get listed. This test is here to stop that selection effect being "fixed" back in.
    expect(INJURY_EFFECT.Questionable).toBe(-0.99);
    expect(INJURY_EFFECT.unlisted).toBe(0.22);
    expect(INJURY_EFFECT.Questionable).toBeLessThan(INJURY_EFFECT.unlisted);
    // Doubtful and Out are not measured, so they are zero rather than an extrapolation.
    expect(INJURY_EFFECT.Doubtful).toBe(0);
    expect(INJURY_EFFECT.Out).toBe(0);
  });

  it("keeps the Vegas table and its reference inside the range that was measured", () => {
    expect(IMPLIED_TOTAL_LOW).toEqual({ total: 17, spikeRate: 0.035 });
    expect(IMPLIED_TOTAL_HIGH).toEqual({ total: 26, spikeRate: 0.101 });
    expect(IMPLIED_TOTAL_REFERENCE).toBeGreaterThan(IMPLIED_TOTAL_LOW.total);
    expect(IMPLIED_TOTAL_REFERENCE).toBeLessThan(IMPLIED_TOTAL_HIGH.total);
    // Nearly a threefold difference in spike rate across the range, which is why it is in.
    expect(IMPLIED_TOTAL_HIGH.spikeRate / IMPLIED_TOTAL_LOW.spikeRate).toBeGreaterThan(2.5);
  });

  it("runs the simulator at the production draw count, not a quietly smaller one", () => {
    expect(DRAWS_PER_PLAYER).toBe(10000);
    const sim = simulateMean("count", "WR", 12, BOUNDARY);
    expect(sim.draws.length).toBe(10000);
  });
});
