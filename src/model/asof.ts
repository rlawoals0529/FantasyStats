/**
 * The leakage barrier. Every read of history goes through here and there is no second door.
 *
 * Using an end-of-season aggregate to predict week 4 produces a model that looks superb and is
 * worth nothing, and it does not announce itself: the metrics simply come out better than the
 * category's best and nobody questions a good number. This file is the answer to that, and the
 * answer is structural rather than careful.
 *
 * Three things hold the line:
 *
 * 1. `AsOfWindow` is branded, so the compiler refuses a raw `PlayerWeek[]` where a feature
 *    function expects a window. You cannot forget to filter, because unfiltered rows do not
 *    have the type.
 * 2. `asOf` re-checks every row it keeps and throws on one that is at or after the boundary.
 *    Belt and braces against the filter predicate being edited into something subtly wrong.
 * 3. `test/model/asof.test.ts` poisons the future - it plants a week worth 999 points after the
 *    boundary - and asserts every registered feature returns exactly what it returns with those
 *    rows deleted. A feature that can see the future moves, and a named test goes red. That is
 *    the test that actually enforces this; 1 and 2 only make it hard to get wrong by accident.
 *
 * The boundary is exclusive. Predicting week N may use weeks up to and including N-1 and not
 * week N, not even its final score, not even to decide whether the player was active.
 */

import type { PlayerWeek } from "../shared/player.ts";
import type { TouchdownWeek } from "./inputs.ts";

/** The week being predicted. Everything strictly before it is fair game. */
export type AsOfBoundary = { season: number; week: number };

/**
 * History, already cut at a boundary. The brand is load-bearing: it is what stops an unfiltered
 * array being passed to a feature function, and it is why `asOf` is the only constructor.
 */
export type AsOfWindow = {
  readonly __asOf: "as-of-window";
  readonly boundary: AsOfBoundary;
  readonly weeks: readonly PlayerWeek[];
  readonly touchdowns: readonly TouchdownWeek[];
};

/**
 * True when `row` happened strictly before `boundary`. The one definition of "before" in the model.
 *
 * Takes the week coordinates only, not a whole `Dated`, so a caller checking a row it built
 * itself does not have to invent a player id to ask the question.
 */
export function isBefore(row: { season: number; week: number }, boundary: AsOfBoundary): boolean {
  if (row.season !== boundary.season) return row.season < boundary.season;
  return row.week < boundary.week;
}

/**
 * Cut history at a boundary.
 *
 * The re-check on the way out is not redundant with the filter. It is there because the filter
 * is one expression that someone will one day edit - `<=` instead of `<` is a one-character
 * change that leaks the target week itself and makes every metric better.
 */
export function asOf(
  boundary: AsOfBoundary,
  weeks: readonly PlayerWeek[],
  touchdowns: readonly TouchdownWeek[] = [],
): AsOfWindow {
  const keptWeeks = weeks.filter((row) => isBefore(row, boundary));
  const keptTouchdowns = touchdowns.filter((row) => isBefore(row, boundary));
  for (const row of [...keptWeeks, ...keptTouchdowns]) {
    if (!isBefore(row, boundary)) {
      throw new Error(
        `as-of violation: ${row.playerId} ${row.season} week ${row.week} is not before ` +
          `${boundary.season} week ${boundary.week}`,
      );
    }
  }
  return {
    __asOf: "as-of-window",
    boundary,
    weeks: Object.freeze(keptWeeks),
    touchdowns: Object.freeze(keptTouchdowns),
  };
}

/** Every past week for one player, oldest first. */
export function weeksFor(window: AsOfWindow, playerId: string): readonly PlayerWeek[] {
  return window.weeks
    .filter((row) => row.playerId === playerId)
    .sort((a, b) => a.season - b.season || a.week - b.week);
}

/** Every past touchdown row for one player. */
export function touchdownsFor(window: AsOfWindow, playerId: string): readonly TouchdownWeek[] {
  return window.touchdowns.filter((row) => row.playerId === playerId);
}
