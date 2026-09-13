/**
 * PPR arithmetic.
 *
 * Two kinds of test, and both are needed.
 *
 * The hand-computed cases are the ones that can catch a wrong constant, because the expected
 * value was worked out from the rule rather than from the code or from the feed. Each case is
 * a real player-week and the arithmetic is written out next to it, so a reviewer can check the
 * expectation without running anything.
 *
 * The cross-check against nflverse's own `fantasy_points_ppr` is the one that catches a wrong
 * column. Reading `rushing_tds` where you meant `receiving_tds` produces perfectly plausible
 * numbers and passes every hand-computed case you thought to write; it does not survive being
 * compared against an independently computed total on 386 rows.
 */

import { describe, expect, it } from "vitest";

import { count, type Row } from "../../src/pipeline/csv.ts";
import { pprPoints, PPR, type ScoringLine } from "../../src/pipeline/scoring.ts";
import { fixture } from "./helpers.ts";

const EMPTY: ScoringLine = {
  passingYards: 0,
  passingTouchdowns: 0,
  interceptions: 0,
  rushingYards: 0,
  rushingTouchdowns: 0,
  receivingYards: 0,
  receivingTouchdowns: 0,
  receptions: 0,
  fumblesLost: 0,
};

const line = (over: Partial<ScoringLine>): ScoringLine => ({ ...EMPTY, ...over });

/** The line the pipeline builds, rebuilt here from the raw row. See `dataset.ts`. */
function lineOf(row: Row): ScoringLine {
  return {
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
  };
}

describe("each rule on its own", () => {
  it("scores passing yards at one point per 25", () => {
    expect(pprPoints(line({ passingYards: 250 }))).toBe(10);
    expect(pprPoints(line({ passingYards: 167 }))).toBeCloseTo(6.68, 10);
  });

  it("scores a passing touchdown at 4 and an interception at -2", () => {
    expect(pprPoints(line({ passingTouchdowns: 3 }))).toBe(12);
    expect(pprPoints(line({ interceptions: 2 }))).toBe(-4);
  });

  it("scores rushing and receiving yards at one point per 10", () => {
    expect(pprPoints(line({ rushingYards: 100 }))).toBe(10);
    expect(pprPoints(line({ receivingYards: 45 }))).toBeCloseTo(4.5, 10);
  });

  it("scores rushing and receiving touchdowns at 6", () => {
    expect(pprPoints(line({ rushingTouchdowns: 2 }))).toBe(12);
    expect(pprPoints(line({ receivingTouchdowns: 1 }))).toBe(6);
  });

  it("scores a reception at 1, which is the whole of PPR", () => {
    expect(pprPoints(line({ receptions: 7 }))).toBe(7);
  });

  it("scores a lost fumble at -2", () => {
    expect(pprPoints(line({ fumblesLost: 1 }))).toBe(-2);
  });

  it("lets negative rushing yards take points away", () => {
    // A quarterback sacked out of the pocket really does lose a tenth of a point a yard, and
    // a Math.max(0, ...) anywhere in the yardage path would quietly cost Aaron Rodgers his.
    expect(pprPoints(line({ rushingYards: -1 }))).toBeCloseTo(-0.1, 10);
  });

  it("keeps the constants at the values the rule states", () => {
    expect(PPR).toEqual({
      passingYardsPerPoint: 25,
      passingTouchdown: 4,
      interception: -2,
      rushingYardsPerPoint: 10,
      rushingTouchdown: 6,
      receivingYardsPerPoint: 10,
      receivingTouchdown: 6,
      reception: 1,
      fumbleLost: -2,
    });
  });
});

