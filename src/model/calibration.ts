/**
 * Every number this model was told rather than invented, in one file with its source attached.
 *
 * Nothing here is fitted at runtime. These are the four-season measurements from
 * `docs/CONCEPT.md`, copied verbatim, and the tests in `test/model/calibration.test.ts` exist
 * to go red when one of them changes. A measurement that drifts silently is worse than no
 * measurement, because the model keeps quoting the old effect size in its `Reason` strings.
 *
 * Where a number is NOT measured, it says so in its own comment and the value is the neutral
 * one. There is no house style of filling a gap with something plausible: an unmeasured effect
 * is zero here, and the `basis` string that reaches the page says which it was.
 */

/** Where a `Reason.basis` points, so a reader can go and check the claim. */
export const SOURCE = "docs/CONCEPT.md, four seasons of nflverse data, 24,616 player-weeks";

// ---------------------------------------------------------------------------------------------
// The volatility ladder. This is the measurement the whole simulator is built on.
// ---------------------------------------------------------------------------------------------

export type VolatilityTier = {
  /** Lower bound of the tier's season mean, inclusive. */
  readonly minMean: number;
  /** Upper bound of the tier's season mean, exclusive. `Infinity` on the open top tier. */
  readonly maxMean: number;
  /** Measured sd of weekly points for players in this tier. */
  readonly sd: number;
  /** Measured sd / mean for the tier. */
  readonly sdOverMean: number;
};

/**
 * sd of weekly points by season mean. CONCEPT.md, "The consequence that shapes the code".
 *
 * Better players are absolutely more variable and relatively more consistent, which is why this
 * is a ladder and not a constant CV. A constant CV of 0.82 - the headline figure for RB/WR/TE -
 * would give a 17 ppg player an sd of 13.9 against the measured 8.42, so it would report roughly
 * double the real chance of a 30-point week for exactly the players a lineup turns on.
 *
 * Both columns are carried and neither is redundant: sd / sdOverMean recovers the mean the
 * tier's sd was measured AT, which is what `volatility.ts` interpolates between. That recovered
 * mean lands inside its own tier's bounds for all five rows, which is a real check that the
 * table was transcribed correctly, and `calibration.test.ts` runs it. It also settles the top
 * tier, whose anchor would otherwise have been a guess: 8.42 / 0.49 is 17.2, not "14 or more".
 */
export const VOLATILITY_LADDER: readonly VolatilityTier[] = [
  { minMean: 0, maxMean: 5, sd: 2.93, sdOverMean: 1.16 },
  { minMean: 5, maxMean: 8, sd: 5.1, sdOverMean: 0.8 },
  { minMean: 8, maxMean: 11, sd: 6.21, sdOverMean: 0.66 },
  { minMean: 11, maxMean: 14, sd: 7.13, sdOverMean: 0.57 },
  { minMean: 14, maxMean: Infinity, sd: 8.42, sdOverMean: 0.49 },
];

/**
 * Residual spread's correlation between halves of a season, once the mean's effect is removed.
 *
 * 0.152. This is the reason `volatility.ts` never looks at a player's own history, and it is
 * quoted in the test that would catch someone reintroducing it.
 */
export const RESIDUAL_VOLATILITY_R = 0.152;

// ---------------------------------------------------------------------------------------------
// Population reference points.
// ---------------------------------------------------------------------------------------------

/** "6.2 points against a mean of about 7". The reference mean the Vegas table is anchored at. */
export const POPULATION_MEAN_POINTS = 7;
/** Weekly volatility, CV 0.82 for RB/WR/TE. */
export const POPULATION_CV = 0.82;
/** About 40 per cent of a season arrives in a player's best three weeks. */
export const TOP_THREE_SHARE_OF_SEASON = 0.4;
/** Weeks a fantasy season is graded over. Used only by the concentration check. */
export const SEASON_WEEKS = 17;

/** The baseline every honest scorecard is written against: season average to date. */
export const BASELINE_RMSE = 6.208;
export const BASELINE_MAE = 4.373;
export const BASELINE_R = 0.597;
/** And the fitted model that did not beat it. RMSE -1.4 per cent, MAE worse. */
export const FITTED_MODEL_RMSE = 6.119;
export const FITTED_MODEL_MAE = 4.426;

