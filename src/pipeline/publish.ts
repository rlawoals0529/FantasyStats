/**
 * Serialising a season, and refusing to overwrite a good file with a worse one.
 *
 * ## Shape
 *
 * The rows are arrays, not objects, and the player identity is a lookup table rather than
 * three strings repeated on every row. `{"playerId":"00-0036322","name":"Ja'Marr Chase",
 * "position":"WR",...}` is about 90 bytes of key names per row before any data, and a season
 * has some six thousand rows.
 *
 * Measured on 2024, 5,864 rows: this layout is 290 kB and 78 kB gzipped; an object per row is
 * 1,195 kB and 94 kB gzipped. So the large win is uncompressed, which is what the browser
 * parses, and the gzip win is real but modest, because a compressor makes short work of a key
 * name repeated six thousand times. Anyone tempted to switch back on the grounds that gzip
 * flattens the difference should note the 4x on the parse.
 *
 * Rows are emitted one per line. That is not for humans reading the file, it is so that a
 * change to one player-week shows up as one changed line in a diff rather than as a rewritten
 * blob, and it costs one byte per row against a single-line encoding.
 *
 * ## Idempotence
 *
 * `refresh.ts` is meant to run on a schedule, and a scheduled job that rewrites the same bytes
 * with a new timestamp every hour is a job that makes every deploy look like a data change.
 * So `contentHash` is a hash of everything except the timestamp, the existing file's hash is
 * read before writing, and an unchanged season is left alone: same mtime, same bytes, no
 * write at all.
 *
 * ## The write itself
 *
 * Temporary file, then rename. A rename within one filesystem is atomic, so a reader either
 * sees the old complete file or the new complete file and never a half-written one. Combined
 * with `sources.ts` throwing before we get here, the property is: a broken upstream leaves
 * last week's dataset exactly as it was.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

import { NFLVERSE_ATTRIBUTION, NFLVERSE_LICENCE_URL } from "./attribution.ts";
import type { PlayerWeekRow } from "./dataset.ts";

/**
 * Field order of every entry in `rows`. Shipped in the file so a reader never has to guess,
 * and so adding a column is a visible change to the payload rather than an off-by-one.
 */
export const ROW_COLUMNS = [
  "player",
  "week",
  "team",
  "points",
  "targetShare",
  "wopr",
  "snapShare",
  "impliedTotal",
  "injuryStatus",
] as const;

/** `players[i]` is `[playerId, name, position]`, and `player` above is the index `i`. */
export type PlayerEntry = readonly [string, string, string];
export type SerialisedRow = readonly (string | number | null)[];

export type SeasonPayload = {
  readonly attribution: string;
  readonly licence: string;
  readonly season: number;
  readonly columns: readonly string[];
  readonly players: readonly PlayerEntry[];
  readonly rows: readonly SerialisedRow[];
};

export function toPayload(season: number, rows: readonly PlayerWeekRow[]): SeasonPayload {
  const index = new Map<string, number>();
  const players: PlayerEntry[] = [];
  const out: SerialisedRow[] = [];

  for (const row of rows) {
    let i = index.get(row.playerId);
    if (i === undefined) {
      i = players.length;
      index.set(row.playerId, i);
      players.push([row.playerId, row.name, row.position]);
    }
    out.push([
      i,
      row.week,
      row.team,
      row.points,
      row.targetShare,
      row.wopr,
      row.snapShare,
      row.impliedTotal,
      row.injuryStatus,
    ]);
  }

  return {
    // First key in the object, so the licence notice is the first thing in the file. A notice
    // buried at the bottom of six thousand rows is a notice nobody has ever read.
    attribution: NFLVERSE_ATTRIBUTION,
    licence: NFLVERSE_LICENCE_URL,
    season,
    columns: [...ROW_COLUMNS],
    players,
    rows: out,
  };
}

/** Hash of the data, with no timestamp in it. The thing that makes a rerun a no-op. */
export function contentHash(payload: SeasonPayload): string {
  return createHash("sha256").update(serialiseBody(payload)).digest("hex").slice(0, 16);
}

function serialiseBody(payload: SeasonPayload): string {
  const lines: string[] = [];
  lines.push(`"attribution": ${JSON.stringify(payload.attribution)}`);
  lines.push(`"licence": ${JSON.stringify(payload.licence)}`);
  lines.push(`"season": ${payload.season}`);
  lines.push(`"columns": ${JSON.stringify(payload.columns)}`);
  lines.push(`"players": [\n${payload.players.map((p) => JSON.stringify(p)).join(",\n")}\n]`);
  lines.push(`"rows": [\n${payload.rows.map((r) => JSON.stringify(r)).join(",\n")}\n]`);
  return `{\n${lines.join(",\n")}\n}\n`;
}

