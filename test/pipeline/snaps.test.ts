/**
 * The name join, and the thing it must never do.
 *
 * The rule under test is one sentence: **a lookup that did not resolve returns null, and null
 * never turns into zero.** Everything else here is in service of that. A join failure that
 * reads as a zero is indistinguishable from a healthy scratch, and it is wrong in the
 * direction that matters, because zero snaps is a strong signal and the model will act on it.
 *
 * The collision fixture is six real rows: the 2023 Jets had Michael Carter at running back and
 * Michael Carter II at cornerback, and the corner played zero offensive snaps in all three
 * games. A join that takes the first match hands the running back a zero for a week he played
 * 12 snaps. That is the bug this file exists for.
 */

import { describe, expect, it } from "vitest";

import { parseCsv } from "../../src/pipeline/csv.ts";
import { normaliseName, surname } from "../../src/pipeline/names.ts";
import { SnapIndex, SnapJoinTally, unresolvedShare } from "../../src/pipeline/snaps.ts";
import { fixture, fixtureText } from "./helpers.ts";

describe("normalisation", () => {
  it("ignores case, accents and punctuation", () => {
    expect(normaliseName("D.J. Moore")).toBe("dj moore");
    expect(normaliseName("DJ Moore")).toBe("dj moore");
    expect(normaliseName("Amon-Ra St. Brown")).toBe("amonra st brown");
    expect(normaliseName("Ja'Marr Chase")).toBe("jamarr chase");
  });

  it("strips a generational suffix, because the two feeds disagree about them", () => {
    expect(normaliseName("Marvin Harrison Jr.")).toBe("marvin harrison");
    expect(normaliseName("Michael Carter II")).toBe("michael carter");
    expect(normaliseName("Michael Carter")).toBe("michael carter");
  });

  it("removes punctuation rather than replacing it with a space", () => {
    // This one line is the difference between 1.03 per cent and 0.18 per cent of 2024 rows
    // failing to join. "d j moore" matches nothing and cannot fall back on the surname either,
    // because the 2024 Bears had a Tarvarius Moore.
    expect(normaliseName("D.J. Moore")).not.toBe("d j moore");
    expect(surname("D.J. Moore")).toBe("moore");
  });

  it("does not strip a suffix off a two-word name", () => {
    // Nothing should turn a surname into nothing just because it looks like a numeral.
    expect(normaliseName("Anthony Vee")).toBe("anthony vee");
  });
});

describe("the 2023 Jets collision", () => {
  const snaps = new SnapIndex(fixture("collision-2023-snaps.csv"));
  const stats = fixture("collision-2023-stats.csv").rows;

  it("has both Michael Carters in the fixture, on the same team in the same game", () => {
    // Re-read the fixture rather than trusting the index, so the premise of the test is
    // visible: six rows, the running back and the cornerback, three games each.
    const rows = parseCsv(fixtureText("collision-2023-snaps.csv")).rows;
    const week1 = rows.filter((r) => r["game_id"] === "2023_01_BUF_NYJ");
    expect(week1).toHaveLength(2);
    expect(week1.map((r) => r["player"]).sort()).toEqual(["Michael Carter", "Michael Carter II"]);
    expect(new Set(week1.map((r) => r["team"]))).toEqual(new Set(["NYJ"]));
    expect(week1.map((r) => normaliseName(String(r["player"])))).toEqual([
      "michael carter",
      "michael carter",
    ]);
  });

  it("gives the running back his own snaps, not the cornerback's zero", () => {
    const result = snaps.lookup("2023_01_BUF_NYJ", "NYJ", "Michael Carter", "RB");
    expect(result.match).toBe("position");
    expect(result.share).toBeGreaterThan(0);
  });

  it("gives the cornerback the zero that is genuinely his", () => {
    const result = snaps.lookup("2023_01_BUF_NYJ", "NYJ", "Michael Carter II", "CB");
    expect(result.match).toBe("position");
    expect(result.share).toBe(0);
  });

  it("returns null rather than guessing when the position cannot break the tie", () => {
    // Ask for a position neither of them plays. Two candidates, nothing to choose between
    // them, so the answer is "we do not know" and it is reported as ambiguous.
    const result = snaps.lookup("2023_01_BUF_NYJ", "NYJ", "Michael Carter", "WR");
    expect(result.match).toBe("ambiguous");
    expect(result.share).toBeNull();
  });

  it("resolves every stats row in the fixture to that player's own snaps", () => {
    for (const row of stats) {
      const result = snaps.lookup(
        String(row["game_id"]),
        String(row["team"]),
        String(row["player_display_name"]),
        String(row["position"]),
      );
      expect(result.share).not.toBeNull();
    }
  });
});

