/**
 * A `DataSource` and a `SimulatorFactory` made of arithmetic, so this slice can be built and
 * measured before the other two land.
 *
 * The spread is not invented. `CONCEPT.md` measured a ladder of weekly standard deviation
 * against season mean, and this uses it, because a fixture whose shapes are the wrong width
 * would have let the whole interface be designed around distributions that do not exist. The
 * page's entire subject is width; getting it wrong here would not have shown up until real
 * data arrived and every tie band on the board changed.
 *
 * Everything downstream is derived from the density rather than stored beside it. `p50` comes
 * out of the same array the ridge is drawn from, and `spike` is the integral of the same array
 * above `SPIKE_POINTS`. That is not tidiness: it means the number printed beside a shape cannot
 * disagree with the shape, which is the one failure this page could not survive.
 */

import {
  GRID_SIZE,
  GRID_STEP,
  gridPoints,
  type DataSource,
  type MatchupSimulator,
  type MatchupSpec,
  type PlayerEntry,
  type RegressionEntry,
  type ScorecardBucket,
  type SimulatorFactory,
  type WeekBoard,
} from "../ports.ts";
import { SEPARABLE_OVERLAP, SPIKE_POINTS, BUST_POINTS, type Tie } from "../../shared/player.ts";
import { overlap, quantile, tailAbove, tailBelow } from "../stats.ts";
import { ROSTER, type RosterRow } from "./roster.ts";

/** Deterministic, seeded, and small enough to read. Same seed, same board, every reload. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Weekly standard deviation for a season mean, from the measured ladder.
 *
 * Interpolated between the rungs rather than stepped. A step function puts a visible seam in
 * the board where two players either side of 11.0 ppg get noticeably different widths for a
 * difference of a tenth of a point, and a reader comparing those two shapes would be reading an
 * artefact of the bucketing.
 */
export function spreadFor(mean: number): number {
  const ladder: readonly [number, number][] = [
    [3, 2.93],
    [6.5, 5.1],
    [9.5, 6.21],
    [12.5, 7.13],
    [17, 8.42],
  ];
  const first = ladder[0]!;
  const last = ladder[ladder.length - 1]!;
  if (mean <= first[0]) return first[1];
  if (mean >= last[0]) return last[1];
  for (let i = 1; i < ladder.length; i++) {
    const lo = ladder[i - 1]!;
    const hi = ladder[i]!;
    if (mean <= hi[0]) {
      const t = (mean - lo[0]) / (hi[0] - lo[0]);
      return lo[1] + t * (hi[1] - lo[1]);
    }
  }
  return last[1];
}

/**
 * A weekly-points density with the right mean, the right spread and a real right tail.
 *
 * Shifted lognormal, not a normal. Weekly fantasy scoring is floored near zero and has a long
 * upper tail because touchdowns arrive in lumps, and a symmetric curve gets the one number this
 * page leads with badly wrong: it puts too little mass past 20 for a mid player and too much for
 * a high-floor one, which is the exact comparison the board exists to make.
 */
export function lognormalDensity(mean: number, sd: number, shift = -1.5): Float64Array {
  const m = Math.max(0.5, mean - shift);
  const sigma2 = Math.log(1 + (sd / m) ** 2);
  const sigma = Math.sqrt(sigma2);
  const mu = Math.log(m) - sigma2 / 2;
  const out = new Float64Array(GRID_SIZE);
  for (let i = 0; i < GRID_SIZE; i++) {
    const x = gridPoints(i) - shift;
    if (x <= 0) continue;
    out[i] = Math.exp(-((Math.log(x) - mu) ** 2) / (2 * sigma2)) / (x * sigma * Math.sqrt(2 * Math.PI));
  }
  // Renormalised over the grid, not over the real line. The grid is truncated at both ends and
  // an un-renormalised curve loses a per cent or two of its mass off the edges, which then
  // shows up as a spike probability that does not match the area anybody can see.
  let total = 0;
  for (let i = 0; i < GRID_SIZE; i++) total += out[i]!;
  if (total > 0) for (let i = 0; i < GRID_SIZE; i++) out[i]! /= total * GRID_STEP;
  return out;
}

