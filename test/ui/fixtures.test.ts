import { describe, expect, it } from "vitest";
import {
  fixtureBoard,
  fixtureSimulator,
  lognormalDensity,
  mulberry32,
  spreadFor,
} from "../../src/ui/fixtures/generate.ts";
import { GRID_SIZE, GRID_STEP, gridIndex, gridPoints } from "../../src/ui/ports.ts";
import { isOnGrid, mass, overlap, quantile, tailAbove, tailBelow } from "../../src/ui/stats.ts";
import { BUST_POINTS, SEPARABLE_OVERLAP, SPIKE_POINTS } from "../../src/shared/player.ts";

const week = fixtureBoard();

describe("the shared grid", () => {
  it("round-trips a points value through its index", () => {
    for (const points of [0, 7.25, 20, 33.5, 48]) {
      expect(gridPoints(gridIndex(points))).toBeCloseTo(points, 6);
    }
  });

  it("clamps rather than running off either end", () => {
    expect(gridIndex(-1000)).toBe(0);
    expect(gridIndex(1000)).toBe(GRID_SIZE - 1);
  });
});

describe("spreadFor", () => {
  it("follows the measured ladder at its rungs", () => {
    expect(spreadFor(3)).toBeCloseTo(2.93, 2);
    expect(spreadFor(9.5)).toBeCloseTo(6.21, 2);
    expect(spreadFor(17)).toBeCloseTo(8.42, 2);
  });

  it("is monotonic, because better players are absolutely more variable", () => {
    let last = 0;
    for (let mean = 1; mean <= 25; mean += 0.5) {
      const sd = spreadFor(mean);
      expect(sd).toBeGreaterThanOrEqual(last - 1e-9);
      last = sd;
    }
  });

  it("makes better players relatively MORE consistent, which is the measured shape", () => {
    expect(spreadFor(3) / 3).toBeGreaterThan(spreadFor(17) / 17);
  });

  it("flattens past the ends of the ladder instead of extrapolating", () => {
    expect(spreadFor(-40)).toBe(spreadFor(1));
    expect(spreadFor(400)).toBe(spreadFor(17));
  });
});

describe("lognormalDensity", () => {
  it("integrates to 1 over the grid", () => {
    for (const [mean, sd] of [[4, 3], [12, 7], [22, 8.4]] as const) {
      expect(mass(lognormalDensity(mean, sd))).toBeCloseTo(1, 6);
    }
  });

  it("is right-skewed, so the mean sits above the median", () => {
    const pdf = lognormalDensity(14, 8);
    let mean = 0;
    for (let i = 0; i < GRID_SIZE; i++) mean += gridPoints(i) * pdf[i]! * GRID_STEP;
    expect(mean).toBeGreaterThan(quantile(pdf, 0.5));
  });

  it("puts no mass below the shift", () => {
    const pdf = lognormalDensity(10, 6);
    for (let i = 0; i < gridIndex(-1.5); i++) expect(pdf[i]).toBe(0);
  });
});