// ---------------------------------------------------------------------------------------------
// The adjustments. Each one is an effect on expected points per game, signed.
// ---------------------------------------------------------------------------------------------

/**
 * Opportunity gap, by quartile of (production minus what that opportunity usually buys).
 *
 * Q1 is the biggest shortfall against opportunity and regresses upward; Q4 has been outrunning
 * its opportunity and gives it back. Measured as monotonic with 2.3 to 2.8 ppg between the
 * extreme quartiles, and the two ENDS are the measured values: +0.95 and -1.53.
 *
 * The middle two are linear interpolation between those ends. They are not measured, and any
 * `Reason` they produce says so. Interpolating is the smallest assumption available that keeps
 * the monotonicity the measurement reports.
 */
export const OPPORTUNITY_GAP_EFFECT: readonly [number, number, number, number] = [
  0.95, 0.12333333333333334, -0.7033333333333334, -1.53,
];
export const OPPORTUNITY_GAP_BASIS_MEASURED = `opportunity gap quartiles, monotonic 2.3 to 2.8 ppg between the extremes (${SOURCE})`;
export const OPPORTUNITY_GAP_BASIS_INTERPOLATED = `linear interpolation between the measured extreme quartiles +0.95 and -1.53; the interior quartiles are not separately measured (${SOURCE})`;

/**
 * Touchdown rate against expectation. Stickiness 0.453, so most of it is luck and it regresses.
 *
 * Cold shooters gain +0.53 and hot shooters lose -1.26. The asymmetry is real and worth not
 * "fixing": there is more room to fall from a hot rate than to rise from a cold one, because
 * the floor is zero touchdowns and the ceiling is not.
 *
 * What is NOT measured is where the bucket boundaries sit. `expected.ts` uses terciles of the
 * as-of population rather than a hardcoded rate, so the split is at least defined by the data
 * in front of it, and the `Reason` says that is what it did.
 */
export const TOUCHDOWN_LUCK_EFFECT = { cold: 0.53, neutral: 0, hot: -1.26 } as const;
export const TOUCHDOWN_LUCK_BASIS = `touchdown rate regresses, stickiness 0.453; hot shooters lose 1.26 ppg and cold shooters gain 0.53 (${SOURCE})`;

/**
 * Vegas implied team total against spike rate. The measured ENDS of the table.
 *
 * 3.5 per cent under 17, 10.1 per cent at 26 or more. Note what this is a table OF: spike rates,
 * not points. `expected.ts` converts it to a points effect by asking what mean a gamma on the
 * volatility ladder needs in order to spike at that rate, which is the only conversion available
 * that does not invent a second effect size.
 *
 * This association is NOT controlled for player quality, unlike the injury figure below. Good
 * players are disproportionately on offences Vegas likes, so some of this gap is who is in the
 * bucket rather than what the bucket does to them. It is applied at a quarter weight for that
 * reason, and that weight is a judgement call - see `IMPLIED_TOTAL_CONFOUND_WEIGHT`.
 */
export const IMPLIED_TOTAL_LOW = { total: 17, spikeRate: 0.035 } as const;
export const IMPLIED_TOTAL_HIGH = { total: 26, spikeRate: 0.101 } as const;
/**
 * The implied total the adjustment is zero at, and the honest caveat that goes with it.
 *
 * 21.5, the midpoint of the two measured ends. NOT the measured league-average implied total,
 * which CONCEPT.md does not give. It is chosen so the adjustment is symmetric in log-odds across
 * the range that WAS measured and vanishes in the middle of it, which is the least-claiming
 * choice available: a reference at either end would make every player in the league a permanent
 * upgrade or a permanent downgrade.
 *
 * Two further things this adjustment assumes, neither measured, both worth knowing before
 * trusting it far. The spike rate between 17 and 26 is interpolated log-linearly, and only the
 * ends are measured. And the bucket effect is applied as a constant multiplier on each player's own
 * spike odds, which assumes the Vegas effect is proportional across the ladder rather than, say,
 * flat in points - the measurement is a population average and cannot tell those apart.
 *
 * The measurement is also NOT controlled for who is in each bucket, unlike the injury figure
 * below: good players are disproportionately on offences Vegas likes, so this is an upper bound
 * on the causal effect. Some of that confound is already absorbed, because the spread it scales
 * is conditioned on the player's own mean. How much is not measured, so no haircut is applied - an
 * invented discount would be as unfounded as the confound it corrects for.
 */
