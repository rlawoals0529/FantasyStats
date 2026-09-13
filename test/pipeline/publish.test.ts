/**
 * Serialising, and the two properties a scheduled job needs.
 *
 * **Idempotence**, because a cron job that rewrites the same bytes with a fresh timestamp makes
 * every deploy look like a data change and buries a real one.
 *
 * **Never replacing a good file with a worse one**, because that is the failure this whole
 * slice is built around: a pipeline that writes an empty dataset on a 404 deletes the thing it
 * maintains. `sources.ts` stops a bad fetch; this stops a bad write.
 */

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { NFLVERSE_ATTRIBUTION } from "../../src/pipeline/attribution.ts";
import { buildSeason } from "../../src/pipeline/dataset.ts";
import {
  contentHash,
  readPublishedSummary,
  ROW_COLUMNS,
  serialiseSeason,
  toPayload,
  writeSeason,
} from "../../src/pipeline/publish.ts";
import { fixture } from "./helpers.ts";

const build = buildSeason({
  season: 2024,
  stats: fixture("stats-2024-w1.csv"),
  schedules: fixture("games-2024.csv"),
  snaps: fixture("snaps-2024-w1.csv"),
  injuries: fixture("injuries-2024-w1.csv"),
});
const payload = toPayload(2024, build.rows);
const AT = "2026-09-12T00:00:00.000Z";

const tempDir = (): string => mkdtempSync(join(tmpdir(), "spike-publish-"));

describe("the shape on disk", () => {
  it("is valid JSON", () => {
    expect(() => JSON.parse(serialiseSeason(payload, AT))).not.toThrow();
  });

  it("carries the nflverse attribution in the shipped file", () => {
    // A licence condition, not a courtesy. Nobody who receives this file reads the source, so
    // a notice that lives only in a comment has not been given.
    const parsed = JSON.parse(serialiseSeason(payload, AT)) as Record<string, unknown>;
    expect(parsed["attribution"]).toBe(NFLVERSE_ATTRIBUTION);
    expect(String(parsed["attribution"])).toContain("CC BY 4.0");
    expect(String(parsed["attribution"])).toContain("nflverse");
    expect(String(parsed["licence"])).toContain("creativecommons.org");
  });

  it("says CC BY 4.0 and not CC BY-SA 4.0", () => {
    // Different licence, and BY-SA carries a share-alike obligation this project does not
    // have. Worth a test of its own because the two strings differ by three characters.
    expect(NFLVERSE_ATTRIBUTION).not.toContain("BY-SA");
  });

  it("names its own columns, so a reader never counts positions", () => {
    const parsed = JSON.parse(serialiseSeason(payload, AT)) as { columns: string[]; rows: unknown[][] };
    expect(parsed.columns).toEqual([...ROW_COLUMNS]);
    expect(parsed.rows[0]).toHaveLength(ROW_COLUMNS.length);
  });

  it("round-trips a row back to the values that went in", () => {
    const parsed = JSON.parse(serialiseSeason(payload, AT)) as {
      players: [string, string, string][];
      rows: (string | number | null)[][];
    };
    const first = build.rows[0];
    const row = parsed.rows[0] as (string | number | null)[];
    const player = parsed.players[row[0] as number] as [string, string, string];
    expect(player[0]).toBe(first?.playerId);
    expect(player[1]).toBe(first?.name);
    expect(player[2]).toBe(first?.position);
    expect(row[1]).toBe(first?.week);
    expect(row[2]).toBe(first?.team);
    expect(row[3]).toBe(first?.points);
    expect(row[6]).toBe(first?.snapShare);
    expect(row[7]).toBe(first?.impliedTotal);
    expect(row[8]).toBe(first?.injuryStatus);
  });

  it("keeps a null as null through the file, never as a zero", () => {
    const text = serialiseSeason(payload, AT);
    const parsed = JSON.parse(text) as { rows: (string | number | null)[][] };
    const nullsIn = build.rows.filter((r) => r.snapShare === null).length;
    const nullsOut = parsed.rows.filter((r) => r[6] === null).length;
    expect(nullsOut).toBe(nullsIn);
  });

  it("puts one row per line, so a one-week change is a one-line diff", () => {
    const text = serialiseSeason(payload, AT);
    const rowLines = text.split("\n").filter((l) => l.startsWith("["));
    expect(rowLines.length).toBe(payload.rows.length + payload.players.length);
  });
});