/**
 * The file as written: the body, with a small header spliced in at the top.
 *
 * `rowCount` is in the header so the next run can find out how big the published season was
 * without parsing the whole file. That number is the shrink guard's input, and the shrink
 * guard is the one that catches a truncation the per-file row floor cannot: a source that
 * still has plenty of rows but has lost a week of them.
 */
export function serialiseSeason(payload: SeasonPayload, generatedAt: string): string {
  const body = serialiseBody(payload);
  const head =
    `{\n"generatedAt": ${JSON.stringify(generatedAt)},\n` +
    `"contentHash": ${JSON.stringify(contentHash(payload))},\n` +
    `"rowCount": ${payload.rows.length},\n` +
    `"playerCount": ${payload.players.length},\n`;
  return head + body.slice(body.indexOf("\n") + 1);
}

export type PublishedSummary = {
  readonly hash: string;
  readonly rowCount: number;
};

/**
 * What is already on disk for this season, read from the first few hundred bytes.
 *
 * Returns null when there is no file, or when the header is not where it should be. Null means
 * "nothing to compare against", which lets a first run through and is the only safe reading:
 * treating an unreadable file as zero rows would make every shrink guard pass.
 */
export async function readPublishedSummary(path: string): Promise<PublishedSummary | null> {
  if (!existsSync(path)) return null;
  const head = (await readFile(path, "utf8").catch(() => "")).slice(0, 512);
  const hash = /"contentHash":\s*"([0-9a-f]+)"/.exec(head);
  const rows = /"rowCount":\s*(\d+)/.exec(head);
  if (hash === null || rows === null || hash[1] === undefined || rows[1] === undefined) return null;
  return { hash: hash[1], rowCount: Number(rows[1]) };
}

export type WriteResult = {
  readonly path: string;
  readonly gzipPath: string;
  /** False when the existing file already held this exact data. */
  readonly written: boolean;
  readonly bytes: number;
  readonly gzipBytes: number;
  readonly hash: string;
};

/**
 * Write one season, or decline to.
 *
 * Reads the hash out of the existing file with a narrow regex rather than parsing several
 * megabytes of JSON to compare one string. If the file is unreadable or the hash is absent,
 * that reads as "different" and we write, which is the safe direction.
 */
export async function writeSeason(
  outDir: string,
  payload: SeasonPayload,
  generatedAt: string,
): Promise<WriteResult> {
  const path = join(outDir, `season-${payload.season}.json`);
  const gzipPath = `${path}.gz`;
  const hash = contentHash(payload);
  const text = serialiseSeason(payload, generatedAt);
  const gzip = gzipSync(Buffer.from(text, "utf8"), { level: 9 });

  if (existsSync(gzipPath)) {
    const existing = await readPublishedSummary(path);
    if (existing !== null && existing.hash === hash) {
      return { path, gzipPath, written: false, bytes: Buffer.byteLength(text), gzipBytes: gzip.length, hash };
    }
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(`${path}.partial`, text, "utf8");
  await rename(`${path}.partial`, path);
  await writeFile(`${gzipPath}.partial`, gzip);
  await rename(`${gzipPath}.partial`, gzipPath);

  return { path, gzipPath, written: true, bytes: Buffer.byteLength(text), gzipBytes: gzip.length, hash };
}

/**
 * The guard the row floors in `sources.ts` cannot provide.
 *
 * A floor catches a download that arrived tiny. It does not catch one that arrived large and
 * incomplete: a stats file still carrying fifteen thousand rows but missing a week, or a
 * release rebuilt for a different season. What catches that is the shape of the thing this
 * pipeline published last time, because a season does not lose weeks.
 *
 * `published` being null means there is nothing to compare against, which is a first run and
 * is allowed. Only a real decrease against a real previous count stops the run.
 */
export function assertNotShrinking(
  season: number,
  rows: number,
  published: PublishedSummary | null,
  allowShrink: boolean,
): void {
  if (published === null || allowShrink) return;
  if (rows >= published.rowCount) return;
  throw new Error(
    `${season}: rebuilt ${rows} rows against ${published.rowCount} already published. ` +
      "A season does not lose weeks. Fix the source, or pass --allow-shrink if a correction " +
      "upstream really did remove rows. Not writing.",
  );
}
