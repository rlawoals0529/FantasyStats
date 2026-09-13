/**
 * The shapes everything here shares, and the one thing none of them has.
 *
 * There is no `projectedPoints: number` anywhere in this file, and that absence is the whole
 * design. A single number is what every other tool in this category prints, and it is a claim
 * none of them can support: measured over four seasons, the typical weekly error is 6.2 points
 * against a mean of about 7. Printing `12.4` is printing noise with a decimal point on it.
 *
 * What replaces it is `Outlook`, which carries a distribution. Anything that wants a headline
 * figure has to choose one deliberately and say which it chose.
 */

export type Position = "QB" | "RB" | "WR" | "TE";

/** One player, one week, as the feeds reported it. Nothing here is derived. */
export type PlayerWeek = {
  playerId: string;
  name: string;
  position: Position;
  team: string;
  season: number;
  week: number;
  points: number;
  /** Share of team targets. The stickiest opportunity signal measured, r = 0.860. */
  targetShare: number | null;
  /** Weighted opportunity rating. Stickier still at 0.878, but a weaker predictor alone. */
  wopr: number | null;
  /** Share of offensive snaps. Best single-week signal found, r = 0.619. */
  snapShare: number | null;
};

/**
 * What the model says about a player for a coming week.
 *
 * Quantiles rather than a mean, because the spread is the information. `spike` is the headline
 * because a season is concentrated: about 40 per cent of a player's points arrive in their best
 * three weeks, so the question worth answering is not "how many" but "what are the odds this is
 * one of the big ones".
 */
export type Outlook = {
  playerId: string;
  /** Points at the 10th, 50th and 90th percentile of the simulated distribution. */
  p10: number;
  p50: number;
  p90: number;
  /** Probability of a week at or above `SPIKE_POINTS`. The number the page leads with. */
  spike: number;
  /** Probability of a week that sinks a lineup, at or below `BUST_POINTS`. */
  bust: number;
  /** Every input that moved this outlook, so the panel can show its working. */
  because: Reason[];
};

/** One contributing factor, with its own measured effect size rather than an adjective. */
export type Reason = {
  /** e.g. "opportunity gap", "implied team total", "injury designation". */
  label: string;
  /** What the input was. */
  value: string;
  /** Its effect on expected points per game, signed. Measured, never asserted. */
  effect: number;
  /** Where the effect size comes from, so a reader can check it. */
  basis: string;
};

/** At or above this, a week is a spike. 20 PPR is the threshold the probing used throughout. */
export const SPIKE_POINTS = 20;
/** At or below this, a week has cost you the matchup. */
export const BUST_POINTS = 5;

/**
 * Two outlooks the model cannot tell apart.
 *
 * Returned instead of an ordering when distributions overlap past `SEPARABLE_OVERLAP`. Ranking
 * them anyway is the category's standard behaviour and it is a lie told with a sort function:
 * at CV 0.82 the seventh and eleventh ranked players are routinely indistinguishable.
 */
export type Tie = { a: string; b: string; overlap: number };

/** Above this overlap of the two distributions, the pair is reported as tied. */
export const SEPARABLE_OVERLAP = 0.8;