describe("hand-computed real player-weeks", () => {
  const rows = fixture("scoring-cases-2024.csv").rows;
  const find = (name: string, week: string): Row => {
    const row = rows.find((r) => r["player_display_name"] === name && r["week"] === week);
    if (row === undefined) throw new Error(`fixture is missing ${name} week ${week}`);
    return row;
  };

  it("Aaron Rodgers, 2024 week 1: 167/25 + 4 - 2 - 1/10 = 8.58", () => {
    expect(pprPoints(lineOf(find("Aaron Rodgers", "1")))).toBeCloseTo(8.58, 10);
  });

  it("Cooper Kupp, 2024 week 1: 10/10 + 110/10 + 6 + 14 = 32", () => {
    expect(pprPoints(lineOf(find("Cooper Kupp", "1")))).toBeCloseTo(32, 10);
  });

  it("Alvin Kamara, 2024 week 2: 115/10 + 18 + 65/10 + 6 + 2 = 44", () => {
    expect(pprPoints(lineOf(find("Alvin Kamara", "2")))).toBeCloseTo(44, 10);
  });

  it("Kirk Cousins, 2024 week 5: 509/25 + 16 - 2 = 34.36", () => {
    expect(pprPoints(lineOf(find("Kirk Cousins", "5")))).toBeCloseTo(34.36, 10);
  });

  it("Tua Tagovailoa, 2024 week 2: 145/25 + 4 - 6 + 17/10 = 5.5", () => {
    expect(pprPoints(lineOf(find("Tua Tagovailoa", "2")))).toBeCloseTo(5.5, 10);
  });

  it("Travis Etienne, 2024 week 1: 44/10 + 6 + 15/10 + 2 - 2 = 11.9, the fumble included", () => {
    expect(pprPoints(lineOf(find("Travis Etienne", "1")))).toBeCloseTo(11.9, 10);
  });

  it("Lamar Jackson, 2024 week 1: 273/25 + 4 + 122/10 - 2 = 25.12, a sack fumble counting", () => {
    // Sack fumbles are offensive fumbles. Leave `sack_fumbles_lost` out of the sum and this
    // reads 27.12, which is a plausible number and a wrong one.
    expect(pprPoints(lineOf(find("Lamar Jackson", "1")))).toBeCloseTo(25.12, 10);
  });

  it("Rashid Shaheed, 2024 week 6: 2.3, because a punt return touchdown is not a receiving one", () => {
    // nflverse says 8.3 for this week. The six points are a punt return, which this scoring
    // does not have a rule for. The gap is the test.
    const row = find("Rashid Shaheed", "6");
    expect(pprPoints(lineOf(row))).toBeCloseTo(2.3, 10);
    expect(Number(row["fantasy_points_ppr"])).toBeCloseTo(8.3, 10);
  });

  it("Jakobi Meyers, 2024 week 3: 19.2, because the two-point conversion is not scored", () => {
    const row = find("Jakobi Meyers", "3");
    expect(pprPoints(lineOf(row))).toBeCloseTo(19.2, 10);
    expect(Number(row["fantasy_points_ppr"])).toBeCloseTo(21.2, 10);
  });

  it("Cedrick Wilson Jr., 2024 week 1: 0, because his lost fumble was on a return", () => {
    // `fumbles_lost_total` is 1 for this row. Score from that column instead of from the three
    // offensive ones and he is docked two points he was never charged.
    const row = find("Cedrick Wilson Jr.", "1");
    expect(row["fumbles_lost_total"]).toBe("1");
    expect(pprPoints(lineOf(row))).toBe(0);
  });
});

describe("cross-check against nflverse's own PPR total", () => {
  /**
   * nflverse computes `fantasy_points_ppr` from the play-by-play, independently of anything
   * here. Two rules differ by design and both are added back before comparing: two-point
   * conversions at 2, and special-teams touchdowns at 6.
   *
   * Run across the whole 2024 file rather than this fixture, it agrees on all 18,983 rows.
   */
  const rows = fixture("stats-2024-w1.csv").rows;

  it("agrees with nflverse on every row of the fixture", () => {
    expect(rows.length).toBeGreaterThan(300);
    const disagreements: string[] = [];
    for (const row of rows) {
      const excluded =
        2 *
          (count(row, "passing_2pt_conversions") +
            count(row, "rushing_2pt_conversions") +
            count(row, "receiving_2pt_conversions")) +
        6 * count(row, "special_teams_tds");
      const theirs = count(row, "fantasy_points_ppr") - excluded;
      const ours = pprPoints(lineOf(row));
      if (Math.abs(ours - theirs) > 0.005) {
        disagreements.push(`${String(row["player_display_name"])}: ours ${ours}, theirs ${theirs}`);
      }
    }
    expect(disagreements).toEqual([]);
  });
});
