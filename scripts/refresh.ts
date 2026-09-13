/**
 * The scheduled entry point. Fetch, build, publish, or fail with the reason on stderr.
 *
 * Run it with `npm run refresh`, or `npm run refresh -- 2023 2024 2025` to rebuild past
 * seasons. With no arguments it does the season that is currently being played, which is the
 * only one that changes week to week.
 *
 * ## The two properties this file exists to hold
 *
 * **Idempotent.** Running it twice in a row does nothing the second time: sources come from
 * the on-disk cache, the payload hashes to the same value, and `writeSeason` declines to
 * rewrite the file. Same bytes, same mtime. A cron job that runs hourly during a season leaves
 * no trace on the days nothing happened.
 *
 * **Loud, never truncating.** Four separate gates, because the failure mode being guarded
 * against is not an exception, it is a plausible-looking smaller file:
 *
 * 1. `sources.ts` refuses any non-2xx, empty body, unparseable CSV, missing column, or file
 *    with fewer rows than the floor below.
 * 2. The snap join fails the run if more than `MAX_UNRESOLVED` of rows could not be identified.
 *    A name join that silently degrades looks like a lot of players sitting out.
 * 3. A rebuilt season with fewer rows than the one already published stops the run. This is
 *    the gate the row floors cannot provide: a source can be well over its floor and still
 *    have lost a week.
 * 4. Writes go to a temporary file and are renamed, so a reader sees the old complete file or
 *    the new complete file and never a partial one.
 *
 * Every one of those leaves the previous dataset in place. Stale and complete beats fresh and
 * truncated, because the stale file can be fixed by rerunning and the truncated one cannot be
 * distinguished from the truth by anyone downstream.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import { buildSeason, STATS_COLUMNS, type BuildReport } from "../src/pipeline/dataset.ts";
import { INJURY_COLUMNS } from "../src/pipeline/injuries.ts";
import {
  assertNotShrinking,
  readPublishedSummary,
  toPayload,
  writeSeason,
} from "../src/pipeline/publish.ts";
import { SCHEDULE_COLUMNS } from "../src/pipeline/schedule.ts";
import { SNAP_COLUMNS, unresolvedShare } from "../src/pipeline/snaps.ts";
import { createLoader, nflverse, SourceError, type Loader } from "../src/pipeline/sources.ts";

/**
 * Above this share of unidentifiable snap rows, the run fails.
 *
 * Measured, the worst of 2023 to 2025 is 0.33 per cent. Five per cent is fifteen times that,
 * so it will not trip on a normal week, and it is far below the share you would see if PFR
 * changed its name formatting or the file started arriving for the wrong season.
 */
const MAX_UNRESOLVED = 0.05;

/**
 * Row floors, per source, for a season that has finished.
 *
 * These are floors under a truncated download, not estimates. A completed season carries about
 * 18,000 stats rows, 26,000 snap rows and 6,000 injury rows, so these sit comfortably below
 * the real numbers and well above anything a broken fetch would produce.
 *
 * A season still being played is exempt, because in September it genuinely does have 47 rows.
 * The shrink guard covers that case instead, and covers it better: it compares against what
 * this pipeline itself published last week rather than against a number written down here.
 */
const COMPLETED_SEASON_FLOORS = { stats: 15_000, snaps: 20_000, injuries: 2_000 } as const;
const IN_PROGRESS_FLOORS = { stats: 1, snaps: 1, injuries: 1 } as const;
/** `games.csv` is every season at once and is never small. */
const SCHEDULE_FLOOR = 2_000;

type Options = {
  readonly seasons: readonly number[];
  readonly outDir: string;
  readonly cacheDir: string;
  readonly refetch: boolean;
  readonly allowShrink: boolean;
};

/**
 * Which season is being played right now.
 *
 * The NFL year is named for the September it starts in, so anything from January to August
 * belongs to the previous year's season. Getting this wrong in January would have the job
 * fetching a season that does not exist yet and failing on a 404, which is at least loud.
 */
export function currentSeason(now: Date): number {
  return now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
}

function parseArgs(argv: readonly string[], now: Date): Options {
  const seasons: number[] = [];
  let outDir = "public/data";
  let cacheDir = "data/raw";
  let refetch = false;
  let allowShrink = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--out") outDir = argv[++i] ?? outDir;
    else if (arg === "--cache") cacheDir = argv[++i] ?? cacheDir;
    else if (arg === "--refetch") refetch = true;
    else if (arg === "--allow-shrink") allowShrink = true;
    else if (/^\d{4}$/.test(arg)) seasons.push(Number(arg));
    else throw new Error(`unrecognised argument: ${arg}`);
  }

  return {
    seasons: seasons.length > 0 ? seasons : [currentSeason(now)],
    outDir,
    cacheDir,
    refetch,
    allowShrink,
  };
}