describe("mulberry32", () => {
  it("is deterministic for a seed and different across seeds", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const c = mulberry32(8);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
  });

  it("stays inside the unit interval", () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 5000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("the fixture board", () => {
  it("is the same board on every load", () => {
    const again = fixtureBoard();
    expect(again.players.map((p) => p.outlook.playerId)).toEqual(
      week.players.map((p) => p.outlook.playerId),
    );
    expect(again.players[0]!.outlook.spike).toBe(week.players[0]!.outlook.spike);
  });

  it("hands every density over on the shared grid", () => {
    for (const p of week.players) {
      expect(isOnGrid(p.density), p.name).toBe(true);
      expect(mass(p.density)).toBeCloseTo(1, 5);
    }
  });

  it("derives every printed figure from the density it draws", () => {
    // The one failure this page could not survive is a number beside a shape that disagrees
    // with the shape. So each is recomputed here from the array the renderer is handed.
    for (const p of week.players) {
      expect(p.outlook.p10).toBeCloseTo(quantile(p.density, 0.1), 9);
      expect(p.outlook.p50).toBeCloseTo(quantile(p.density, 0.5), 9);
      expect(p.outlook.p90).toBeCloseTo(quantile(p.density, 0.9), 9);
      expect(p.outlook.spike).toBeCloseTo(tailAbove(p.density, SPIKE_POINTS), 9);
      expect(p.outlook.bust).toBeCloseTo(tailBelow(p.density, BUST_POINTS), 9);
    }
  });

  it("keeps the quantiles in order", () => {
    for (const p of week.players) {
      expect(p.outlook.p10).toBeLessThan(p.outlook.p50);
      expect(p.outlook.p50).toBeLessThan(p.outlook.p90);
    }
  });

  it("reports every tied pair, not only the neighbouring ones", () => {
    const byId = new Map(week.players.map((p) => [p.outlook.playerId, p]));
    let expected = 0;
    for (let i = 0; i < week.players.length; i++) {
      for (let j = i + 1; j < week.players.length; j++) {
        if (overlap(week.players[i]!.density, week.players[j]!.density) >= SEPARABLE_OVERLAP) {
          expected++;
        }
      }
    }
    expect(week.ties).toHaveLength(expected);
    for (const tie of week.ties) {
      const a = byId.get(tie.a)!;
      const b = byId.get(tie.b)!;
      expect(tie.overlap).toBeCloseTo(overlap(a.density, b.density), 9);
      expect(tie.overlap).toBeGreaterThanOrEqual(SEPARABLE_OVERLAP);
    }
  });

  it("finds ties that are not adjacent on the printed order", () => {
    const order = [...week.players].sort((a, b) => b.outlook.spike - a.outlook.spike);
    const rank = new Map(order.map((p, i) => [p.outlook.playerId, i]));
    const gaps = week.ties.map((t) => Math.abs(rank.get(t.a)! - rank.get(t.b)!));
    expect(Math.max(...gaps)).toBeGreaterThan(3);
  });

  it("attaches a measured basis to every reason", () => {
    for (const p of week.players) {
      expect(p.outlook.because.length).toBeGreaterThan(0);
      for (const r of p.outlook.because) {
        expect(r.basis.length).toBeGreaterThan(10);
        expect(Number.isFinite(r.effect)).toBe(true);
      }
    }
  });

  it("grades itself with buckets that are not all on the diagonal", () => {
    const misses = week.scorecard.filter((b) => Math.abs(b.realised - b.predicted) > 0.02);
    expect(misses.length).toBeGreaterThan(0);
    for (const b of week.scorecard) expect(b.n).toBeGreaterThan(0);
  });
});

describe("the fixture simulator", () => {
  const spec = {
    mine: week.players.slice(0, 5).map((p) => p.outlook.playerId),
    theirs: week.players.slice(5, 10).map((p) => p.outlook.playerId),
    runs: 2000,
    seed: 4242,
  };
  const make = fixtureSimulator(week);

  it("fills only the prefix it was asked for", () => {
    const sim = make(spec);
    expect(sim.drawn).toBe(0);
    expect(sim.draw(300)).toBe(300);
    expect(sim.drawn).toBe(300);
    expect(sim.mine[299]).toBeGreaterThan(0);
    expect(sim.mine[300]).toBe(0);
  });

  it("stops at the run count and reports zero afterwards", () => {
    const sim = make(spec);
    expect(sim.draw(5000)).toBe(2000);
    expect(sim.draw(10)).toBe(0);
    expect(sim.drawn).toBe(2000);
  });

  it("gives the same clouds for the same seed and different ones otherwise", () => {
    const a = make(spec);
    const b = make(spec);
    const c = make({ ...spec, seed: 1 });
    a.draw(400);
    b.draw(400);
    c.draw(400);
    expect([...a.mine.slice(0, 400)]).toEqual([...b.mine.slice(0, 400)]);
    expect([...c.mine.slice(0, 400)]).not.toEqual([...a.mine.slice(0, 400)]);
  });

  it("draws a prefix identical to a longer run on the same seed", () => {
    // This is what lets the axes be fixed by a short pilot without disturbing the real run.
    const pilot = make({ ...spec, runs: 400 });
    const full = make(spec);
    pilot.draw(400);
    full.draw(400);
    expect([...pilot.mine]).toEqual([...full.mine.slice(0, 400)]);
  });

  it("produces totals near the sum of the lineup medians", () => {
    const sim = make(spec);
    sim.draw(2000);
    const expected = spec.mine.reduce((sum, id) => {
      const p = week.players.find((q) => q.outlook.playerId === id)!;
      return sum + p.outlook.p50;
    }, 0);
    const sorted = [...sim.mine].sort((a, b) => a - b);
    const median = sorted[1000]!;
    expect(Math.abs(median - expected)).toBeLessThan(8);
  });

  it("ignores a player id it has never heard of rather than emitting NaN", () => {
    const sim = make({ ...spec, mine: ["nobody"] });
    sim.draw(50);
    expect([...sim.mine.slice(0, 50)].every((v) => v === 0)).toBe(true);
  });
});
