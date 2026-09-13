/**
 * The parser, and the specific real-file features that break a naive one.
 *
 * Every case here is something that actually occurs in the nflverse files, not a
 * specification exercise. The commas-inside-quotes case is the headshot URL in
 * `stats_player_week`; the newline-inside-quotes case is a practice status in `injuries`.
 */

import { describe, expect, it } from "vitest";

import { count, CsvError, num, parseCsv, requireColumns, str } from "../../src/pipeline/csv.ts";

describe("parsing", () => {
  it("reads a plain file", () => {
    const table = parseCsv("a,b\n1,2\n3,4\n");
    expect(table.header).toEqual(["a", "b"]);
    expect(table.rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("keeps a comma inside a quoted field", () => {
    // `f_auto,q_auto` inside a headshot URL. Split on commas and every field after this one
    // shifts by two for the whole file, silently: position reads as a name fragment and week
    // reads as the season.
    const table = parseCsv('id,url,pos\n7,"https://x/f_auto,q_auto/y",WR\n');
    expect(table.rows[0]).toEqual({ id: "7", url: "https://x/f_auto,q_auto/y", pos: "WR" });
  });

  it("keeps a newline inside a quoted field", () => {
    const table = parseCsv('id,status\n7,"\n    "\n8,Out\n');
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]).toEqual({ id: "8", status: "Out" });
  });

  it("unescapes a doubled quote", () => {
    const table = parseCsv('id,note\n7,"he said ""no"""\n');
    expect(table.rows[0]?.["note"]).toBe('he said "no"');
  });

  it("strips carriage returns rather than leaving them on the last field", () => {
    // "WAS\r" does not equal "WAS", and the join failure that causes looks like a missing team.
    const table = parseCsv("a,team\r\n1,WAS\r\n");
    expect(table.rows[0]?.["team"]).toBe("WAS");
  });

  it("handles a file with no trailing newline", () => {
    expect(parseCsv("a,b\n1,2").rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("refuses a row whose width does not match the header", () => {
    expect(() => parseCsv("a,b,c\n1,2\n")).toThrow(CsvError);
    expect(() => parseCsv("a,b,c\n1,2\n")).toThrow(/Refusing to guess/);
  });

  it("refuses a file that ends inside a quoted field", () => {
    expect(() => parseCsv('a,b\n1,"unterminated')).toThrow(/unterminated quoted field/);
  });

  it("refuses an empty file", () => {
    expect(() => parseCsv("")).toThrow(/no header row/);
  });
});

describe("required columns", () => {
  it("passes when every column is present", () => {
    expect(() => requireColumns(parseCsv("a,b\n1,2\n"), ["a", "b"], "x")).not.toThrow();
  });

  it("names every missing column, so one run fixes the whole rename", () => {
    expect(() => requireColumns(parseCsv("a,b\n1,2\n"), ["a", "c", "d"], "the stats file")).toThrow(
      /the stats file is missing 2 expected column\(s\): c, d/,
    );
  });
});

describe("field readers", () => {
  const row = parseCsv("n,blank,text\n0,,WR\n").rows[0] as Record<string, string>;

  it("reads a zero as a zero and a blank as null", () => {
    expect(num(row, "n")).toBe(0);
    expect(num(row, "blank")).toBeNull();
  });

  it("reads a blank counting stat as zero, because it did not happen", () => {
    expect(count(row, "blank")).toBe(0);
    expect(count(row, "n")).toBe(0);
  });

  it("reads a missing column as null rather than as a zero", () => {
    // The whole point of `requireColumns` running first, but belt and braces: a renamed
    // column must never quietly become a season of zeroes.
    expect(num(row, "not_a_column")).toBeNull();
    expect(str(row, "not_a_column")).toBeNull();
  });

  it("reads a non-numeric value as null rather than NaN", () => {
    const bad = parseCsv("v\nunknown\n").rows[0] as Record<string, string>;
    expect(num(bad, "v")).toBeNull();
  });

  it("trims strings and reports whitespace-only as null", () => {
    const padded = parseCsv('v\n"  WR  "\n').rows[0] as Record<string, string>;
    expect(str(padded, "v")).toBe("WR");
  });
});
