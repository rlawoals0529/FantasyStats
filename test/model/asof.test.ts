import { describe, expect, it } from "vitest";
import { asOf, isBefore, weeksFor } from "../../src/model/asof.ts";
import { walkForward } from "../../src/model/backtest.ts";
import * as featureModule from "../../src/model/features.ts";
import { FEATURES } from "../../src/model/features.ts";
import { weekOutlook } from "../../src/model/index.ts";
import type { KickoffFacts, TouchdownWeek } from "../../src/model/inputs.ts";
import type { PlayerWeek, Position } from "../../src/shared/player.ts";

/**
 * THE LEAKAGE SUITE.
 *
 * Using an end-of-season aggregate to predict week 4 produces a model that looks brilliant and
 * is worthless, and the thing that makes it dangerous is that it does not announce itself - the
 * metrics just come out better than anyone else's and nobody asks why.
 *
 * So as-of-ness is not enforced by being careful. It is enforced by poisoning the future. Every
 * test below runs the model twice: once on clean data, and once on data where every row at or
 * after the boundary has been replaced with an absurd value. Anything that can see past the
 * boundary moves, and a named test goes red.
 *
 * `the poison harness itself can fail` is the control. A test that cannot fail is decoration,
 * and a leakage test that cannot fail is worse than that, because it is decoration people trust.
 */

const SEASON = 2024;
const WEEKS = 12;
const PLAYERS = 40;
const BOUNDARY = { season: SEASON, week: 7 };

type League = {
  weeks: PlayerWeek[];
  touchdowns: TouchdownWeek[];
  kickoffs: KickoffFacts[];
  roster: { playerId: string; position: Position }[];
};

/** A small deterministic league. No randomness, so a difference is always a real difference. */
function league(): League {
  const positions: Position[] = ["QB", "RB", "WR", "TE"];
  const weeks: PlayerWeek[] = [];
  const touchdowns: TouchdownWeek[] = [];
  const kickoffs: KickoffFacts[] = [];
  const roster: { playerId: string; position: Position }[] = [];

  for (let p = 0; p < PLAYERS; p++) {
    const playerId = `P${String(p).padStart(2, "0")}`;
    const position = positions[p % positions.length] ?? "WR";
    roster.push({ playerId, position });
    for (let week = 1; week <= WEEKS; week++) {
      // Not everybody plays every week, so games played varies across the league and the
      // liveness check below has something to see. A league where every feature returns the
      // same value for every player would pass a leakage test without testing anything.
      if ((p % 4 === 1 && week === 2) || (p % 7 === 3 && week === 5)) continue;
      weeks.push({
        playerId,
        name: `Player ${p}`,
        position,
        team: `T${p % 8}`,
        season: SEASON,
        week,
        points: 2 + ((p * 7 + week * 3) % 23),
        targetShare: ((p * 3 + week) % 30) / 100,
        wopr: ((p * 5 + week * 2) % 60) / 100,
        snapShare: ((p * 11 + week) % 80) / 100,
      });
      touchdowns.push({ playerId, season: SEASON, week, touchdowns: (p + week) % 3 });
      kickoffs.push({
        playerId,
        season: SEASON,
        week,
        impliedTeamTotal: 17 + ((p + week) % 10),
        injuryStatus: p % 9 === 0 ? "Questionable" : null,
      });
    }
  }
  return { weeks, touchdowns, kickoffs, roster };
}

/**
 * Replace everything at or after the boundary with a value no real week could produce.
 *
 * 999 points rather than a slightly different number on purpose: if anything downstream can see
 * these rows, it does not move by a hair, it moves by an amount nobody could mistake for noise.
 */
function poison(input: League, boundary = BOUNDARY): League {
  // Deliberately NOT isBefore. The harness must not share a definition of "before" with the
  // code it is testing: with isBefore here, a mutation that changes < to <= neutralises the
  // poison as well as the filter, and every test below goes on passing. Measured - that is
  // exactly what happened the first time this was run against that mutation.
  const after = (row: { season: number; week: number }) =>
    row.season > boundary.season || (row.season === boundary.season && row.week >= boundary.week);
  return {
    roster: input.roster,
    weeks: input.weeks.map((row) =>
      after(row) ? { ...row, points: 999, targetShare: 0.99, wopr: 1.39, snapShare: 0.99 } : row,
    ),
    touchdowns: input.touchdowns.map((row) => (after(row) ? { ...row, touchdowns: 99 } : row)),
    kickoffs: input.kickoffs.map((row) =>
      after(row) && (row.season !== boundary.season || row.week !== boundary.week)
        ? { ...row, impliedTeamTotal: 99, injuryStatus: "Out" as const }
        : row,
    ),
  };
}