/** One season, end to end. Throws on any gate; the caller turns that into an exit code. */
async function refreshSeason(
  loader: Loader,
  season: number,
  options: Options,
  now: Date,
): Promise<void> {
  const completed = season < currentSeason(now);
  const floors = completed ? COMPLETED_SEASON_FLOORS : IN_PROGRESS_FLOORS;

  const [stats, schedules, snaps, injuries] = await Promise.all([
    loader.load({
      url: nflverse.statsPlayerWeek(season),
      cacheAs: `stats_player_week_${season}.csv`,
      requiredColumns: STATS_COLUMNS,
      minRows: floors.stats,
    }),
    loader.load({
      url: nflverse.schedules(),
      cacheAs: "games.csv",
      requiredColumns: SCHEDULE_COLUMNS,
      minRows: SCHEDULE_FLOOR,
    }),
    loader.load({
      url: nflverse.snapCounts(season),
      cacheAs: `snap_counts_${season}.csv`,
      requiredColumns: SNAP_COLUMNS,
      minRows: floors.snaps,
    }),
    loader.load({
      url: nflverse.injuries(season),
      cacheAs: `injuries_${season}.csv`,
      requiredColumns: INJURY_COLUMNS,
      minRows: floors.injuries,
    }),
  ]);

  const { rows, report } = buildSeason({ season, stats, schedules, snaps, injuries });
  printReport(report);

  if (rows.length === 0) {
    throw new Error(
      `${season}: built zero rows from ${stats.rows.length} stats rows. Something upstream ` +
        "changed shape. Not writing, so the published season survives.",
    );
  }

  const unresolved = unresolvedShare(report.snapJoin);
  if (unresolved > MAX_UNRESOLVED) {
    throw new Error(
      `${season}: ${(unresolved * 100).toFixed(2)}% of rows could not be matched to a snap ` +
        `count, above the ${(MAX_UNRESOLVED * 100).toFixed(0)}% limit. The name join has ` +
        "broken rather than the players having sat out. Not writing.",
    );
  }

  const payload = toPayload(season, rows);
  const path = join(options.outDir, `season-${season}.json`);
  assertNotShrinking(season, rows.length, await readPublishedSummary(path), options.allowShrink);

  await mkdir(options.outDir, { recursive: true });
  const result = await writeSeason(options.outDir, payload, now.toISOString());
  const size = `${kb(result.bytes)} kB, ${kb(result.gzipBytes)} kB gzipped`;
  console.log(
    result.written
      ? `  wrote ${result.path}  (${size})`
      : `  unchanged, left ${result.path} alone  (${size})`,
  );
}

function printReport(r: BuildReport): void {
  const j = r.snapJoin;
  console.log(`\n${r.season}`);
  console.log(
    `  ${r.kept} player-weeks from ${r.statsRows} stats rows, ` +
      `${r.players} players across ${r.weeks} weeks`,
  );
  console.log(
    `  snap join: ${j.exact} exact, ${j.position} by position, ${j.surname} by surname, ` +
      `${j.ambiguous} ambiguous, ${j.unmatched} unmatched ` +
      `(${(unresolvedShare(j) * 100).toFixed(2)}% with no snap figure)`,
  );
  if (j.unresolvedNames.length > 0) {
    const names = j.unresolvedNames.slice(0, 8).map((u) => `${u.name} x${u.weeks}`);
    console.log(`    unresolved: ${names.join(", ")}`);
  }
  console.log(
    `  vegas: ${r.kept - r.missingImpliedTotal} rows with an implied total, ` +
      `${r.missingImpliedTotal} without` +
      (r.unknownGames > 0 ? `, ${r.unknownGames} with no schedule row at all` : ""),
  );
  console.log(`  injuries: ${r.withInjuryStatus} rows carry a status, ${r.kept - r.withInjuryStatus} are not on the report`);
  for (const [status, n] of r.injuries.unrecognisedStatuses) {
    console.log(`    unrecognised report_status ${JSON.stringify(status)} on ${n} rows, filed as Practice`);
  }
  if (r.identityConflicts > 0) console.log(`  ${r.identityConflicts} rows where a player's name or position changed mid-season`);
}

function kb(bytes: number): string {
  return (bytes / 1000).toFixed(0);
}

async function main(): Promise<void> {
  const now = new Date();
  const options = parseArgs(process.argv.slice(2), now);
  const loader = createLoader({ cacheDir: options.cacheDir, refetch: options.refetch });

  console.log(
    `refreshing ${options.seasons.join(", ")} into ${options.outDir} ` +
      `(cache ${options.cacheDir}${options.refetch ? ", forced refetch" : ""})`,
  );

  for (const season of options.seasons) {
    await refreshSeason(loader, season, options, now);
  }

  console.log(
    `\n${loader.fetched.length} file(s) fetched, ${loader.cacheHits.length} served from cache.`,
  );
}

/**
 * Only run when this file is the thing that was invoked.
 *
 * Without the guard, importing anything from here to test it starts a real refresh, which
 * means the suite either hits the network or silently depends on a warm cache.
 */
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    // Everything above throws rather than returning a partial result, so this is the only
    // place that decides what a failure looks like, and it decides: a non-zero exit and the
    // reason. A scheduler that sees exit 0 will not page anyone.
    if (error instanceof SourceError) console.error(`\nrefresh failed on a source.\n${error.message}`);
    else console.error(`\nrefresh failed.\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
