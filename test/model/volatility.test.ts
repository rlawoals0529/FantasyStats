import { describe, expect, it } from "vitest";
import { asOf } from "../../src/model/asof.ts";
import { VOLATILITY_LADDER } from "../../src/model/calibration.ts";
import { expectedOutcome } from "../../src/model/expected.ts";
import { paramsFor } from "../../src/model/simulate.ts";
import { LADDER_ANCHORS, POSITION_ADJUSTMENT, sdForMean, tierForMean } from "../../src/model/volatility.ts";
import type { PlayerWeek, Position } from "../../src/shared/player.ts";

const BOUNDARY = { season: 2024, week: 8 };

/** A player whose weekly scores are exactly `points`, for as many weeks as given. */
function history(playerId: string, points: readonly number[], position: Position = "WR"): PlayerWeek[] {
  return points.map((value, i) => ({
    playerId,
    name: playerId,
    position,
    team: "T1",
    season: BOUNDARY.season,
    week: i + 1,
    points: value,
    targetShare: null,
    wopr: null,
    snapShare: null,
  }));
}

describe("sdForMean", () => {
  it("returns the tabulated sd at every measured point", () => {
    LADDER_ANCHORS.forEach((anchor, i) => {
      expect(sdForMean(anchor.mean, "WR")).toBeCloseTo(VOLATILITY_LADDER[i]?.sd ?? -1, 9);
    });
  });

  it("rises with the mean and never jumps at a tier boundary", () => {
    // A step per tier would move the page's headline spike number by a visible amount across a
    // boundary that is an artefact of how the table was bucketed. Interpolation is what avoids
    // that, and this is the test that would notice it coming back.
    // 0.13 is the bound because the steepest stretch of the curve is the CV cap below the
    // bottom anchor, where sd is 1.16 times the mean, so a 0.1 step of mean can move sd by
    // 0.116. Every tier-to-tier stretch above that is far shallower. A step function would jump
    // 0.92 at the 11 ppg boundary, which is what this is watching for.
    let previous = sdForMean(0.4, "WR");
    for (let mean = 0.5; mean <= 25; mean += 0.1) {
      const sd = sdForMean(mean, "WR");
      expect(sd).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(sd - previous).toBeLessThan(0.13);
      previous = sd;
    }
  });

  it("holds flat above the top anchor rather than extrapolating off the end of the table", () => {
    const top = LADDER_ANCHORS[LADDER_ANCHORS.length - 1];
    if (!top) throw new Error("ladder is empty");
    expect(sdForMean(top.mean + 10, "WR")).toBeCloseTo(top.sd, 9);
    expect(sdForMean(40, "WR")).toBeCloseTo(top.sd, 9);
  });

  it("caps the CV below the bottom anchor at the steepest ratio ever measured", () => {
    // Holding sd flat at 2.93 down to a mean of 0.5 would imply a CV of 5.9, six times anything
    // in the table, and would report a bench player as a lottery ticket.
    for (const mean of [0.25, 0.5, 1, 2]) {
      expect(sdForMean(mean, "WR") / mean).toBeLessThanOrEqual(1.16 + 1e-9);
    }
  });

  it("treats every position the same, which is a stated absence and not an oversight", () => {
    // The ladder was measured on the flex positions and CONCEPT.md does not tabulate QB. An
    // invented QB multiplier would be worse than none. If one ever gets measured, this test
    // changes in the same commit as POSITION_ADJUSTMENT.
    expect(Object.values(POSITION_ADJUSTMENT)).toEqual([1, 1, 1, 1]);
    const positions: Position[] = ["QB", "RB", "WR", "TE"];
    const spreads = positions.map((p) => sdForMean(12, p));
    expect(new Set(spreads).size).toBe(1);
  });
});

describe("tierForMean", () => {
  it("uses the table's own bounds", () => {
    expect(tierForMean(4.9).sd).toBe(2.93);
    expect(tierForMean(5).sd).toBe(5.1);
    expect(tierForMean(13.99).sd).toBe(7.13);
    expect(tierForMean(14).sd).toBe(8.42);
    expect(tierForMean(1000).sd).toBe(8.42);
  });
});

describe("a player's own volatility never reaches the model", () => {
  it("gives two players with the same mean and opposite histories the same spread", () => {
    // THE DESIGN CONSTRAINT. Residual volatility correlates at 0.152 between halves of a season,
    // so a player's measured boom-bust-ness is about 85 per cent noise. Fitting spread from it
    // is the obvious implementation and it is wrong. These two average 10 ppg over six games;
    // one of them alternates 0 and 20 and the other scores 10 every week. They must come out
    // with identical distributions, and if they ever do not, someone has refitted spread from
    // history.
    const swings = history("swings", [0, 20, 0, 20, 0, 20]);
    const metronome = history("metronome", [10, 10, 10, 10, 10, 10]);
    const window = asOf(BOUNDARY, [...swings, ...metronome]);

    const a = expectedOutcome(window, "swings", "WR", null);
    const b = expectedOutcome(window, "metronome", "WR", null);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (!a || !b) return;

    expect(a.mean).toBeCloseTo(b.mean, 9);
    expect(paramsFor(a)).toEqual(paramsFor(b));
  });

  it("moves the spread when the MEAN moves, which is the relationship that is stable", () => {
    const low = history("low", [4, 4, 4, 4, 4, 4]);
    const high = history("high", [16, 16, 16, 16, 16, 16]);
    const window = asOf(BOUNDARY, [...low, ...high]);
    const a = expectedOutcome(window, "low", "WR", null);
    const b = expectedOutcome(window, "high", "WR", null);
    if (!a || !b) throw new Error("expected both players to have an outlook");
    const sdOf = (p: { shape: number; scale: number }) => Math.sqrt(p.shape) * p.scale;
    expect(sdOf(paramsFor(b))).toBeGreaterThan(sdOf(paramsFor(a)));
  });
});
