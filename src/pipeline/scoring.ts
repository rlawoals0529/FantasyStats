/**
 * PPR scoring. One implementation, and everything that scores a week imports it.
 *
 * The reason this is its own file rather than three lines inside the builder is that a scoring
 * rule written twice is a leaderboard and a detail page that disagree about the same player,
 * and that bug is invisible until a reader notices the two numbers side by side and stops
 * trusting both. There is exactly one place here where a decimal can be wrong.
 *
 * The formula, in full:
 *
 *   passing yards      / 25
 *   passing touchdown  * 4
 *   interception       * -2
 *   rushing yards      / 10
 *   rushing touchdown  * 6
 *   receiving yards    / 10
 *   receiving touchdown * 6
 *   reception          * 1
 *   fumble lost        * -2
 *
 * Two things this deliberately does NOT score, both verified against the feed rather than
 * assumed:
 *
 * - **Two-point conversions.** nflverse awards 2. The league this models does not have them in
 *   its rule set, so they are out. 100 player-weeks in 2024 were affected.
 * - **Return touchdowns.** nflverse awards 6 for `special_teams_tds`. A punt return score is
 *   not a receiving score and the opportunity model has nothing to say about it, so it is out.
 *   Rashid Shaheed's week 6 in 2024 is the visible case: 8.3 by nflverse, 2.3 here.
 *
 * With those two removed, this function reproduces nflverse's own `fantasy_points_ppr` on all
 * 18,983 rows of the 2024 file to within 0.005. That is the cross-check in
 * `test/pipeline/scoring.test.ts`, and it is the reason the constants below can be trusted.
 */

/** The multipliers, named, so a review can read them without counting decimal places. */
export const PPR = {
  /** Yards per point. Division, not multiplication, because that is how the rule is written. */
  passingYardsPerPoint: 25,
  passingTouchdown: 4,
  interception: -2,
  rushingYardsPerPoint: 10,
  rushingTouchdown: 6,
  receivingYardsPerPoint: 10,
  receivingTouchdown: 6,
  reception: 1,
  fumbleLost: -2,
} as const;

/** Everything the formula consumes, and nothing else. */
export type ScoringLine = {
  readonly passingYards: number;
  readonly passingTouchdowns: number;
  readonly interceptions: number;
  readonly rushingYards: number;
  readonly rushingTouchdowns: number;
  readonly receivingYards: number;
  readonly receivingTouchdowns: number;
  readonly receptions: number;
  /**
   * Offensive fumbles lost only: sack, rushing and receiving.
   *
   * NOT the feed's `fumbles_lost_total`, which also counts fumbles lost on kick and punt
   * returns. 41 rows of the 2024 file differ between the two, and every one of them would have
   * docked a player two points for a muffed punt they were never charged with in fantasy.
   */
  readonly fumblesLost: number;
};

/** PPR points for one player-week. Pure, so the test can hand it hand-computed cases. */
export function pprPoints(line: ScoringLine): number {
  return (
    line.passingYards / PPR.passingYardsPerPoint +
    line.passingTouchdowns * PPR.passingTouchdown +
    line.interceptions * PPR.interception +
    line.rushingYards / PPR.rushingYardsPerPoint +
    line.rushingTouchdowns * PPR.rushingTouchdown +
    line.receivingYards / PPR.receivingYardsPerPoint +
    line.receivingTouchdowns * PPR.receivingTouchdown +
    line.receptions * PPR.reception +
    line.fumblesLost * PPR.fumbleLost
  );
}

/**
 * Two decimal places, for the shipped file.
 *
 * Binary floating point turns 167/25 + 4 + 8.7 into a number with a tail of noise, and JSON
 * serialises that tail in full. Rounding at the boundary is worth about 8 per cent of the file
 * and costs nothing anyone can see: the scoring grid is quarter-points at its finest.
 */
export function roundPoints(points: number): number {
  return Math.round(points * 100) / 100;
}
