/**
 * Game-status designation, joined on gsis id.
 *
 * This is the easy join and it is here to be kept easy. `injuries` carries `gsis_id`, the same
 * identifier `stats_player_week` uses as `player_id`, so there is no name matching and no
 * fallback tier. If a future release drops that column the right response is a loud failure
 * from `requireColumns`, not a slide into matching on names again.
 *
 * The null discipline from `snaps.ts` applies just as hard here, for a different reason. Three
 * states have to stay apart:
 *
 * - **Not on the report at all.** `null`. The overwhelming majority: about 83 per cent of
 *   QB/RB/WR/TE weeks.
 * - **On the report with no game designation.** `"Practice"`. A limited practice with a clean
 *   Friday is information, and it is not the same as never being mentioned.
 * - **A designation.** `"Out"`, `"Doubtful"`, `"Questionable"`.
 *
 * That matters because of one of the measured-false findings in the concept: Questionable
 * players **outscore** unlisted players on raw averages, and only cost -0.99 points once you
 * control for who gets listed in the first place. A model that cannot tell "unlisted" from
 * "listed, no designation" cannot make that control, so the distinction has to survive the
 * pipeline rather than be reconstructed later.
 */

import { str, type Row, type Table } from "./csv.ts";

export const INJURY_COLUMNS = [
  "season",
  "week",
  "game_type",
  "gsis_id",
  "report_status",
  "practice_status",
] as const;

/** Null is a fourth state and is not in this union. See the header. */
export type InjuryStatus = "Out" | "Doubtful" | "Questionable" | "Practice";

const DESIGNATIONS = new Set<string>(["Out", "Doubtful", "Questionable"]);

export type InjuryReport = {
  readonly statuses: ReadonlyMap<string, InjuryStatus>;
  /**
   * Raw `report_status` values seen that are not one of the three designations.
   *
   * nflverse has shipped `"Note"` as a status, and a silently-widened vocabulary is how a new
   * designation ends up mapped to "Practice" for a season without anyone noticing. Printed by
   * the run so a new value is visible the first time it appears.
   */
  readonly unrecognisedStatuses: ReadonlyMap<string, number>;
  readonly rowsIndexed: number;
  /** Same player, same week, two rows. Small, but if it grows the key has stopped being unique. */
  readonly duplicateKeys: number;
};

function key(playerId: string, week: number, seasonType: string): string {
  return `${playerId}|${week}|${seasonType}`;
}

/**
 * Index one season of injury rows.
 *
 * The key is player, week and season type. Season type is in it because week 1 exists twice in
 * a season file, once as REG and once as the wild card round under nflverse's post-season
 * numbering, and merging them would hand a player their January designation in September.
 */
export function indexInjuries(table: Table): InjuryReport {
  const statuses = new Map<string, InjuryStatus>();
  const unrecognised = new Map<string, number>();
  let duplicateKeys = 0;
  let rowsIndexed = 0;

  for (const row of table.rows) {
    const playerId = str(row, "gsis_id");
    const weekRaw = str(row, "week");
    const gameType = str(row, "game_type");
    if (playerId === null || weekRaw === null || gameType === null) continue;
    const week = Number(weekRaw);
    if (!Number.isFinite(week)) continue;

    const reported = str(row, "report_status");
    let status: InjuryStatus;
    if (reported !== null && DESIGNATIONS.has(reported)) {
      status = reported as InjuryStatus;
    } else {
      if (reported !== null) unrecognised.set(reported, (unrecognised.get(reported) ?? 0) + 1);
      status = "Practice";
    }

    const k = key(playerId, week, seasonTypeOf(gameType));
    if (statuses.has(k)) duplicateKeys++;
    statuses.set(k, status);
    rowsIndexed++;
  }

  return { statuses, unrecognisedStatuses: unrecognised, rowsIndexed, duplicateKeys };
}

/**
 * `injuries` spells the post-season out as WC, DIV, CON, SB. `stats_player_week` calls all of
 * it POST. Folded here rather than at the call site so there is one place that knows.
 */
function seasonTypeOf(gameType: string): string {
  return gameType === "REG" ? "REG" : "POST";
}

export function statusFor(
  report: InjuryReport,
  playerId: string,
  week: number,
  seasonType: string,
): InjuryStatus | null {
  return report.statuses.get(key(playerId, week, seasonType)) ?? null;
}

/** Unrecognised statuses, flattened for the run log. */
export function unrecognisedList(report: InjuryReport): ReadonlyArray<[string, number]> {
  return [...report.unrecognisedStatuses.entries()].sort((a, b) => b[1] - a[1]);
}
