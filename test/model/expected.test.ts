import { describe, expect, it } from "vitest";
import { asOf } from "../../src/model/asof.ts";
import {
  IMPLIED_TOTAL_HIGH,
  IMPLIED_TOTAL_LOW,
  IMPLIED_TOTAL_REFERENCE,
  INJURY_EFFECT,
  OPPORTUNITY_GAP_EFFECT,
  TOUCHDOWN_LUCK_EFFECT,
} from "../../src/model/calibration.ts";
import { expectedOutcome, spikeRateForImpliedTotal } from "../../src/model/expected.ts";
import type { KickoffFacts, TouchdownWeek } from "../../src/model/inputs.ts";
import type { PlayerWeek, Position, Reason } from "../../src/shared/player.ts";

const BOUNDARY = { season: 2024, week: 8 };

function weeksFor(playerId: string, points: readonly number[], wopr: number | null = null): PlayerWeek[] {
  return points.map((value, i) => ({
    playerId,
    name: playerId,
    position: "WR" as Position,
    team: "T1",
    season: BOUNDARY.season,
    week: i + 1,
    points: value,
    targetShare: wopr === null ? null : wopr * 0.6,
    wopr,
    snapShare: null,
  }));
}

function kickoff(overrides: Partial<KickoffFacts> = {}): KickoffFacts {
  return {
    playerId: "A",
    season: BOUNDARY.season,
    week: BOUNDARY.week,
    impliedTeamTotal: null,
    injuryStatus: null,
    ...overrides,
  };
}

function reasonNamed(reasons: readonly Reason[], label: string): Reason {
  const found = reasons.find((r) => r.label === label);
  if (!found) throw new Error(`no reason labelled ${label} in ${reasons.map((r) => r.label).join(", ")}`);
  return found;
}

/** A league big enough for the cross-sectional buckets to exist. */
function league(): { weeks: PlayerWeek[]; touchdowns: TouchdownWeek[] } {
  const weeks: PlayerWeek[] = [];
  const touchdowns: TouchdownWeek[] = [];
  for (let p = 0; p < 40; p++) {
    const id = `L${String(p).padStart(2, "0")}`;
    const wopr = 0.1 + (p % 20) * 0.04;
    // Production deliberately out of step with opportunity, so the gap quartiles are populated.
    const level = 3 + ((p * 13) % 17);
    weeks.push(...weeksFor(id, [level, level + 2, level - 1, level + 1, level, level + 3], wopr));
    for (let week = 1; week <= 6; week++) {
      // Varied per player, so the terciles have something to split. A constant rate across the
      // league is not a tercile, it is a tie, and the model declines to bucket it.
      const rate = p % 4 === 0 ? 0 : p % 4 === 1 ? week % 2 : p % 4 === 2 ? 1 : 2;
      touchdowns.push({ playerId: id, season: BOUNDARY.season, week, touchdowns: rate });
    }
  }
  return { weeks, touchdowns };
}

describe("expectedOutcome", () => {
  it("refuses to speak with fewer than three games rather than defaulting to something", () => {
    const window = asOf(BOUNDARY, weeksFor("A", [10, 12]));
    expect(expectedOutcome(window, "A", "WR", null)).toBeNull();
  });

  it("starts from the season average to date and says that is what it did", () => {
    const window = asOf(BOUNDARY, weeksFor("A", [6, 10, 14, 8]));
    const outcome = expectedOutcome(window, "A", "WR", null);
    expect(outcome).not.toBeNull();
    if (!outcome) return;
    expect(outcome.mean).toBeCloseTo(9.5, 9);
    const reason = reasonNamed(outcome.reasons, "season average to date");
    expect(reason.effect).toBeCloseTo(9.5, 9);
    expect(reason.value).toBe("9.5 ppg over 4 games");
    expect(reason.basis).toContain("6.208");
  });

  it("never centres below the floor a gamma needs", () => {
    const window = asOf(BOUNDARY, weeksFor("A", [0, 0, 0, 0]));
    const outcome = expectedOutcome(window, "A", "WR", kickoff());
    if (!outcome) throw new Error("expected an outlook");
    expect(outcome.mean).toBeGreaterThan(0);
  });

  it("throws on kickoff facts for the wrong week instead of quietly using them", () => {
    const window = asOf(BOUNDARY, weeksFor("A", [6, 10, 14, 8]));
    expect(() => expectedOutcome(window, "A", "WR", kickoff({ week: 9 }))).toThrow(/but the outlook is for/);
    expect(() => expectedOutcome(window, "A", "WR", kickoff({ playerId: "B" }))).toThrow(/but the outlook is for/);
  });
});

