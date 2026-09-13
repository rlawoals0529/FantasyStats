/**
 * The whole pipeline, on six real games.
 *
 * The unit suites check each piece against its own trap. This one checks that the pieces are
 * wired to each other the way they claim: that the points on a row came from `scoring.ts`,
 * that the implied total is the player's own team's and not their opponent's, that a failed
 * snap lookup arrives as null rather than as a zero, and that the join failures are counted
 * where a run can see them.
 */

import { describe, expect, it } from "vitest";

import { buildSeason, type PlayerWeekRow } from "../../src/pipeline/dataset.ts";
import { count } from "../../src/pipeline/csv.ts";
import { pprPoints, roundPoints } from "../../src/pipeline/scoring.ts";
import { unresolvedShare } from "../../src/pipeline/snaps.ts";
import { fixture } from "./helpers.ts";

const build = buildSeason({
  season: 2024,
  stats: fixture("stats-2024-w1.csv"),
  schedules: fixture("games-2024.csv"),
  snaps: fixture("snaps-2024-w1.csv"),
  injuries: fixture("injuries-2024-w1.csv"),
});

const rows = build.rows;
const byName = (name: string): PlayerWeekRow => {
  const row = rows.find((r) => r.name === name);
  if (row === undefined) throw new Error(`no built row for ${name}`);
  return row;
};