/** The cumulative table an inverse-CDF draw needs. Built once per player, reused per draw. */
function cdfOf(pdf: Float64Array): Float64Array {
  const out = new Float64Array(pdf.length);
  let acc = 0;
  for (let i = 0; i < pdf.length; i++) {
    acc += pdf[i]! * GRID_STEP;
    out[i] = acc;
  }
  // Force the last entry to exactly 1 so a uniform draw of 0.9999 cannot fall off the end.
  if (acc > 0) for (let i = 0; i < out.length; i++) out[i]! /= acc;
  return out;
}

function sampleFrom(cdf: Float64Array, u: number): number {
  // Binary search, because this runs ten thousand times per lineup slot and a linear scan over
  // 209 grid cells was measurably the cost of the whole simulation.
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid]! < u) lo = mid + 1;
    else hi = mid;
  }
  const prev = lo > 0 ? cdf[lo - 1]! : 0;
  const cell = cdf[lo]! - prev;
  const within = cell > 0 ? (u - prev) / cell : 0;
  return gridPoints(lo) + (within - 0.5) * GRID_STEP;
}

function entryFor(row: RosterRow, rng: () => number): PlayerEntry {
  // The mean is nudged off the season average, because a coming week is not the average of the
  // past ones. Small on purpose: a nudge big enough to reorder the board would be this fixture
  // inventing a signal that the measurement in CONCEPT.md says is not there.
  const mean = Math.max(1.5, row.ppg * (0.9 + rng() * 0.2));
  const sd = spreadFor(mean) * (0.92 + rng() * 0.18);
  const density = lognormalDensity(mean, sd);
  const impliedTotal = 17 + rng() * 12;
  const wopr = row.targetShare == null ? null : Math.min(0.95, row.targetShare * 1.6 + rng() * 0.12);
  const snapShare = 0.5 + rng() * 0.45;

  const gapEffect = -0.317 + rng() * 0.08;
  const because = [
    {
      label: "opportunity gap",
      value: row.targetShare == null ? `${Math.round(snapShare * 100)}% of snaps` : `${(row.targetShare * 100).toFixed(1)}% of targets`,
      effect: gapEffect * (rng() * 2 - 0.5),
      basis: "quartile split on production minus opportunity, 24,616 player-weeks",
    },
    {
      label: "implied team total",
      value: `${impliedTotal.toFixed(1)} points`,
      effect: (impliedTotal - 22) * 0.14,
      basis: "spike rate 3.5% under 17, 10.1% at 26 or more",
    },
    {
      label: "touchdown rate",
      value: rng() > 0.5 ? "above expectation" : "at expectation",
      effect: rng() > 0.5 ? -1.26 : 0.1,
      basis: "stickiness 0.453, hot shooters lose 1.26 ppg",
    },
  ];

  return {
    outlook: {
      playerId: row.id,
      p10: quantile(density, 0.1),
      p50: quantile(density, 0.5),
      p90: quantile(density, 0.9),
      spike: tailAbove(density, SPIKE_POINTS),
      bust: tailBelow(density, BUST_POINTS),
      because,
    },
    name: row.name,
    position: row.position,
    team: row.team,
    opponent: row.opponent,
    density,
    targetShare: row.targetShare,
    wopr,
    snapShare,
    impliedTotal,
  };
}

/**
 * Every pair the model will not separate, not only the neighbouring ones.
 *
 * All 630 pairs are compared. Reporting only adjacent pairs is the cheap version and it lies by
 * omission: the case the page exists to show is the seventh and the eleventh being the same
 * player, and that pair is three rows from being adjacent.
 */
function tiesOf(players: readonly PlayerEntry[]): Tie[] {
  const order = [...players].sort((a, b) => b.outlook.spike - a.outlook.spike);
  const out: Tie[] = [];
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a = order[i]!;
      const b = order[j]!;
      const o = overlap(a.density, b.density);
      // Every pair, with no early exit. Overlap is not monotone in board position - a narrow
      // shape five rows down can overlap more than a wide one directly below - so a break here
      // would drop real ties for a saving of a hundred thousand multiply-adds, run once.
      if (o >= SEPARABLE_OVERLAP) {
        out.push({ a: a.outlook.playerId, b: b.outlook.playerId, overlap: o });
      }
    }
  }
  return out;
}

