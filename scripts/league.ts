/**
 * The seam between the published dataset and the model, which no single slice owned.
 *
 * `refresh.ts` writes a column-oriented file because that is what keeps a season under 80 kB
 * and makes a one-week change a one-line diff. The model wants rows of named fields. Neither
 * shape is wrong and converting is cheap, so the conversion lives here rather than either side
 * bending to the other.
 *
 * Touchdown counts are NOT in the published columns, so `touchdowns` comes back empty and the
 * touchdown-regression feature has nothing to work with. That is stated here rather than
 * quietly returning zeroes, because a zero would read as "this player scored none" when the
 * truth is "this file does not carry it". Adding it is one column in the pipeline.
 */
import { readFileSync } from "node:fs";
import type { PlayerWeek, Position } from "../src/shared/player.ts";
import type { KickoffFacts, InjuryDesignation, TouchdownWeek } from "../src/model/inputs.ts";

type Published = {
  season: number;
  columns: string[];
  players: [string, string, string][];
  rows: (string | number | null)[][];
};

export type League = {
  weeks: PlayerWeek[];
  touchdowns: TouchdownWeek[];
  kickoffs: KickoffFacts[];
};

const POSITIONS = new Set<Position>(["QB", "RB", "WR", "TE"]);
const DESIGNATIONS = new Set<InjuryDesignation>(["Questionable", "Doubtful", "Out"]);

export function readSeason(path: string): League {
  const d = JSON.parse(readFileSync(path, "utf8")) as Published;
  // Indices by name, so a column reordering upstream cannot silently shift every field.
  const at = (name: string): number => {
    const i = d.columns.indexOf(name);
    if (i < 0) throw new Error(`${path} has no column "${name}"; it has ${d.columns.join(", ")}`);
    return i;
  };
  const [cPlayer, cWeek, cTeam, cPoints, cTargetShare, cWopr, cSnapShare, cImplied, cInjury] =
    ["player", "week", "team", "points", "targetShare", "wopr", "snapShare", "impliedTotal", "injuryStatus"].map(at);

  const weeks: PlayerWeek[] = [];
  const kickoffs: KickoffFacts[] = [];
  for (const r of d.rows) {
    const p = d.players[r[cPlayer!] as number];
    if (!p) throw new Error(`${path} row references player index ${r[cPlayer!]} which does not exist`);
    const [playerId, name, pos] = p;
    if (!POSITIONS.has(pos as Position)) continue;
    const week = r[cWeek!] as number;
    weeks.push({
      playerId, name, position: pos as Position, team: r[cTeam!] as string,
      season: d.season, week,
      points: r[cPoints!] as number,
      targetShare: r[cTargetShare!] as number | null,
      wopr: r[cWopr!] as number | null,
      snapShare: r[cSnapShare!] as number | null,
    });
    const status = r[cInjury!];
    kickoffs.push({
      playerId, season: d.season, week,
      impliedTeamTotal: r[cImplied!] as number | null,
      injuryStatus: typeof status === "string" && DESIGNATIONS.has(status as InjuryDesignation)
        ? (status as InjuryDesignation)
        : null,
    });
  }
  return { weeks, touchdowns: [], kickoffs };
}

/** Several seasons as one league, so a backtest can train on early years and test on a later one. */
export function readSeasons(paths: readonly string[]): League {
  const all = paths.map(readSeason);
  return {
    weeks: all.flatMap((l) => l.weeks),
    touchdowns: all.flatMap((l) => l.touchdowns),
    kickoffs: all.flatMap((l) => l.kickoffs),
  };
}