describe("idempotence", () => {
  it("hashes the data and not the timestamp", () => {
    expect(contentHash(payload)).toBe(contentHash(toPayload(2024, build.rows)));
  });

  it("changes the hash when a single value changes", () => {
    const altered = build.rows.map((r, i) => (i === 3 ? { ...r, points: r.points + 0.01 } : r));
    expect(contentHash(toPayload(2024, altered))).not.toBe(contentHash(payload));
  });

  it("does not rewrite a file whose data has not changed", async () => {
    const dir = tempDir();
    const first = await writeSeason(dir, payload, AT);
    expect(first.written).toBe(true);
    const mtime = statSync(first.path).mtimeMs;

    const second = await writeSeason(dir, payload, "2026-09-13T00:00:00.000Z");
    expect(second.written).toBe(false);
    expect(statSync(first.path).mtimeMs).toBe(mtime);
    // And the timestamp in the file is still the first run's, because nothing was written.
    expect(readFileSync(first.path, "utf8")).toContain(AT);
  });

  it("does rewrite when the data has changed", async () => {
    const dir = tempDir();
    await writeSeason(dir, payload, AT);
    const altered = toPayload(2024, build.rows.slice(0, -1));
    const second = await writeSeason(dir, altered, AT);
    expect(second.written).toBe(true);
  });

  it("writes again when the gzip is missing, even though the JSON matches", async () => {
    // Half a publish is not a publish. A static host serving a stale `.gz` next to a fresh
    // `.json` is worse than either alone.
    const dir = tempDir();
    const first = await writeSeason(dir, payload, AT);
    writeFileSync(`${first.gzipPath}.moved`, readFileSync(first.gzipPath));
    const fs = await import("node:fs/promises");
    await fs.rm(first.gzipPath);
    expect((await writeSeason(dir, payload, AT)).written).toBe(true);
  });
});

describe("the gzip", () => {
  it("holds exactly the same bytes as the JSON", async () => {
    const dir = tempDir();
    const result = await writeSeason(dir, payload, AT);
    expect(gunzipSync(readFileSync(result.gzipPath)).toString("utf8")).toBe(
      readFileSync(result.path, "utf8"),
    );
  });

  it("compresses", async () => {
    // A season of this is 290 kB and 78 kB gzipped, a ratio of 3.7. On this fixture it is
    // 2.9, because gzip needs more than a hundred rows to build a useful dictionary. The
    // floor is set under the fixture's own figure, not under the season's.
    const r = await writeSeason(tempDir(), payload, AT);
    expect(r.gzipBytes).toBeLessThan(r.bytes / 2.5);
  });

  it("is less than half the size of an object per row, before compression", () => {
    // The actual reason for the layout, and the claim that holds at every scale. After gzip
    // the two are close, because a key name repeated six thousand times compresses to almost
    // nothing; uncompressed, which is what the browser parses, it is a 4x on a full season.
    const compact = serialiseSeason(payload, AT).length;
    const naive = JSON.stringify(build.rows).length;
    expect(compact).toBeLessThan(naive / 2);
  });
});

describe("reading back what is published", () => {
  it("returns null when there is nothing there", async () => {
    expect(await readPublishedSummary(join(tempDir(), "nope.json"))).toBeNull();
  });

  it("returns the hash and the row count from the header alone", async () => {
    const dir = tempDir();
    const result = await writeSeason(dir, payload, AT);
    expect(await readPublishedSummary(result.path)).toEqual({
      hash: result.hash,
      rowCount: payload.rows.length,
    });
  });

  it("returns null on a file whose header is not where it should be", async () => {
    // Null means "nothing to compare against", which lets a first run through. Returning a
    // zero row count instead would make every shrink guard pass on a corrupt file.
    const dir = tempDir();
    const path = join(dir, "season-2024.json");
    writeFileSync(path, "{}\n", "utf8");
    expect(await readPublishedSummary(path)).toBeNull();
  });
});
