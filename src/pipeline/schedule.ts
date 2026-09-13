/**
 * Implied team totals from the Vegas line.
 *
 * The arithmetic is trivial and the sign is not. `total_line / 2 +- spread_line / 2` gives one
 * team the higher number and the other the lower, and which is which depends entirely on what
 * `spread_line` is signed against. Get it backwards and every favourite is modelled as an
 * underdog, which does not throw, does not look odd in a spot check, and inverts a signal the
 * probing measured as real: spike rate runs 3.5 per cent at an implied total under 17 and 10.1
 * per cent at 26 or more, so a flipped sign does not weaken that, it reverses it.
 *
 * ## What was verified, and how
 *
 * `spread_line` in nflverse `schedules` is signed **from the home team's point of view, with a
 * positive number meaning the home team is favoured.** Therefore:
 *
 *     home implied = total_line / 2 + spread_line / 2
 *     away implied = total_line / 2 - spread_line / 2
 *
 * Checked three ways against 1,359 regular-season games from 2021 to 2025, all of them with a
 * final score:
 *
 * 1. **The extremes read correctly.** The largest `spread_line` in 2024 is +19.5 for
 *    CLE at BAL, and Baltimore, the home team, won 35 to 10. The most negative is -16.5 for
 *    BAL at NYG, and the Giants, the home team, lost 14 to 35. A positive number is the home
 *    team being favoured.
 * 2. **Accuracy against the actual score.** Root mean squared error of the implied total
 *    against points actually scored is **9.09** under this convention and **11.20** flipped,
 *    over 2,718 team-games. Mean bias is -0.24, so it is very slightly conservative and not
 *    systematically tilted toward either side.
 * 3. **Heavy favourites really do get the higher number.** Bucketing team-games by implied
 *    total and taking the mean points actually scored gives a monotonic ladder: 14.3 at an
 *    implied 14 to 15, 18.9 at 18 to 19, 22.7 at 22 to 23, 27.8 at 26 to 27, 31.2 at 30 to 31.
 *    A flipped sign would have made that ladder run downhill.
 *
 * Test 2 is the one in the suite, because it is the one a mutation can flip.
 */

import { num, str, type Row, type Table } from "./csv.ts";

export const SCHEDULE_COLUMNS = [
  "game_id",
  "season",
  "week",
  "game_type",
  "home_team",
  "away_team",
  "spread_line",
  "total_line",
] as const;

export type GameLine = {
  readonly gameId: string;
  readonly season: number;
  readonly week: number;
  readonly homeTeam: string;
  readonly awayTeam: string;
  /** Positive means the home team is favoured. Verified above; do not flip without redoing it. */
  readonly spreadLine: number | null;
  readonly totalLine: number | null;
};

/**
 * The implied total for one side of one game.
 *
 * Returns null when either half of the line is missing, which happens for games that have not
 * been lined yet and for a handful of older rows. Null, not the total halved, because "we do
 * not know what Vegas thinks" and "Vegas thinks this is a coin flip" are different claims and
 * only one of them is true.
 */
export function impliedTotal(game: GameLine, team: string): number | null {
  if (game.totalLine === null || game.spreadLine === null) return null;
  const half = game.totalLine / 2;
  const edge = game.spreadLine / 2;
  if (team === game.homeTeam) return round2(half + edge);
  if (team === game.awayTeam) return round2(half - edge);
  return null;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Games keyed by the nflverse `game_id`, which every other feed also carries. */
export class ScheduleIndex {
  readonly #byGame = new Map<string, GameLine>();

  constructor(table: Table) {
    for (const row of table.rows) {
      const game = toGameLine(row);
      if (game !== null) this.#byGame.set(game.gameId, game);
    }
  }

  get(gameId: string): GameLine | null {
    return this.#byGame.get(gameId) ?? null;
  }

  /** Implied total for a team in a game, or null if the game or the line is unknown. */
  impliedFor(gameId: string, team: string): number | null {
    const game = this.#byGame.get(gameId);
    if (game === undefined) return null;
    return impliedTotal(game, team);
  }

  get size(): number {
    return this.#byGame.size;
  }
}

function toGameLine(row: Row): GameLine | null {
  const gameId = str(row, "game_id");
  const homeTeam = str(row, "home_team");
  const awayTeam = str(row, "away_team");
  const season = num(row, "season");
  const week = num(row, "week");
  if (gameId === null || homeTeam === null || awayTeam === null) return null;
  if (season === null || week === null) return null;
  return {
    gameId,
    season,
    week,
    homeTeam,
    awayTeam,
    spreadLine: num(row, "spread_line"),
    totalLine: num(row, "total_line"),
  };
}
