/**
 * Injury status, and the three-way distinction it has to keep.
 *
 * Not on the report, on the report without a designation, and carrying a designation are three
 * different facts. The concept's measurement depends on it: Questionable players outscore
 * unlisted players on raw averages and only cost -0.99 points once you control for who gets
 * listed at all. Collapse "unlisted" into "no designation" and that control cannot be made.
 */

import { describe, expect, it } from "vitest";

import { parseCsv } from "../../src/pipeline/csv.ts";
import { indexInjuries, statusFor, unrecognisedList } from "../../src/pipeline/injuries.ts";
import { fixture } from "./helpers.ts";

const report = indexInjuries(fixture("injuries-2024-w1.csv"));

describe("a real week", () => {
  it("indexes every row", () => {
    expect(report.rowsIndexed).toBe(fixture("injuries-2024-w1.csv").rows.length);
    expect(report.rowsIndexed).toBeGreaterThan(50);
  });

  it("carries the designations through unchanged", () => {
    const seen = new Set(report.statuses.values());
    expect(seen.has("Out")).toBe(true);
    expect(seen.has("Questionable")).toBe(true);
  });

  it("returns null for a player who is not on the report at all", () => {
    // Null, not "Healthy". There is no row saying this player is healthy; there is an absence
    // of a row, and the two are different things.
    expect(statusFor(report, "00-0000000", 1, "REG")).toBeNull();
  });

  it("does not hand a regular season week its post-season designation", () => {
    // Week 1 exists twice in a season file, once as REG and once as the wild card round.
    const anyId = [...report.statuses.keys()][0]?.split("|")[0] as string;
    expect(statusFor(report, anyId, 1, "REG")).not.toBeNull();
    expect(statusFor(report, anyId, 1, "POST")).toBeNull();
  });
});

describe("the vocabulary", () => {
  const csv = [
    "season,week,game_type,gsis_id,report_status,practice_status",
    "2024,1,REG,A,Out,Did Not Participate In Practice",
    "2024,1,REG,B,Questionable,Limited Participation in Practice",
    "2024,1,REG,C,Doubtful,Did Not Participate In Practice",
    "2024,1,REG,D,,Limited Participation in Practice",
    "2024,1,REG,E,Note,Full Participation in Practice",
    "2024,1,WC,F,Out,Did Not Participate In Practice",
    "",
  ].join("\n");
  const small = indexInjuries(parseCsv(csv));

  it("passes the three designations through", () => {
    expect(statusFor(small, "A", 1, "REG")).toBe("Out");
    expect(statusFor(small, "B", 1, "REG")).toBe("Questionable");
    expect(statusFor(small, "C", 1, "REG")).toBe("Doubtful");
  });

  it("files a blank game status as Practice, not as null and not as healthy", () => {
    // On the report, limited in practice, no designation for Sunday. That is information.
    expect(statusFor(small, "D", 1, "REG")).toBe("Practice");
  });

  it("counts a status it does not recognise instead of letting it disappear", () => {
    // nflverse has shipped "Note" as a status. Filing it as Practice is a judgement; doing so
    // without saying anything is how a genuinely new designation goes unnoticed for a season.
    expect(statusFor(small, "E", 1, "REG")).toBe("Practice");
    expect(unrecognisedList(small)).toEqual([["Note", 1]]);
  });

  it("folds the post-season rounds onto POST, matching the stats file", () => {
    expect(statusFor(small, "F", 1, "POST")).toBe("Out");
    expect(statusFor(small, "F", 1, "REG")).toBeNull();
  });

  it("reports nothing unrecognised when the vocabulary is as expected", () => {
    const clean = indexInjuries(
      parseCsv("season,week,game_type,gsis_id,report_status,practice_status\n2024,1,REG,A,Out,\n"),
    );
    expect(unrecognisedList(clean)).toEqual([]);
  });

  it("counts a repeated key rather than silently keeping one of the two rows", () => {
    const dupes = indexInjuries(
      parseCsv(
        "season,week,game_type,gsis_id,report_status,practice_status\n" +
          "2024,1,REG,A,Out,\n2024,1,REG,A,Questionable,\n",
      ),
    );
    expect(dupes.duplicateKeys).toBe(1);
  });
});