describe("a real week", () => {
  const snaps = new SnapIndex(fixture("snaps-2024-w1.csv"));
  const stats = fixture("stats-2024-w1.csv").rows.filter((r) =>
    ["QB", "RB", "WR", "TE"].includes(String(r["position"])),
  );

  it("matches essentially all of it", () => {
    const tally = new SnapJoinTally();
    for (const row of stats) {
      const result = snaps.lookup(
        String(row["game_id"]),
        String(row["team"]),
        String(row["player_display_name"]),
        String(row["position"]),
      );
      tally.record(String(row["player_display_name"]), result.match);
    }
    const report = tally.report(2024);
    expect(report.rows).toBe(stats.length);
    expect(unresolvedShare(report)).toBeLessThan(0.01);
  });

  it("distinguishes a player who did not play from a player it could not find", () => {
    // Both are real and they are different facts. If this ever collapses to one number, the
    // model loses the ability to tell a healthy scratch from a broken join.
    const zeroes: string[] = [];
    const nulls: string[] = [];
    for (const row of stats) {
      const result = snaps.lookup(
        String(row["game_id"]),
        String(row["team"]),
        String(row["player_display_name"]),
        String(row["position"]),
      );
      if (result.share === 0) zeroes.push(String(row["player_display_name"]));
      if (result.share === null) nulls.push(String(row["player_display_name"]));
    }
    expect(zeroes.length).toBeGreaterThan(0);
    for (const name of nulls) expect(zeroes).not.toContain(name);
  });

  it("recovers a nickname case through the surname, rather than losing the player", () => {
    // PFR calls him Kenneth Gainwell and nflverse calls him Kenny. No amount of punctuation
    // stripping connects those, and a hand-maintained alias list would fix it this season and
    // rot by the next. The structural fallback is a unique surname on one team in one game
    // with the same first initial, which is a fact about the roster rather than about names.
    const result = snaps.lookup("2024_01_GB_PHI", "PHI", "Kenny Gainwell", "RB");
    expect(result.match).toBe("surname");
    expect(result.share).toBeGreaterThan(0);
  });

  it("returns null, never zero, for a name that is not in the file at all", () => {
    // The plainest failure, and the one with the worst silent form. Zero offensive snaps is a
    // strong signal and the model will act on it, so a lookup that found nothing must not be
    // able to produce one.
    const result = snaps.lookup("2024_01_ARI_BUF", "BUF", "Nobody Whatsoever", "WR");
    expect(result.match).toBe("unmatched");
    expect(result.share).toBeNull();
    expect(result.share).not.toBe(0);
  });

  it("returns null for a real player asked about a game they were not in", () => {
    const result = snaps.lookup("2024_01_BAL_KC", "BUF", "Josh Allen", "QB");
    expect(result.share).toBeNull();
  });

  it("does not reach across teams for a name", () => {
    // Week 9 of 2024 had a DJ Turner catching passes for Las Vegas and a DJ Turner covering
    // them for Cincinnati, in the same game. Keying on the game alone loses both.
    const first = fixture("snaps-2024-w1.csv").rows[0];
    const gameId = String(first?.["game_id"]);
    const team = String(first?.["team"]);
    const other = gameId.split("_").slice(2).find((t) => t !== team) as string;
    const name = String(first?.["player"]);
    expect(snaps.lookup(gameId, team, name, String(first?.["position"])).share).not.toBeNull();
    expect(snaps.lookup(gameId, other, name, String(first?.["position"])).match).toBe("unmatched");
  });
});

describe("the tally", () => {
  it("counts every outcome and keeps the unresolved names", () => {
    const tally = new SnapJoinTally();
    tally.record("A", "exact");
    tally.record("B", "position");
    tally.record("C", "surname");
    tally.record("D", "ambiguous");
    tally.record("E", "unmatched");
    tally.record("E", "unmatched");
    const report = tally.report(2024);
    expect(report).toMatchObject({
      rows: 6,
      exact: 1,
      position: 1,
      surname: 1,
      ambiguous: 1,
      unmatched: 2,
    });
    expect(report.unresolvedNames).toEqual([
      { name: "E", weeks: 2 },
      { name: "D", weeks: 1 },
    ]);
  });

  it("counts a failed join as unresolved rather than letting it vanish", () => {
    // Three of six rows had no snap figure. If this ever reads 0 the join has started
    // swallowing its own failures, which is the thing the whole module is built against.
    const tally = new SnapJoinTally();
    tally.record("A", "exact");
    tally.record("B", "exact");
    tally.record("C", "exact");
    tally.record("D", "ambiguous");
    tally.record("E", "unmatched");
    tally.record("F", "unmatched");
    expect(unresolvedShare(tally.report(2024))).toBeCloseTo(0.5, 10);
  });

  it("reports zero unresolved for an empty season rather than dividing by zero", () => {
    expect(unresolvedShare(new SnapJoinTally().report(2024))).toBe(0);
  });
});