describe("what comes out", () => {
  it("builds a row per skill-position player-week", () => {
    expect(rows.length).toBeGreaterThan(100);
    expect(build.report.kept).toBe(rows.length);
  });

  it("keeps only the four positions the contract has", () => {
    expect(new Set(rows.map((r) => r.position))).toEqual(new Set(["QB", "RB", "WR", "TE"]));
  });

  it("drops fullbacks and kickers, which the stats file does carry", () => {
    const raw = fixture("stats-2024-w1.csv").rows;
    expect(raw.some((r) => r["position"] === "K")).toBe(true);
    expect(rows.some((r) => (r.position as string) === "K")).toBe(false);
  });

  it("keeps the regular season only", () => {
    expect(rows.every((r) => r.season === 2024 && r.week === 1)).toBe(true);
  });

  it("sorts by player then week, so a rerun produces the same bytes", () => {
    const keys = rows.map((r) => `${r.playerId}|${String(r.week).padStart(2, "0")}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("carries every field the contract names and the two the page adds", () => {
    expect(Object.keys(byName("Josh Allen")).sort()).toEqual([
      "impliedTotal",
      "injuryStatus",
      "name",
      "playerId",
      "points",
      "position",
      "season",
      "snapShare",
      "targetShare",
      "team",
      "week",
      "wopr",
    ]);
  });
});

describe("points come from the one scoring function", () => {
  it("matches `pprPoints` on every row, recomputed from the raw stats", () => {
    // Not a restatement of the formula. This recomputes through the same import the builder
    // uses, so the assertion is "the builder fed it the right columns", which is the half a
    // second implementation of the formula here could not check.
    const raw = fixture("stats-2024-w1.csv").rows;
    for (const row of raw) {
      if (!["QB", "RB", "WR", "TE"].includes(String(row["position"]))) continue;
      const built = rows.find(
        (r) => r.playerId === row["player_id"] && r.week === Number(row["week"]),
      );
      expect(built).toBeDefined();
      const expected = roundPoints(
        pprPoints({
          passingYards: count(row, "passing_yards"),
          passingTouchdowns: count(row, "passing_tds"),
          interceptions: count(row, "passing_interceptions"),
          rushingYards: count(row, "rushing_yards"),
          rushingTouchdowns: count(row, "rushing_tds"),
          receivingYards: count(row, "receiving_yards"),
          receivingTouchdowns: count(row, "receiving_tds"),
          receptions: count(row, "receptions"),
          fumblesLost:
            count(row, "sack_fumbles_lost") +
            count(row, "rushing_fumbles_lost") +
            count(row, "receiving_fumbles_lost"),
        }),
      );
      expect((built as PlayerWeekRow).points).toBe(expected);
    }
  });
});

describe("implied total is the player's own team's", () => {
  it("gives the two sides of a game different numbers", () => {
    // 2024 week 1, Baltimore at Kansas City. Getting this backwards would hand every player
    // their opponent's implied total, which is the same silent inversion the sign convention
    // guards against, arriving by a different route.
    const kc = rows.filter((r) => r.team === "KC");
    const bal = rows.filter((r) => r.team === "BAL");
    expect(kc.length).toBeGreaterThan(5);
    expect(bal.length).toBeGreaterThan(5);
    const kcTotal = kc[0]?.impliedTotal as number;
    const balTotal = bal[0]?.impliedTotal as number;
    expect(kcTotal).not.toBe(balTotal);
    // Kansas City were home favourites, so theirs is the higher of the two.
    expect(kcTotal).toBeGreaterThan(balTotal);
  });

  it("gives every player on a team the same number", () => {
    const kc = rows.filter((r) => r.team === "KC").map((r) => r.impliedTotal);
    expect(new Set(kc).size).toBe(1);
  });

  it("finds a line for every row in this slate", () => {
    expect(build.report.missingImpliedTotal).toBe(0);
    expect(build.report.unknownGames).toBe(0);
  });
});

describe("nulls stay nulls", () => {
  it("reports the snap join rather than swallowing it", () => {
    const join = build.report.snapJoin;
    expect(join.rows).toBe(rows.length);
    expect(join.exact + join.position + join.surname + join.ambiguous + join.unmatched).toBe(join.rows);
    expect(unresolvedShare(join)).toBeLessThan(0.01);
  });

  it("has genuine zero snap shares and never confuses them with a failed lookup", () => {
    const zeroes = rows.filter((r) => r.snapShare === 0);
    const nulls = rows.filter((r) => r.snapShare === null);
    expect(zeroes.length).toBeGreaterThan(0);
    expect(nulls.length).toBe(build.report.snapJoin.ambiguous + build.report.snapJoin.unmatched);
  });

  it("leaves a player who is not on the injury report as null, not as a status", () => {
    const unlisted = rows.filter((r) => r.injuryStatus === null);
    const listed = rows.filter((r) => r.injuryStatus !== null);
    expect(unlisted.length).toBeGreaterThan(listed.length);
    expect(listed.length).toBe(build.report.withInjuryStatus);
  });

  it("never emits undefined for a nullable field", () => {
    // `undefined` disappears from JSON entirely, so a field that is sometimes undefined is a
    // field that is sometimes absent from the shipped row.
    for (const row of rows) {
      expect(row.targetShare === undefined).toBe(false);
      expect(row.wopr === undefined).toBe(false);
      expect(row.snapShare === undefined).toBe(false);
      expect(row.impliedTotal === undefined).toBe(false);
      expect(row.injuryStatus === undefined).toBe(false);
    }
  });
});

describe("determinism", () => {
  it("produces identical rows on a second build from the same inputs", () => {
    const again = buildSeason({
      season: 2024,
      stats: fixture("stats-2024-w1.csv"),
      schedules: fixture("games-2024.csv"),
      snaps: fixture("snaps-2024-w1.csv"),
      injuries: fixture("injuries-2024-w1.csv"),
    });
    expect(again.rows).toEqual(rows);
  });

  it("produces identical rows from the same data in a different order", () => {
    // The feed already arrives grouped by player, so a build that never sorted would look
    // stable on a single week and produce a different file the moment upstream reordered.
    // Shuffling the input is the only way to tell the two apart.
    const stats = fixture("stats-2024-w1.csv");
    const shuffled = [...stats.rows];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = (i * 7919) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j] as (typeof shuffled)[number], shuffled[i] as (typeof shuffled)[number]];
    }
    const again = buildSeason({
      season: 2024,
      stats: { header: stats.header, rows: shuffled },
      schedules: fixture("games-2024.csv"),
      snaps: fixture("snaps-2024-w1.csv"),
      injuries: fixture("injuries-2024-w1.csv"),
    });
    expect(again.rows).toEqual(rows);
  });
});

describe("what the builder refuses to carry", () => {
  it("drops the post-season entirely", () => {
    // 2024 wild card weekend, Minnesota at Los Angeles, 68 real rows. Fantasy leagues have
    // finished by then and every season average would be wrong at the tail if these were in.
    const post = fixture("stats-2024-post.csv");
    expect(post.rows.length).toBeGreaterThan(50);
    expect(post.rows.every((r) => r["season_type"] === "POST")).toBe(true);

    const built = buildSeason({
      season: 2024,
      stats: post,
      schedules: fixture("games-2024.csv"),
      snaps: fixture("snaps-2024-w1.csv"),
      injuries: fixture("injuries-2024-w1.csv"),
    });
    expect(built.rows).toEqual([]);
    expect(built.report.statsRows).toBe(post.rows.length);
  });
});

describe("the builder feeds the scoring function the right fumble columns", () => {
  it("does not charge a player for a fumble lost on a return", () => {
    // Cedrick Wilson Jr., 2024 week 1: `fumbles_lost_total` is 1 and every offensive fumble
    // column is 0, because the fumble was on a punt return. Scoring from the total instead of
    // from the three offensive columns docks him two points he was never charged, and it does
    // it to 41 rows a season. Driven through the builder rather than through `pprPoints`,
    // because the wrong column is a builder mistake and not a scoring one.
    const built = buildSeason({
      season: 2024,
      stats: fixture("scoring-cases-2024.csv"),
      schedules: fixture("games-2024.csv"),
      snaps: fixture("snaps-2024-w1.csv"),
      injuries: fixture("injuries-2024-w1.csv"),
    });
    const wilson = built.rows.find((r) => r.name === "Cedrick Wilson Jr.");
    expect(wilson).toBeDefined();
    expect((wilson as PlayerWeekRow).points).toBe(0);
  });
});