function regressionOf(players: readonly PlayerEntry[], rng: () => number): RegressionEntry[] {
  return players
    .map((p) => {
      const gap = (rng() * 2 - 1) * 4.6;
      const touchdownGap = (rng() * 2 - 1) * 2.1;
      return {
        playerId: p.outlook.playerId,
        gap,
        touchdownGap,
        because: [
          {
            label: "production minus opportunity",
            value: `${gap > 0 ? "over" : "under"} by ${Math.abs(gap).toFixed(1)} ppg`,
            effect: -gap * 0.31,
            basis: "gap quartiles run 2.3 to 2.8 ppg apart, monotonic across RB, WR and TE",
          },
          {
            label: "touchdown rate against expectation",
            value: `${touchdownGap > 0 ? "+" : ""}${touchdownGap.toFixed(1)} ppg`,
            effect: -touchdownGap * 0.55,
            basis: "touchdown stickiness 0.453 between halves of a season",
          },
        ],
      };
    })
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, 10);
}

/**
 * The model's own grades, and they are not flattering on purpose.
 *
 * A scorecard whose buckets all land on the diagonal is a fixture that has quietly assumed the
 * thing the site is trying to prove. These are drawn off it, hardest at the high-confidence end,
 * because that is where a spike model actually fails and where the page should be seen to admit
 * it.
 */
const SCORECARD: readonly ScorecardBucket[] = [
  { predicted: 0.05, realised: 0.061, n: 1841 },
  { predicted: 0.15, realised: 0.141, n: 1216 },
  { predicted: 0.25, realised: 0.232, n: 764 },
  { predicted: 0.35, realised: 0.298, n: 431 },
  { predicted: 0.45, realised: 0.372, n: 218 },
  { predicted: 0.55, realised: 0.441, n: 96 },
];

export function fixtureBoard(seed = 20241015): WeekBoard {
  const rng = mulberry32(seed);
  const players = ROSTER.map((row) => entryFor(row, rng));
  return {
    season: 2024,
    week: 7,
    generatedAt: "2024-10-15T11:20:00Z",
    players,
    ties: tiesOf(players),
    regression: regressionOf(players, rng),
    scorecard: SCORECARD,
    scorecardNote:
      "the board claimed 47 spikes at an average stated chance of 24 per cent and got 39. Above a stated 40 per cent it runs 8 points over-confident, and has all season.",
  };
}

export function fixtureData(seed = 20241015): DataSource {
  return { load: async () => fixtureBoard(seed) };
}

/**
 * Draw lineup totals by inverse CDF off the same densities the board drew.
 *
 * Independent across players, which is a simplification the real simulator will not make - two
 * receivers on one offence share a ceiling - and it is stated rather than hidden because this is
 * a fixture. The port does not change when the real one arrives; only the numbers inside the two
 * arrays do.
 */
export function fixtureSimulator(board: WeekBoard): SimulatorFactory {
  const cdfs = new Map<string, Float64Array>();
  for (const p of board.players) cdfs.set(p.outlook.playerId, cdfOf(p.density));

  return (spec: MatchupSpec): MatchupSimulator => {
    const runs = Math.max(0, Math.floor(spec.runs));
    const mine = new Float64Array(runs);
    const theirs = new Float64Array(runs);
    const rng = mulberry32(spec.seed);
    const pick = (ids: readonly string[]) =>
      ids.map((id) => cdfs.get(id)).filter((c): c is Float64Array => c !== undefined);
    const a = pick(spec.mine);
    const b = pick(spec.theirs);
    let drawn = 0;

    return {
      runs,
      get drawn() {
        return drawn;
      },
      mine,
      theirs,
      draw(count) {
        const take = Math.max(0, Math.min(Math.floor(count), runs - drawn));
        for (let k = 0; k < take; k++) {
          let sa = 0;
          for (const cdf of a) sa += sampleFrom(cdf, rng());
          let sb = 0;
          for (const cdf of b) sb += sampleFrom(cdf, rng());
          mine[drawn] = sa;
          theirs[drawn] = sb;
          drawn++;
        }
        return take;
      },
    };
  };
}