export const IMPLIED_TOTAL_REFERENCE = 21.5;
export const IMPLIED_TOTAL_BASIS = `implied team total against spike rate, 3.5 per cent under 17 and 10.1 per cent at 26 or more, referenced to the midpoint of that range; applied to the spread rather than the mean because the same source measures no effect on means, and the points figure is the mean shift that would have produced the same change in spike odds. Not controlled for player quality, so it is an upper bound (${SOURCE})`;

/**
 * Injury designation, CONTROLLED FOR THE PLAYER'S OWN BASELINE.
 *
 * Questionable -0.99, unlisted +0.22.
 *
 * READ THIS BEFORE "FIXING" THE SIGN. The raw, uncontrolled number runs the other way:
 * Questionable players outscore unlisted players. That is a selection effect and not a finding.
 * A team does not bother listing a fringe player, so the Questionable pool is stocked with
 * starters - the designation is a marker of being worth worrying about. Control for the player's
 * own baseline, which is what these numbers do, and the sign flips to the obvious one: carrying
 * a knock costs you about a point.
 *
 * Someone will eventually notice that a Questionable player is being marked down while the raw
 * data says they score more, and will "correct" it. This paragraph is the answer to that.
 */
export const INJURY_EFFECT = {
  Questionable: -0.99,
  unlisted: 0.22,
  /**
   * Doubtful and Out are NOT measured. Zero is the honest value, not a guess extrapolated off
   * the Questionable figure - a player who is Out scores zero, which is a different claim
   * entirely and belongs upstream of this model, in whoever decides who is on the slate.
   */
  Doubtful: 0,
  Out: 0,
} as const;
export const INJURY_BASIS_MEASURED = `injury designation controlled for the player's own baseline; Questionable -0.99, unlisted +0.22. The raw uncontrolled figure has the opposite sign and is a selection effect (${SOURCE})`;
export const INJURY_BASIS_UNMEASURED = `not measured for this designation; applied as zero rather than extrapolated from the Questionable figure (${SOURCE})`;

// ---------------------------------------------------------------------------------------------
// Simulator settings.
// ---------------------------------------------------------------------------------------------

/** Ten thousand draws per player per week. Enough that p10/p90 are stable to about 0.1 points. */
export const DRAWS_PER_PLAYER = 10000;

/** Fewest games of history before the model will say anything at all about a player. */
export const MIN_GAMES_FOR_BASELINE = 3;

/**
 * Spike rate by volatility tier, at the tier's anchor mean.
 *
 * WHAT THIS IS: a regression fixture. It locks the right tail of every tier in place, so that a
 * change of family, of parameterisation, of the ladder, or of the sampler shows up as one red
 * test naming the tier, rather than as a quietly different headline number on the page.
 *
 * WHAT THIS IS NOT: an independent measurement. CONCEPT.md tabulates mean and sd per tier and
 * does NOT tabulate spike rate per tier, so these are the rates the measured ladder implies
 * under the chosen family, computed once by `gammaSurvival` and written down. Checking the
 * sampler against them proves the sampler agrees with the distribution it claims to draw from.
 * It does not prove the family is right. The family is argued for separately, against the
 * measurements that ARE independent - the concentration figure of 40 per cent and the CV of
 * 0.82 - in `distribution.test.ts`, and those two are what would actually condemn gamma.
 *
 * If the real per-tier table ever gets measured, it replaces this constant and the tolerance
 * comes down. Do not cite these as measured in a `Reason` or on the page.
 */
export const SPIKE_RATE_BY_TIER_FIXTURE: readonly number[] = [
  0.001377, 0.02260, 0.065166, 0.140844, 0.315658,
];
