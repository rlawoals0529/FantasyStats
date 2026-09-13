/**
 * What the model needs that a `PlayerWeek` does not carry, split by WHEN it becomes knowable.
 *
 * `PlayerWeek` is the outcome of a week and is therefore radioactive before kickoff: every field
 * on it, points included, exists only because the game has been played. The Vegas line and the
 * injury report are the opposite - they are published before kickoff and using them to predict
 * that week is not leakage, it is the entire point of having them.
 *
 * Keeping those two in separate types is how the boundary is enforced by the compiler rather
 * than by remembering. A function that takes `KickoffFacts` cannot reach a score, and a function
 * that takes past `PlayerWeek`s gets them through an `AsOfWindow`, which has already dropped the
 * future. The alternative - one fat row with `points` next to `impliedTeamTotal` - is how a
 * backtest ends up quietly brilliant.
 */

/** The game-status column of the injury report. Practice participation is not modelled. */
export type InjuryDesignation = "Questionable" | "Doubtful" | "Out";

/** Published before kickoff, so legitimately usable to predict the week it belongs to. */
export type KickoffFacts = {
  playerId: string;
  season: number;
  week: number;
  /** Vegas total adjusted by the spread, in points. Null when the line is not available. */
  impliedTeamTotal: number | null;
  /** Null means unlisted, which is a measured state with its own effect, not missing data. */
  injuryStatus: InjuryDesignation | null;
};

/**
 * Touchdowns scored in a week. Known only afterwards, so it lives here rather than on
 * `KickoffFacts` and only ever reaches the model through an `AsOfWindow`.
 *
 * Separate from `PlayerWeek` because that type is a fixed contract owned elsewhere and this is
 * a derived column off play-by-play. Joined on the same key.
 */
export type TouchdownWeek = {
  playerId: string;
  season: number;
  week: number;
  touchdowns: number;
};

/** Anything keyed to one player and one week, which is everything the as-of filter handles. */
export type Dated = { playerId: string; season: number; week: number };
