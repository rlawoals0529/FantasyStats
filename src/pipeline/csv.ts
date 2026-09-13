/**
 * A CSV reader that understands quotes, because the feeds need one.
 *
 * The tempting version of this file is `line.split(",")`, and it is wrong on real nflverse
 * data in a way that does not announce itself. `stats_player_week` carries a headshot URL
 * containing `f_auto,q_auto`, so a naive split shifts every field after column six by two
 * places for every row. The symptom is not an exception: it is `position` coming back as
 * `Jr."` and `week` coming back as `2024`, silently, for the whole file. That was observed
 * before this parser existed, so the comment is a report rather than a worry.
 *
 * The parser is deliberately small and deliberately strict about row width. A row whose field
 * count does not match the header is a parse failure, not a row to patch up, because the two
 * ways to patch it up are to pad with empties or to drop it and both of those turn a broken
 * download into plausible-looking data.
 */

export type Row = Readonly<Record<string, string>>;

export type Table = {
  readonly header: readonly string[];
  readonly rows: readonly Row[];
};

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

/**
 * RFC 4180 fields. Handles `"a,b"`, `""` doubling, and embedded newlines inside quotes.
 *
 * Embedded newlines are not hypothetical here: `injuries` carries a practice status whose
 * value is literally a quoted newline and some spaces, so a line-oriented reader splits one
 * record into two and then fails the width check on both halves.
 */
function splitRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let sawField = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      sawField = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
      sawField = true;
    } else if (c === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      sawField = false;
    } else if (c === "\r") {
      // Swallowed. A CRLF file is otherwise a file where every last field ends in a carriage
      // return, and `"WAS\r" !== "WAS"` is the kind of join failure that looks like a missing
      // player rather than like a bug.
    } else {
      field += c;
      sawField = true;
    }
  }
  if (sawField || field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  if (quoted) throw new CsvError("unterminated quoted field: the file ends mid-record");
  return records;
}

/** Parse a whole CSV. Throws rather than returning a partial table. */
export function parseCsv(text: string): Table {
  const records = splitRecords(text);
  const header = records[0];
  if (header === undefined || header.length === 0) throw new CsvError("empty file: no header row");

  const rows: Row[] = [];
  for (let i = 1; i < records.length; i++) {
    const record = records[i];
    if (record === undefined) continue;
    if (record.length !== header.length) {
      throw new CsvError(
        `row ${i + 1} has ${record.length} fields, header has ${header.length}. ` +
          "Refusing to guess which fields are missing.",
      );
    }
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) row[header[j] as string] = record[j] as string;
    rows.push(row);
  }
  return { header, rows };
}

/**
 * Required-column check, run once per file at load rather than per row at use.
 *
 * nflverse renames columns between releases. `passing_interceptions` used to be `interceptions`
 * and `passing_2pt_conversions` used to be `passing_two_point_conversions`. A rename that is
 * only noticed at field-access time reads as a zero everywhere, which is a whole season of
 * quarterbacks throwing no interceptions rather than an error.
 */
export function requireColumns(table: Table, columns: readonly string[], what: string): void {
  const have = new Set(table.header);
  const missing = columns.filter((c) => !have.has(c));
  if (missing.length > 0) {
    throw new CsvError(
      `${what} is missing ${missing.length} expected column(s): ${missing.join(", ")}. ` +
        "The upstream schema has changed; fix the mapping rather than defaulting these to zero.",
    );
  }
}

/** A number, where blank means blank. */
export function num(row: Row, key: string): number | null {
  const raw = row[key];
  if (raw === undefined || raw === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/**
 * A number, where blank means zero.
 *
 * Only for counting stats, where a blank genuinely is "this did not happen". Never for a rate:
 * a receiver with no targets has a blank `target_share` and their share is unknown, not zero,
 * and `PlayerWeek.targetShare` is `number | null` precisely so that distinction survives.
 */
export function count(row: Row, key: string): number {
  return num(row, key) ?? 0;
}

/** A string, where blank means blank. */
export function str(row: Row, key: string): string | null {
  const raw = row[key];
  if (raw === undefined) return null;
  const v = raw.trim();
  return v === "" ? null : v;
}
