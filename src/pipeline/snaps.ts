/**
 * Attaching snap share, which is the join that can quietly lie to you.
 *
 * Snap counts key on player NAME. There is no gsis id in that file, so this is the one place
 * in the pipeline where two rows are matched on a string a human typed. Three things go wrong
 * and all three are silent:
 *
 * 1. **Spelling.** PFR writes "D.J. Moore", nflverse writes "DJ Moore". Same player.
 * 2. **Legal name against the name on the jersey.** PFR writes "Kenneth Gainwell" and
 *    "Gabriel Davis" where nflverse writes "Kenny" and "Gabe". Same player, and no amount of
 *    punctuation stripping will connect them.
 * 3. **Collision.** The 2023 Jets had Michael Carter at running back and Michael Carter II at
 *    corner. Strip the suffix, which you have to do because the sources disagree about
 *    suffixes, and they become the same key in the same game. The corner played 0 offensive
 *    snaps. Take the first match and the running back's 12, 15, 18 snap weeks become zeroes:
 *    not an error, not a gap, a number that is wrong and looks fine.
 *
 * That last one is the reason this module returns an outcome alongside the value and the
 * reason `snapShare` is `number | null` on the contract. **A player we could not identify gets
 * null. A player who was identified and did not play gets 0.** Collapsing those two is the
 * failure mode this file exists to prevent, so nothing here ever substitutes a zero for a
 * lookup that did not resolve.
 *
 * Measured, 2023 to 2026, on QB/RB/WR/TE regular and post season rows:
 *
 * | season | rows | exact | surname fallback | ambiguous | unmatched |
 * |---|---|---|---|---|---|
 * | 2023 | 6173 | 6102 | 60 | 9 | 2 |
 * | 2024 | 6214 | 6150 | 64 | 0 | 0 |
 * | 2025 | 6396 | 6327 | 48 | 0 | 21 |
 *
 * The 2023 ambiguities are the Michael Carters. The 2025 unmatched are Bam Knight, Gabe Davis
 * and Nyheim Hines, all nickname cases. `refresh.ts` prints this table every run and fails if
 * the unresolved share crosses a threshold, because a join that silently degrades from 0.2 per
 * cent to 30 per cent looks exactly like a lot of players sitting out.
 */

import { num, str, type Row, type Table } from "./csv.ts";
import { firstInitial, normaliseName, surname } from "./names.ts";

/** How a lookup resolved. Reported, never collapsed into the value. */
export type SnapMatch =
  /** Game, team and normalised name all agreed. */
  | "exact"
  /** Name collided within one team and one game; the position broke the tie. */
  | "position"
  /** Names differed; a unique surname on that team in that game, with the same initial, did not. */
  | "surname"
  /** Name collided and the position did not break the tie. Value is null. */
  | "ambiguous"
  /** Nothing on that team in that game answers to this name. Value is null. */
  | "unmatched";

export type SnapLookup = {
  readonly share: number | null;
  readonly match: SnapMatch;
};

export type SnapJoinReport = {
  readonly season: number;
  readonly rows: number;
  readonly exact: number;
  readonly position: number;
  readonly surname: number;
  readonly ambiguous: number;
  readonly unmatched: number;
  /** Names that resolved to nothing, with how many weeks each lost. For the run log. */
  readonly unresolvedNames: ReadonlyArray<{ readonly name: string; readonly weeks: number }>;
};

/** Share of rows where we ended up with no snap figure at all. The number worth watching. */
export function unresolvedShare(report: SnapJoinReport): number {
  if (report.rows === 0) return 0;
  return (report.ambiguous + report.unmatched) / report.rows;
}

type SnapRow = {
  readonly gameId: string;
  readonly team: string;
  readonly player: string;
  readonly position: string | null;
  readonly offensePct: number | null;
};

export const SNAP_COLUMNS = ["game_id", "team", "player", "position", "offense_pct"] as const;

export class SnapIndex {
  readonly #byName = new Map<string, SnapRow[]>();
  readonly #bySurname = new Map<string, SnapRow[]>();

  constructor(table: Table) {
    for (const row of table.rows) {
      const snap = toSnapRow(row);
      if (snap === null) continue;
      push(this.#byName, `${snap.gameId}|${snap.team}|${normaliseName(snap.player)}`, snap);
      push(this.#bySurname, `${snap.gameId}|${snap.team}|${surname(snap.player)}`, snap);
    }
  }

  /**
   * Look up one player-week.
   *
   * `team` is part of every key. That is not redundant with `gameId`: in week 9 of 2024 a
   * receiver called DJ Turner played for Las Vegas against a corner called DJ Turner playing
   * for Cincinnati. Keyed on the game alone they collide and both go null; keyed on game and
   * team they are two different people and both resolve.
   */
  lookup(gameId: string, team: string, name: string, position: string): SnapLookup {
    const exact = this.#byName.get(`${gameId}|${team}|${normaliseName(name)}`);
    if (exact !== undefined && exact.length === 1) {
      return { share: (exact[0] as SnapRow).offensePct, match: "exact" };
    }
    if (exact !== undefined && exact.length > 1) {
      const byPosition = exact.filter((s) => s.position === position);
      if (byPosition.length === 1) {
        return { share: (byPosition[0] as SnapRow).offensePct, match: "position" };
      }
      // Two people, one key, nothing left to separate them. A guess here is a wrong number
      // rather than a missing one, and a wrong number is worse.
      return { share: null, match: "ambiguous" };
    }

    const bySurname = this.#bySurname.get(`${gameId}|${team}|${surname(name)}`);
    if (bySurname !== undefined && bySurname.length === 1) {
      const candidate = bySurname[0] as SnapRow;
      if (firstInitial(candidate.player) === firstInitial(name)) {
        return { share: candidate.offensePct, match: "surname" };
      }
    }
    return { share: null, match: "unmatched" };
  }
}

function toSnapRow(row: Row): SnapRow | null {
  const gameId = str(row, "game_id");
  const team = str(row, "team");
  const player = str(row, "player");
  if (gameId === null || team === null || player === null) return null;
  return {
    gameId,
    team,
    player,
    position: str(row, "position"),
    // `offense_pct` is a fraction, 0 to 1, and is never blank in the files checked. It is read
    // with `num` rather than `count` anyway, so that if a future release starts leaving it
    // empty the result is an unknown rather than a confident zero.
    offensePct: num(row, "offense_pct"),
  };
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

/** Accumulates outcomes across a season so the run can report them. */
export class SnapJoinTally {
  #exact = 0;
  #position = 0;
  #surname = 0;
  #ambiguous = 0;
  #unmatched = 0;
  readonly #unresolved = new Map<string, number>();

  record(name: string, match: SnapMatch): void {
    if (match === "exact") this.#exact++;
    else if (match === "position") this.#position++;
    else if (match === "surname") this.#surname++;
    else {
      if (match === "ambiguous") this.#ambiguous++;
      else this.#unmatched++;
      this.#unresolved.set(name, (this.#unresolved.get(name) ?? 0) + 1);
    }
  }

  report(season: number): SnapJoinReport {
    return {
      season,
      rows: this.#exact + this.#position + this.#surname + this.#ambiguous + this.#unmatched,
      exact: this.#exact,
      position: this.#position,
      surname: this.#surname,
      ambiguous: this.#ambiguous,
      unmatched: this.#unmatched,
      unresolvedNames: [...this.#unresolved.entries()]
        .map(([name, weeks]) => ({ name, weeks }))
        .sort((a, b) => b.weeks - a.weeks),
    };
  }
}