describe("the injury adjustment", () => {
  const window = asOf(BOUNDARY, weeksFor("A", [10, 10, 10, 10]));

  it("marks Questionable DOWN, which is the controlled sign and looks backwards", () => {
    // If you are here because the raw data says Questionable players outscore unlisted ones:
    // that is a selection effect, teams only bother listing players worth worrying about. See
    // INJURY_EFFECT in calibration.ts. Do not flip this.
    const outcome = expectedOutcome(window, "A", "WR", kickoff({ injuryStatus: "Questionable" }));
    if (!outcome) throw new Error("expected an outlook");
    expect(outcome.mean).toBeCloseTo(10 + INJURY_EFFECT.Questionable, 9);
    const reason = reasonNamed(outcome.reasons, "injury designation");
    expect(reason.effect).toBe(-0.99);
    expect(reason.basis).toContain("selection effect");
  });

  it("marks unlisted up by the measured amount", () => {
    const outcome = expectedOutcome(window, "A", "WR", kickoff({ injuryStatus: null }));
    if (!outcome) throw new Error("expected an outlook");
    expect(outcome.mean).toBeCloseTo(10 + INJURY_EFFECT.unlisted, 9);
    expect(reasonNamed(outcome.reasons, "injury designation").value).toBe("unlisted");
  });

  it("applies nothing for a designation that was never measured, and says so", () => {
    for (const status of ["Doubtful", "Out"] as const) {
      const outcome = expectedOutcome(window, "A", "WR", kickoff({ injuryStatus: status }));
      if (!outcome) throw new Error("expected an outlook");
      expect(outcome.mean).toBeCloseTo(10, 9);
      expect(reasonNamed(outcome.reasons, "injury designation").basis).toContain("not measured");
    }
  });

  it("emits no injury reason at all when there is no report to read", () => {
    const outcome = expectedOutcome(window, "A", "WR", null);
    if (!outcome) throw new Error("expected an outlook");
    expect(outcome.reasons.map((r) => r.label)).not.toContain("injury designation");
  });
});

describe("the Vegas adjustment", () => {
  const window = asOf(BOUNDARY, weeksFor("A", [10, 10, 10, 10]));
  const outcomeAt = (impliedTeamTotal: number) => {
    const outcome = expectedOutcome(window, "A", "WR", kickoff({ impliedTeamTotal }));
    if (!outcome) throw new Error("expected an outlook");
    return outcome;
  };

  it("widens the distribution rather than moving it, which is the measured finding", () => {
    // "Vegas predicts spikes, not means". The centre must not move.
    const low = outcomeAt(15);
    const high = outcomeAt(28);
    expect(low.mean).toBeCloseTo(high.mean, 9);
    expect(high.sdMultiplier).toBeGreaterThan(1);
    expect(low.sdMultiplier).toBeLessThan(1);
  });

  it("does nothing at all at the reference total", () => {
    expect(outcomeAt(IMPLIED_TOTAL_REFERENCE).sdMultiplier).toBeCloseTo(1, 3);
  });

  it("is monotone in the implied total", () => {
    const multipliers = [16, 18, 20, 22, 24, 26, 30].map((t) => outcomeAt(t).sdMultiplier);
    for (let i = 1; i < multipliers.length; i++) {
      expect(multipliers[i] ?? 0).toBeGreaterThanOrEqual(multipliers[i - 1] ?? 0);
    }
  });

  it("carries a points-equivalent whose sign matches the direction of the move", () => {
    expect(reasonNamed(outcomeAt(28).reasons, "implied team total").effect).toBeGreaterThan(0);
    expect(reasonNamed(outcomeAt(15).reasons, "implied team total").effect).toBeLessThan(0);
    expect(reasonNamed(outcomeAt(28).reasons, "implied team total").basis).toContain("upper bound");
  });

  it("declines to scale spike odds a player does not have, and says why", () => {
    const bench = asOf(BOUNDARY, weeksFor("B", [0.4, 0.3, 0.5, 0.4]));
    const outcome = expectedOutcome(bench, "B", "WR", kickoff({ playerId: "B", impliedTeamTotal: 28 }));
    if (!outcome) throw new Error("expected an outlook");
    expect(outcome.sdMultiplier).toBe(1);
    expect(reasonNamed(outcome.reasons, "implied team total").effect).toBe(0);
    expect(reasonNamed(outcome.reasons, "implied team total").value).toContain("not applied");
  });
});

