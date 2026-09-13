/**
 * Failing loudly on a bad download.
 *
 * The scenario: a scheduled job fetches four files, one 404s because a release tag moved, the
 * empty body reads as "no rows this week", and a valid-looking dataset with a third of the
 * season missing replaces a good one. Nothing throws. The site comes up. The data is gone.
 *
 * So every one of these drives a specific bad response through the real loader and asserts it
 * throws. The negative space matters as much: after a failure there must be no file in the
 * cache directory, because a cached truncation is the same bug on a delay.
 */

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createLoader, SourceError, validate, type FetchSpec } from "../../src/pipeline/sources.ts";
import { fixtureText } from "./helpers.ts";

const GOOD = fixtureText("games-2024.csv");

const spec = (over: Partial<FetchSpec> = {}): FetchSpec => ({
  url: "https://example.invalid/games.csv",
  cacheAs: "games.csv",
  requiredColumns: ["game_id", "spread_line", "total_line"],
  minRows: 50,
  ...over,
});

const responding = (body: string, init: ResponseInit = {}): typeof fetch =>
  (async () => new Response(body, init)) as unknown as typeof fetch;

function tempCache(): string {
  return mkdtempSync(join(tmpdir(), "spike-sources-"));
}

describe("a bad response stops the run", () => {
  it("throws on a 404 rather than treating the body as no rows", () => {
    const dir = tempCache();
    const loader = createLoader({
      cacheDir: dir,
      fetchImpl: responding("Not Found", { status: 404, statusText: "Not Found" }),
    });
    return expect(loader.load(spec())).rejects.toThrow(/HTTP 404/);
  });

  it("throws on a 500", () => {
    const dir = tempCache();
    const loader = createLoader({
      cacheDir: dir,
      fetchImpl: responding("", { status: 500, statusText: "Internal Server Error" }),
    });
    return expect(loader.load(spec())).rejects.toThrow(SourceError);
  });

  it("throws on an empty body even with a 200", () => {
    // A CDN serving a zero-byte object with a 200 is the quiet version of a 404, and it is the
    // one that produces an empty dataset rather than an error.
    const dir = tempCache();
    const loader = createLoader({ cacheDir: dir, fetchImpl: responding("   \n  ") });
    return expect(loader.load(spec())).rejects.toThrow(/empty body/);
  });

  it("throws on a body truncated on a line boundary, where the rows just run out", async () => {
    // The version that parses cleanly and is still a third of a season. Only the row floor
    // can catch this one: every row present is well formed.
    const dir = tempCache();
    const cut = `${GOOD.trimEnd().split("\n").slice(0, 22).join("\n")}\n`;
    const loader = createLoader({ cacheDir: dir, fetchImpl: responding(cut) });
    await expect(loader.load(spec())).rejects.toThrow(/21 rows, below the floor of 50/);
  });

  it("throws on a body cut part way through a row", async () => {
    // The likelier truncation: a connection dropped mid-record. Caught by the width check
    // before the row floor gets a chance, which is fine. Both are loud.
    const dir = tempCache();
    const cut = GOOD.slice(0, Math.floor(GOOD.length / 3));
    const loader = createLoader({ cacheDir: dir, fetchImpl: responding(cut) });
    await expect(loader.load(spec())).rejects.toThrow(/does not parse as CSV/);
  });

  it("throws on a body truncated mid-row, before it can count anything", async () => {
    const dir = tempCache();
    const lines = GOOD.split("\n");
    const cut = `${lines.slice(0, 20).join("\n")}\n2024_05_ATL_TB,2024,5,REG,TB`;
    const loader = createLoader({ cacheDir: dir, fetchImpl: responding(cut) });
    await expect(loader.load(spec())).rejects.toThrow(/does not parse as CSV|below the floor/);
  });

  it("throws when a column the pipeline reads has been renamed upstream", async () => {
    // A rename that is only noticed at field-access time reads as a zero everywhere, which is
    // a whole season of games with no betting line rather than an error.
    const dir = tempCache();
    const renamed = GOOD.replace("spread_line", "spread");
    const loader = createLoader({ cacheDir: dir, fetchImpl: responding(renamed) });
    await expect(loader.load(spec())).rejects.toThrow(/missing 1 expected column\(s\): spread_line/);
  });

  it("leaves nothing in the cache after a failure", async () => {
    const dir = tempCache();
    const loader = createLoader({ cacheDir: dir, fetchImpl: responding("", { status: 404 }) });
    await expect(loader.load(spec())).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("names the source in the message, so the log says which feed broke", async () => {
    const dir = tempCache();
    const loader = createLoader({ cacheDir: dir, fetchImpl: responding("", { status: 404 }) });
    await expect(loader.load(spec())).rejects.toThrow(/example\.invalid/);
  });
});

describe("a good response", () => {
  it("parses, caches and returns the table", async () => {
    const dir = tempCache();
    const loader = createLoader({ cacheDir: dir, fetchImpl: responding(GOOD) });
    const table = await loader.load(spec());
    expect(table.rows.length).toBeGreaterThan(60);
    expect(readdirSync(dir)).toEqual(["games.csv"]);
    expect(loader.fetched).toHaveLength(1);
  });

  it("fetches each URL at most once per run, however many callers ask", async () => {
    // Politeness, and also correctness: `games.csv` covers every season, so a three season
    // refresh would otherwise pull the same 2 MB three times.
    const dir = tempCache();
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(GOOD);
    }) as unknown as typeof fetch;
    const loader = createLoader({ cacheDir: dir, fetchImpl: counting });
    await Promise.all([loader.load(spec()), loader.load(spec()), loader.load(spec())]);
    expect(calls).toBe(1);
  });

  it("serves the second run from the cache without touching the network", async () => {
    const dir = tempCache();
    await createLoader({ cacheDir: dir, fetchImpl: responding(GOOD) }).load(spec());

    const second = createLoader({
      cacheDir: dir,
      fetchImpl: (() => {
        throw new Error("the second run went to the network");
      }) as unknown as typeof fetch,
    });
    const table = await second.load(spec());
    expect(table.rows.length).toBeGreaterThan(60);
    expect(second.cacheHits).toHaveLength(1);
    expect(second.fetched).toHaveLength(0);
  });

  it("validates the cache on the way in, so a half-written entry is caught not trusted", async () => {
    // A run killed mid-write leaves a partial file. Reading it back without the same gate is
    // how yesterday's interrupted job becomes today's truncated dataset.
    const dir = tempCache();
    writeFileSync(join(dir, "games.csv"), GOOD.slice(0, 400), "utf8");
    const loader = createLoader({
      cacheDir: dir,
      fetchImpl: (() => {
        throw new Error("should not have been reached");
      }) as unknown as typeof fetch,
    });
    await expect(loader.load(spec())).rejects.toThrow(SourceError);
  });
});

describe("validate, on its own", () => {
  it("accepts a file that clears every gate", () => {
    expect(validate(GOOD, spec()).rows.length).toBeGreaterThan(60);
  });

  it("rejects a row count one short of the floor", () => {
    // Off-by-one on the floor is the difference between catching a truncation and not.
    const rows = GOOD.trimEnd().split("\n");
    const short = [rows[0], ...rows.slice(1, 51)].join("\n");
    expect(() => validate(short, spec({ minRows: 50 }))).not.toThrow();
    const shorter = [rows[0], ...rows.slice(1, 50)].join("\n");
    expect(() => validate(shorter, spec({ minRows: 50 }))).toThrow(/49 rows, below the floor of 50/);
  });
});
