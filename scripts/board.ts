/**
 * Run the model over real football and publish the week the page renders.
 *
 * The last seam. `refresh.ts` fetches and normalises, `src/model` decides, `src/ui` draws, and
 * this is the only place that knows all three. Keeping it a script rather than a build plugin
 * means the output is a file you can open and read, which is the whole reason the calibration
 * defect in the model was findable at all.
 *
 * Densities are histograms of the simulator's own draws over the shared grid, not the gamma's
 * analytic pdf. Those are close but not identical, and this page compares areas: drawing the
 * analytic curve while quoting a spike probability counted off the draws would put a number
 * beside a picture of something slightly different, which is the exact failure this project
 * exists to avoid.
 *
 * `asOf` plus `outlookFor` rather than `weekOutlook`, because the board needs each simulation's
 * draws and `weekOutlook` hands back only the `Outlook`. The leakage barrier does not move:
 * `asOf` still does the cutting and throws rather than filtering quietly.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { asOf, outlookFor, findTies, SOURCE } from "../src/model/index.ts";
import type { Simulation } from "../src/model/simulate.ts";
import type { PlayerWeek, Position, Tie } from "../src/shared/player.ts";
import { GRID_SIZE, GRID_STEP, gridIndex } from "../src/ui/ports.ts";
import { readSeasons } from "./league.ts";

/** A player needs this many prior games before the model will speak about them. */
const MIN_GAMES = 4;
/** How many reach the board. A board is a board, not a database dump. */
const BOARD_SIZE = 48;

/** Normalised so the array integrates to 1 across the grid, which is what the port promises. */
function densityOf(draws: Float64Array): number[] {
  const d = new Array<number>(GRID_SIZE).fill(0);
  for (const v of draws) d[gridIndex(v)]! += 1;
  const scale = 1 / (draws.length * GRID_STEP);
  return d.map((n) => n * scale);
}

function main(argv: readonly string[]): void {
  const seasons = [2022, 2023, 2024, 2025];
  const league = readSeasons(seasons.map((y) => "public/data/season-" + y + ".json"));

  const latest = league.weeks.reduce((a, w) =>
    w.season > a.season || (w.season === a.season && w.week > a.week) ? w : a);
  const season = Number(argv[0] ?? latest.season);
  const week = Number(argv[1] ?? latest.week);

  type Prior = { playerId: string; position: Position; games: number; name: string; team: string };
  const prior = new Map<string, Prior>();
  for (const w of league.weeks) {
    if (w.season !== season || w.week >= week) continue;
    const e = prior.get(w.playerId) ?? { playerId: w.playerId, position: w.position, games: 0, name: w.name, team: w.team };
    e.games += 1; e.name = w.name; e.team = w.team;
    prior.set(w.playerId, e);
  }
  const roster = [...prior.values()].filter((p) => p.games >= MIN_GAMES);
  console.log(season + " week " + week + ": " + roster.length + " players with " + MIN_GAMES + "+ prior games");

  const window = asOf({ season, week }, league.weeks, league.touchdowns);
  const kickoffAt = new Map(
    league.kickoffs.filter((k) => k.season === season && k.week === week).map((k) => [k.playerId, k]),
  );
  const sims: Simulation[] = [];
  const skipped: string[] = [];
  for (const p of roster) {
    const sim = outlookFor(window, p.playerId, p.position, kickoffAt.get(p.playerId) ?? null);
    if (sim) sims.push(sim); else skipped.push(p.playerId);
  }
  console.log("  " + sims.length + " outlooks, " + skipped.length + " skipped for want of history");

  const top = [...sims].sort((a, b) => b.outlook.spike - a.outlook.spike).slice(0, BOARD_SIZE);
  const lastRow = new Map<string, PlayerWeek>();
  for (const w of league.weeks) if (w.season === season && w.week < week) lastRow.set(w.playerId, w);

  const players = top.map((s) => {
    const o = s.outlook;
    const p = prior.get(o.playerId)!;
    const last = lastRow.get(o.playerId);
    return {
      outlook: o,
      name: p.name,
      position: p.position,
      team: p.team,
      opponent: null,
      density: densityOf(s.draws),
      targetShare: last?.targetShare ?? null,
      wopr: last?.wopr ?? null,
      snapShare: last?.snapShare ?? null,
      impliedTotal: kickoffAt.get(o.playerId)?.impliedTeamTotal ?? null,
    };
  });

  const board = {
    season,
    week,
    generatedAt: new Date().toISOString(),
    players,
    // Recomputed on the cut set, so the list the renderer checks itself against is the list it
    // is actually drawing.
    ties: findTies(top) as Tie[],
    regression: [],
    scorecard: [],
    scorecardNote:
      "built from " + SOURCE + ". The scorecard fills in once this has predicted weeks it has then seen.",
  };
  mkdirSync("public/data", { recursive: true });
  const path = "public/data/board.json";
  writeFileSync(path, JSON.stringify(board));
  console.log("  wrote " + path + ", " + (readFileSync(path).length / 1024).toFixed(0) + " kB, "
    + players.length + " on the board, " + board.ties.length + " tied pairs");
}

main(process.argv.slice(2));
