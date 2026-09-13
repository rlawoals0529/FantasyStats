/**
 * Turning four feeds into one season of `PlayerWeek`, plus the two fields the page also needs.
 *
 * `PlayerWeek` in `src/shared/player.ts` is a fixed contract and this file produces it exactly:
 * nothing is derived here beyond the points total, which is derived in `scoring.ts` and
 * imported. The two additions, implied team total and injury status, are the two inputs
 * `src/ui/ports.ts` asks for by name and neither of them belongs to the player, which is why
 * they sit alongside `PlayerWeek` rather than inside it.
 *
 * ## What is in, and what is not
 *
 * **Regular season only.** Fantasy leagues finish in week 17 or 18, the concept's measurements
 * are all regular season, and post-season weeks 19 to 22 carry a fifth of a normal slate of
 * players. Including them would make every season average quietly wrong at the tail.
 *
 * **QB, RB, WR and TE only.** That is the `Position` union, and it is not an oversight:
 * kickers and defences do not have a target share and nothing on the page is about them.
 * Fullbacks are dropped with them, which costs 73 rows a season and keeps `position` a total
 * function rather than a cast.
 *
 * ## The rule the whole file obeys
 *
 * Null means we do not know. Zero means we know it was zero. `targetShare`, `wopr`,
 * `snapShare` and `impliedTotal` are all nullable for that reason and none of them is ever
 * defaulted. A receiver with no targets has an unknown target share, not a zero one; a player
 * whose snap row could not be identified has an unknown snap share, not a benching.
 */

import type { PlayerWeek, Position } from "../shared/player.ts";
import { count, num, str, type Table } from "./csv.ts";
import { indexInjuries, statusFor, type InjuryReport, type InjuryStatus } from "./injuries.ts";
import { pprPoints, roundPoints } from "./scoring.ts";
import { ScheduleIndex } from "./schedule.ts";
import { SnapIndex, SnapJoinTally, type SnapJoinReport } from "./snaps.ts";

/** One shipped row: the contract, plus the two fields that describe the situation not the player. */
export type PlayerWeekRow = PlayerWeek & {
  /** The player's own team's implied total from the Vegas line. Null if the game was not lined. */
  readonly impliedTotal: number | null;
  /** Null means not on the injury report at all, which is not the same as healthy-and-listed. */
  readonly injuryStatus: InjuryStatus | null;
};

export const STATS_COLUMNS = [
  "player_id",
  "player_display_name",
  "position",
  "season",
  "week",
  "season_type",
  "game_id",
  "team",
  "passing_yards",
  "passing_tds",
  "passing_interceptions",
  "sack_fumbles_lost",
  "rushing_yards",
  "rushing_tds",
  "rushing_fumbles_lost",
  "receiving_yards",
  "receiving_tds",
  "receiving_fumbles_lost",
  "receptions",
  "target_share",
  "wopr",
] as const;

const POSITIONS = new Set<string>(["QB", "RB", "WR", "TE"]);

export type BuildInputs = {
  readonly season: number;
  readonly stats: Table;
  readonly schedules: Table;
  readonly snaps: Table;
  readonly injuries: Table;
};

export type BuildReport = {
  readonly season: number;
  /** Rows in the stats file before any filtering. */
  readonly statsRows: number;
  /** Rows kept: regular season, QB/RB/WR/TE. */
  readonly kept: number;
  readonly players: number;
  readonly weeks: number;
  readonly snapJoin: SnapJoinReport;
  /** Kept rows whose game had no usable Vegas line. */
  readonly missingImpliedTotal: number;
  /** Kept rows whose `game_id` is absent from the schedule file entirely. Should be zero. */
  readonly unknownGames: number;
  readonly injuries: InjuryReport;
  /** Kept rows carrying an injury designation of any kind. */
  readonly withInjuryStatus: number;
  /** A player whose name or position changed between weeks. Rare, and worth seeing. */
  readonly identityConflicts: number;
};

export type SeasonBuild = {
  readonly rows: readonly PlayerWeekRow[];
  readonly report: BuildReport;
};

export function buildSeason(inputs: BuildInputs): SeasonBuild {
  const schedule = new ScheduleIndex(inputs.schedules);
  const snaps = new SnapIndex(inputs.snaps);
  const injuries = indexInjuries(inputs.injuries);
  const tally = new SnapJoinTally();

  const rows: PlayerWeekRow[] = [];
  const identity = new Map<string, { name: string; position: Position }>();
  const weeks = new Set<number>();
  let missingImpliedTotal = 0;
  let unknownGames = 0;
  let withInjuryStatus = 0;
  let identityConflicts = 0;


  for (const row of inputs.stats.rows) {
    if (str(row, "season_type") !== "REG") continue;
    const position = str(row, "position");
    if (position === null || !POSITIONS.has(position)) continue;

    const playerId = str(row, "player_id");
    const name = str(row, "player_display_name");
    const team = str(row, "team");
    const gameId = str(row, "game_id");
    const season = num(row, "season");
    const week = num(row, "week");
    if (playerId === null || name === null || team === null || gameId === null) continue;
    if (season === null || week === null) continue;

    const known = identity.get(playerId);
    if (known === undefined) identity.set(playerId, { name, position: position as Position });
    else if (known.name !== name || known.position !== position) identityConflicts++;

    // Offensive fumbles only. `fumbles_lost_total` also counts return fumbles; see scoring.ts.
    const fumblesLost =
      count(row, "sack_fumbles_lost") +
      count(row, "rushing_fumbles_lost") +
      count(row, "receiving_fumbles_lost");

    const points = roundPoints(
      pprPoints({
        passingYards: count(row, "passing_yards"),
        passingTouchdowns: count(row, "passing_tds"),
        interceptions: count(row, "passing_interceptions"),
        rushingYards: count(row, "rushing_yards"),
        rushingTouchdowns: count(row, "rushing_tds"),
        receivingYards: count(row, "receiving_yards"),
        receivingTouchdowns: count(row, "receiving_tds"),
        receptions: count(row, "receptions"),
        fumblesLost,
      }),
    );

    const snap = snaps.lookup(gameId, team, name, position);
    tally.record(name, snap.match);

    if (schedule.get(gameId) === null) unknownGames++;
    const implied = schedule.impliedFor(gameId, team);
    if (implied === null) missingImpliedTotal++;

    const injuryStatus = statusFor(injuries, playerId, week, "REG");
    if (injuryStatus !== null) withInjuryStatus++;

    weeks.add(week);
    rows.push({
      playerId,
      name,
      position: position as Position,
      team,
      season,
      week,
      points,
      // Rates, so `num` not `count`: blank is unknown. Rounded because four decimal places is
      // finer than the feed's own precision is meaningful and the tail costs real bytes.
      targetShare: round(num(row, "target_share"), 4),
      wopr: round(num(row, "wopr"), 4),
      snapShare: snap.share,
      impliedTotal: implied,
      injuryStatus,
    });
  }

  // Stable order: player, then week. Deterministic output is what makes a rerun a no-op, and
  // grouping a player's weeks together is what makes the file compress.
  rows.sort((a, b) => (a.playerId === b.playerId ? a.week - b.week : a.playerId < b.playerId ? -1 : 1));

  return {
    rows,
    report: {
      season: inputs.season,
      statsRows: inputs.stats.rows.length,
      kept: rows.length,
      players: identity.size,
      weeks: weeks.size,
      snapJoin: tally.report(inputs.season),
      missingImpliedTotal,
      unknownGames,
      injuries,
      withInjuryStatus,
      identityConflicts,
    },
  };
}

function round(value: number | null, places: number): number | null {
  if (value === null) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