describe("spikeRateForImpliedTotal", () => {
  it("returns the measured rates at the measured ends", () => {
    expect(spikeRateForImpliedTotal(IMPLIED_TOTAL_LOW.total)).toBeCloseTo(IMPLIED_TOTAL_LOW.spikeRate, 10);
    expect(spikeRateForImpliedTotal(IMPLIED_TOTAL_HIGH.total)).toBeCloseTo(IMPLIED_TOTAL_HIGH.spikeRate, 10);
  });

  it("holds flat outside them rather than extrapolating a slope that was never measured", () => {
    expect(spikeRateForImpliedTotal(10)).toBe(IMPLIED_TOTAL_LOW.spikeRate);
    expect(spikeRateForImpliedTotal(40)).toBe(IMPLIED_TOTAL_HIGH.spikeRate);
  });

  it("is monotone through the interpolated middle", () => {
    let previous = 0;
    for (let total = 16; total <= 27; total += 0.5) {
      const rate = spikeRateForImpliedTotal(total);
      expect(rate).toBeGreaterThanOrEqual(previous);
      previous = rate;
    }
  });
});

describe("the regression adjustments", () => {
  it("puts every player in a quartile of the opportunity gap and pays the measured effect", () => {
    const { weeks, touchdowns } = league();
    const window = asOf(BOUNDARY, weeks, touchdowns);
    const effects = new Set<number>();
    for (let p = 0; p < 40; p++) {
      const outcome = expectedOutcome(window, `L${String(p).padStart(2, "0")}`, "WR", null);
      if (!outcome) continue;
      const reason = outcome.reasons.find((r) => r.label === "opportunity gap");
      if (reason) effects.add(reason.effect);
    }
    expect([...effects].sort((a, b) => b - a)).toEqual(
      [...OPPORTUNITY_GAP_EFFECT].sort((a, b) => b - a),
    );
  });

  it("marks the interpolated quartiles as interpolated, so nobody cites them as measured", () => {
    const { weeks, touchdowns } = league();
    const window = asOf(BOUNDARY, weeks, touchdowns);
    for (let p = 0; p < 40; p++) {
      const outcome = expectedOutcome(window, `L${String(p).padStart(2, "0")}`, "WR", null);
      const reason = outcome?.reasons.find((r) => r.label === "opportunity gap");
      if (!reason) continue;
      const isEnd = reason.effect === OPPORTUNITY_GAP_EFFECT[0] || reason.effect === OPPORTUNITY_GAP_EFFECT[3];
      expect(reason.basis.includes("interpolation")).toBe(!isEnd);
    }
  });

  it("splits touchdown luck into cold, neutral and hot with the measured effects", () => {
    const { weeks, touchdowns } = league();
    const window = asOf(BOUNDARY, weeks, touchdowns);
    const effects = new Set<number>();
    for (let p = 0; p < 40; p++) {
      const outcome = expectedOutcome(window, `L${String(p).padStart(2, "0")}`, "WR", null);
      const reason = outcome?.reasons.find((r) => r.label === "touchdown rate against expectation");
      if (reason) effects.add(reason.effect);
    }
    expect([...effects].sort((a, b) => b - a)).toEqual([
      TOUCHDOWN_LUCK_EFFECT.cold,
      TOUCHDOWN_LUCK_EFFECT.neutral,
      TOUCHDOWN_LUCK_EFFECT.hot,
    ]);
  });

  it("declines to bucket a league in which everybody is identical", () => {
    // A tie is not a quartile. Without the degenerate check every player lands in bucket 0 and
    // the whole league quietly collects the bottom-quartile effect, which is a real adjustment
    // paid out on no information at all.
    const weeks: PlayerWeek[] = [];
    for (let p = 0; p < 40; p++) {
      weeks.push(...weeksFor(`I${String(p).padStart(2, "0")}`, [10, 10, 10, 10, 10, 10], 0.4));
    }
    const window = asOf(BOUNDARY, weeks);
    const outcome = expectedOutcome(window, "I00", "WR", null);
    if (!outcome) throw new Error("expected an outlook");
    expect(outcome.reasons.map((r) => r.label)).toEqual(["season average to date"]);
    expect(outcome.mean).toBeCloseTo(10, 9);
  });

  it("emits no regression reason when the league is too small to have quartiles", () => {
    // Better silence than a quartile computed off four players.
    const window = asOf(BOUNDARY, weeksFor("A", [10, 10, 10, 10], 0.4));
    const outcome = expectedOutcome(window, "A", "WR", null);
    if (!outcome) throw new Error("expected an outlook");
    expect(outcome.reasons.map((r) => r.label)).toEqual(["season average to date"]);
  });
});
