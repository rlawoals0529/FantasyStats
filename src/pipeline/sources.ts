/**
 * Fetching, caching and refusing to proceed on a bad download.
 *
 * The failure this file is built around: a scheduled job that fetches four files, gets a 404
 * on one of them because a release tag was renamed, treats the empty body as "no rows this
 * week", and writes a valid-looking dataset with a third of the season missing. Nothing
 * throws. The site comes up. The numbers are wrong and the previous good file is gone.
 *
 * So every download is checked before it is believed, and the checks are deliberately blunt:
 *
 * - status must be 2xx,
 * - the body must be non-empty,
 * - it must parse as CSV with consistent row widths,
 * - the columns the pipeline actually reads must all be present,
 * - and the row count must clear a floor supplied by the caller.
 *
 * Any of those failing throws `SourceError` and the run stops. Stopping leaves last week's
 * file in place, which is the correct outcome: stale and complete beats fresh and truncated.
 *
 * Caching is to `data/raw/`, which is gitignored. It exists to be polite to GitHub's release
 * CDN, not to speed anything up: one run fetches each URL at most once, and a second run in
 * the same day reads from disk. A cached file is validated on the way in exactly like a fresh
 * one, so a half-written cache entry from an interrupted run is caught rather than trusted.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseCsv, requireColumns, type Table } from "./csv.ts";

export class SourceError extends Error {
  // Assigned in the body rather than declared as a constructor parameter property: Node runs
  // these files with strip-only type removal, which has no way to emit the assignment a
  // parameter property implies, and refuses to load the module at all.
  readonly url: string;

  constructor(message: string, url: string) {
    super(`${message}\n  source: ${url}`);
    this.name = "SourceError";
    this.url = url;
  }
}

const RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download";

/** The four feeds, as URL builders. Everything upstream is one of these. */
export const nflverse = {
  statsPlayerWeek: (season: number) =>
    `${RELEASE_BASE}/stats_player/stats_player_week_${season}.csv`,
  schedules: () => `${RELEASE_BASE}/schedules/games.csv`,
  snapCounts: (season: number) => `${RELEASE_BASE}/snap_counts/snap_counts_${season}.csv`,
  injuries: (season: number) => `${RELEASE_BASE}/injuries/injuries_${season}.csv`,
} as const;

export type FetchSpec = {
  readonly url: string;
  /** File name inside the cache directory. */
  readonly cacheAs: string;
  /** Columns the pipeline reads. Absence is a schema change and stops the run. */
  readonly requiredColumns: readonly string[];
  /**
   * Fewest rows this file can plausibly have.
   *
   * Not a guess at the real count, a floor under the truncation this is guarding against. A
   * season file with 40 rows is a broken download; one with 4,000 is week 9.
   */
  readonly minRows: number;
};

export type Loader = {
  /** Fetch, validating and caching. Each URL is fetched at most once per `Loader`. */
  load(spec: FetchSpec): Promise<Table>;
  /** URLs that went to the network this run, as opposed to being served from the cache. */
  readonly fetched: readonly string[];
  readonly cacheHits: readonly string[];
};

export type LoaderOptions = {
  readonly cacheDir: string;
  /** Injectable so the suite can drive 404s and truncation without a network. */
  readonly fetchImpl?: typeof fetch;
  /** Skip the cache read and go to the network. The cache is still written. */
  readonly refetch?: boolean;
};

export function createLoader(options: LoaderOptions): Loader {
  const doFetch = options.fetchImpl ?? fetch;
  const inFlight = new Map<string, Promise<Table>>();
  const fetched: string[] = [];
  const cacheHits: string[] = [];

  async function loadOnce(spec: FetchSpec): Promise<Table> {
    const path = join(options.cacheDir, spec.cacheAs);

    if (options.refetch !== true && existsSync(path)) {
      const cached = await readFile(path, "utf8");
      const table = validate(cached, spec);
      cacheHits.push(spec.url);
      return table;
    }

    const response = await doFetch(spec.url);
    if (!response.ok) {
      throw new SourceError(
        `HTTP ${response.status} ${response.statusText}. Refusing to continue: a missing ` +
          "source would be written out as a season with missing rows.",
        spec.url,
      );
    }
    const text = await response.text();
    const table = validate(text, spec);

    // Write through a temporary file. A run killed mid-write otherwise leaves a truncated
    // cache entry that the next run reads as if it were the whole file.
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.partial`;
    await writeFile(tmp, text, "utf8");
    await rename(tmp, path);

    fetched.push(spec.url);
    return table;
  }

  return {
    load(spec) {
      // One fetch per URL per run, no matter how many callers ask. `games.csv` covers every
      // season, so a multi-season refresh would otherwise pull it once per season.
      const existing = inFlight.get(spec.url);
      if (existing !== undefined) return existing;
      const promise = loadOnce(spec);
      inFlight.set(spec.url, promise);
      return promise;
    },
    get fetched() {
      return fetched;
    },
    get cacheHits() {
      return cacheHits;
    },
  };
}

/**
 * Everything between bytes on the wire and a table the pipeline will believe.
 *
 * Exported because the truncation tests drive it directly, and because a caller reading a file
 * some other way should be running the same gate rather than a similar one.
 */
export function validate(text: string, spec: FetchSpec): Table {
  if (text.trim().length === 0) {
    throw new SourceError("empty body. A zero-byte source is a failed download, not zero rows.", spec.url);
  }
  let table: Table;
  try {
    table = parseCsv(text);
  } catch (cause) {
    throw new SourceError(
      `does not parse as CSV: ${cause instanceof Error ? cause.message : String(cause)}`,
      spec.url,
    );
  }
  try {
    requireColumns(table, spec.requiredColumns, "this source");
  } catch (cause) {
    throw new SourceError(cause instanceof Error ? cause.message : String(cause), spec.url);
  }
  if (table.rows.length < spec.minRows) {
    throw new SourceError(
      `${table.rows.length} rows, below the floor of ${spec.minRows}. That is a truncated ` +
        "download. Writing it out would delete most of a season.",
      spec.url,
    );
  }
  return table;
}