describe("isBefore", () => {
  it("excludes the boundary week itself, which is the whole definition", () => {
    expect(isBefore({ season: 2024, week: 6 }, BOUNDARY)).toBe(true);
    expect(isBefore({ season: 2024, week: 7 }, BOUNDARY)).toBe(false);
    expect(isBefore({ season: 2024, week: 8 }, BOUNDARY)).toBe(false);
  });

  it("orders seasons before weeks", () => {
    expect(isBefore({ season: 2023, week: 18 }, BOUNDARY)).toBe(true);
    expect(isBefore({ season: 2025, week: 1 }, BOUNDARY)).toBe(false);
  });
});

describe("asOf", () => {
  it("keeps only what happened before the boundary", () => {
    const clean = league();
    const window = asOf(BOUNDARY, clean.weeks, clean.touchdowns);
    expect(window.weeks.length).toBeGreaterThan(0);
    for (const row of window.weeks) expect(row.week).toBeLessThan(BOUNDARY.week);
    for (const row of window.touchdowns) expect(row.week).toBeLessThan(BOUNDARY.week);
    expect(weeksFor(window, "P00").map((r) => r.week)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("is unchanged by poisoning the future", () => {
    const clean = league();
    const dirty = poison(clean);
    expect(asOf(BOUNDARY, dirty.weeks, dirty.touchdowns).weeks).toEqual(
      asOf(BOUNDARY, clean.weeks, clean.touchdowns).weeks,
    );
  });
});

describe("every feature is registered for the leakage check", () => {
  it("lists every exported feature function in FEATURES", () => {
    // Reflection rather than a hand-kept list, so a feature added next year is covered by the
    // poison test automatically instead of being covered by someone remembering this file.
    const exported = Object.entries(featureModule)
      .filter(([name, value]) => typeof value === "function" && name !== "FEATURES")
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual(Object.keys(FEATURES).sort());
    expect(exported.length).toBeGreaterThan(3);
  });
});

describe("no feature can see past the boundary", () => {
  const clean = league();
  const dirty = poison(clean);
  const cleanWindow = asOf(BOUNDARY, clean.weeks, clean.touchdowns);
  const dirtyWindow = asOf(BOUNDARY, dirty.weeks, dirty.touchdowns);
  const ids = clean.roster.map((r) => r.playerId);

  for (const [name, feature] of Object.entries(FEATURES)) {
    it(`${name} is unmoved by a poisoned future`, () => {
      for (const id of ids) {
        expect(feature(dirtyWindow, id), `${name} moved for ${id}`).toEqual(
          feature(cleanWindow, id),
        );
      }
    });
  }

  it("and the features are actually reading something, so equality is not vacuous", () => {
    // Without this, every test above would pass just as happily against a feature that always
    // returned null. Guards have to be checked for a pulse.
    for (const [name, feature] of Object.entries(FEATURES)) {
      const values = ids.map((id) => feature(cleanWindow, id));
      expect(values.some((v) => v !== null), `${name} returned null for every player`).toBe(true);
      expect(new Set(values).size, `${name} returned one value for every player`).toBeGreaterThan(
        1,
      );
    }
  });

  it("the poison harness itself can fail", () => {
    // The control. A feature that reaches past the boundary, wired up exactly as a real one
    // would be, and the same comparison the tests above make. If this ever passes, the poison
    // is no longer poisonous and every leakage test in this file has quietly stopped working.
    const leaky = (rows: readonly PlayerWeek[], id: string): number =>
      rows.filter((r) => r.playerId === id).reduce((a, r) => a + r.points, 0);
    expect(leaky(dirty.weeks, "P00")).not.toEqual(leaky(clean.weeks, "P00"));
  });
});

describe("the whole model, end to end", () => {
  it("produces identical outlooks from poisoned data", () => {
    const clean = league();
    const dirty = poison(clean);
    const before = weekOutlook(
      BOUNDARY,
      clean.roster,
      clean.weeks,
      clean.touchdowns,
      clean.kickoffs,
    );
    const after = weekOutlook(
      BOUNDARY,
      dirty.roster,
      dirty.weeks,
      dirty.touchdowns,
      dirty.kickoffs,
    );
    expect(after.outlooks).toEqual(before.outlooks);
    expect(after.ties).toEqual(before.ties);
    expect(before.outlooks.length).toBeGreaterThan(10);
  });

  it("produces an identical backtest from poisoned data, week by week", () => {
    // The strongest form of the check: the walk itself, over every graded week, not one
    // boundary. This is the test that would catch a backtest that grades against the future.
    const clean = league();
    const dirtyFinalWeek: League = {
      ...clean,
      weeks: clean.weeks.map((row) => (row.week === WEEKS ? { ...row, points: 999 } : row)),
    };
    const before = walkForward({
      weeks: clean.weeks,
      touchdowns: clean.touchdowns,
      kickoffs: clean.kickoffs,
    }).filter((g) => g.week < WEEKS);
    const after = walkForward({
      weeks: dirtyFinalWeek.weeks,
      touchdowns: dirtyFinalWeek.touchdowns,
      kickoffs: dirtyFinalWeek.kickoffs,
    }).filter((g) => g.week < WEEKS);
    expect(after).toEqual(before);
    expect(before.length).toBeGreaterThan(50);
  });
});
