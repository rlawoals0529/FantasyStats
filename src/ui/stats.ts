/**
 * The arithmetic the pictures are made of.
 *
 * Kept out of the renderers so that every claim on screen has a function behind it that can be
 * failed by a test. A number drawn straight into a canvas is a number nobody can check.
 */

import { GRID_STEP, GRID_SIZE, gridPoints } from "./ports.ts";
import { SEPARABLE_OVERLAP, type Tie } from "../shared/player.ts";

/**
 * The overlapping area of two densities, which is the integral of their pointwise minimum.
 *
 * This is the figure `SEPARABLE_OVERLAP` is a threshold on, and it is the one quantity the page
 * draws literally: the shaded region where two ridges agree is this integral, rendered. 1.0 is
 * two identical distributions and 0.0 is two that never take the same value.
 */
export function overlap(a: Float64Array, b: Float64Array, step = GRID_STEP): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.min(a[i]!, b[i]!);
  return sum * step;
}

/** The area under a density, which should be 1 and is worth being able to assert. */
export function mass(pdf: Float64Array, step = GRID_STEP): number {
  let sum = 0;
  for (let i = 0; i < pdf.length; i++) sum += pdf[i]!;
  return sum * step;
}

/**
 * The points value at a quantile of a density.
 *
 * Linear interpolation inside the crossing cell rather than snapping to the grid: at a 0.25
 * point resolution, snapping puts p50 and p90 on the same tick for a tight distribution and the
 * readout then claims a range of zero for a player who plainly has one.
 */
export function quantile(pdf: Float64Array, q: number, step = GRID_STEP): number {
  const total = mass(pdf, step);
  if (total <= 0) return gridPoints(0);
  const want = q * total;
  let acc = 0;
  for (let i = 0; i < pdf.length; i++) {
    const cell = pdf[i]! * step;
    if (acc + cell >= want) {
      const within = cell > 0 ? (want - acc) / cell : 0;
      return gridPoints(i) + within * step;
    }
    acc += cell;
  }
  return gridPoints(pdf.length - 1);
}

/** Probability of a value at or above a threshold. The spike figure, from the shape itself. */
export function tailAbove(pdf: Float64Array, threshold: number, step = GRID_STEP): number {
  let sum = 0;
  for (let i = 0; i < pdf.length; i++) if (gridPoints(i) >= threshold) sum += pdf[i]!;
  return Math.min(1, sum * step);
}

/** Probability of a value at or below a threshold. The bust figure. */
export function tailBelow(pdf: Float64Array, threshold: number, step = GRID_STEP): number {
  let sum = 0;
  for (let i = 0; i < pdf.length; i++) if (gridPoints(i) <= threshold) sum += pdf[i]!;
  return Math.min(1, sum * step);
}

/** The tallest value in a density, so a lane can be scaled to its own peak. */
export function peak(pdf: Float64Array): number {
  let m = 0;
  for (let i = 0; i < pdf.length; i++) if (pdf[i]! > m) m = pdf[i]!;
  return m;
}

/* ---- Ties ---------------------------------------------------------------------------- */

/**
 * Where one player could actually sit in the order.
 *
 * The first version of this grouped consecutive tied rows into bands, and on real widths it
 * collapsed thirty-four of thirty-six players into a single band that said nothing. That was
 * the arithmetic being right and the model being wrong: tie is not transitive, so chaining
 * through it merges everything that touches anything. A player two rows down being
 * indistinguishable says nothing whatever about the row below that.
 *
 * What is true, and what this computes, is a RANGE. Rank 7 who cannot be separated from ranks
 * 3 through 14 could be any of those, and the honest thing to print is "7, somewhere in 3 to
 * 14". Every row gets one, they overlap each other freely, and a reader scanning the gutter
 * sees the ordering dissolve without a single row having to be suppressed.
 */
export type RankRange = {
  readonly id: string;
  /** Position in the printed order, from 1. */
  readonly rank: number;
  /** Best and worst rank this player is consistent with, inclusive, from 1. */
  readonly lo: number;
  readonly hi: number;
  /** Ids this player cannot be separated from, in board order. */
  readonly tiedWith: readonly string[];
  /** Weakest and strongest overlap in that set. Empty set reports zero for both. */
  readonly minOverlap: number;
  readonly maxOverlap: number;
};

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Rank ranges for an ordered board.
 *
 * `ties` is every unordered pair past `SEPARABLE_OVERLAP`, not only the adjacent ones: a pair
 * four rows apart is exactly the case this exists to show, and a producer that reports only
 * neighbours would silently narrow every range on the page.
 */
export function rankRanges(order: readonly string[], ties: readonly Tie[]): RankRange[] {
  const rankOf = new Map<string, number>();
  order.forEach((id, i) => rankOf.set(id, i + 1));

  const partners = new Map<string, { id: string; overlap: number }[]>();
  for (const t of ties) {
    if (t.overlap < SEPARABLE_OVERLAP) continue;
    if (!rankOf.has(t.a) || !rankOf.has(t.b)) continue;
    if (!partners.has(t.a)) partners.set(t.a, []);
    if (!partners.has(t.b)) partners.set(t.b, []);
    partners.get(t.a)!.push({ id: t.b, overlap: t.overlap });
    partners.get(t.b)!.push({ id: t.a, overlap: t.overlap });
  }

  return order.map((id, i) => {
    const mine = partners.get(id) ?? [];
    let lo = i + 1;
    let hi = i + 1;
    let minOverlap = 1;
    let maxOverlap = 0;
    for (const p of mine) {
      const r = rankOf.get(p.id)!;
      if (r < lo) lo = r;
      if (r > hi) hi = r;
      if (p.overlap < minOverlap) minOverlap = p.overlap;
      if (p.overlap > maxOverlap) maxOverlap = p.overlap;
    }
    const tiedWith = mine
      .map((p) => p.id)
      .sort((a, b) => rankOf.get(a)! - rankOf.get(b)!);
    return {
      id,
      rank: i + 1,
      lo,
      hi,
      tiedWith,
      minOverlap: mine.length ? minOverlap : 0,
      maxOverlap: mine.length ? maxOverlap : 0,
    };
  });
}

/** The overlap of one specific pair, for the readout beside a highlighted comparison. */
export function pairOverlap(ties: readonly Tie[], a: string, b: string): number | null {
  const want = pairKey(a, b);
  for (const t of ties) if (pairKey(t.a, t.b) === want) return t.overlap;
  return null;
}

/* ---- The simulator's running estimate ------------------------------------------------ */

export type Estimate = {
  /** Share of drawn matchups you won. */
  readonly p: number;
  /**
   * The 95 per cent interval, as its two ends rather than as a half-width.
   *
   * Ends, because the Wilson interval is ASYMMETRIC and near the extremes it is violently so.
   * A lineup that has won all forty draws so far has p = 1 with an interval of about 0.83 to
   * 1.00, and the first version of this returned the larger of the two gaps as a half-width,
   * which a caller then printed as `p plus or minus 17` - a claim of a 117 per cent chance.
   * Keeping both ends means no caller can reconstruct a number outside the scale.
   */
  readonly lo: number;
  readonly hi: number;
  /** Half the interval's width, for the one place a page can honestly print a single figure. */
  readonly halfWidth: number;
  readonly drawn: number;
  /** Share that finished exactly level. Reported, because a tie is not half a win. */
  readonly level: number;
};

/**
 * Win probability with its interval, from the drawn prefix of a simulation.
 *
 * The interval is the point of the animation. At n = 100 it is about 10 points wide either side
 * and the page cannot honestly call the matchup; by n = 10,000 it is about 1 and it can.
 * Watching that number stop moving is the argument this whole site makes, so it is computed
 * rather than faked and it is on screen the entire time.
 *
 * Wilson rather than the textbook normal interval: at p near 0 or 1, which is exactly where a
 * lopsided matchup sits, the normal interval runs off the end of the scale and would draw a
 * band claiming a 104 per cent chance.
 */
export function estimate(mine: Float64Array, theirs: Float64Array, drawn: number): Estimate {
  let wins = 0;
  let level = 0;
  const n = Math.max(0, Math.min(drawn, mine.length, theirs.length));
  for (let i = 0; i < n; i++) {
    const d = mine[i]! - theirs[i]!;
    if (d > 0) wins++;
    else if (d === 0) level++;
  }
  if (n === 0) return { p: 0, lo: 0, hi: 1, halfWidth: 0.5, drawn: 0, level: 0 };
  const p = wins / n;
  const z = 1.959964;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const spread = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  // Widened to contain the observed p as well as the Wilson centre. The two differ at small n,
  // and an interval that does not contain the figure printed beside it reads as a bug however
  // defensible the arithmetic is.
  const lo = Math.max(0, Math.min(p, centre - spread));
  const hi = Math.min(1, Math.max(p, centre + spread));
  return { p, lo, hi, halfWidth: (hi - lo) / 2, drawn: n, level: level / n };
}

/** The margin of each drawn matchup, yours minus theirs, as a density on a symmetric grid. */
export function marginDensity(
  mine: Float64Array,
  theirs: Float64Array,
  drawn: number,
  half: number,
  bins: number,
): Float64Array {
  const out = new Float64Array(bins);
  const n = Math.max(0, Math.min(drawn, mine.length, theirs.length));
  if (n === 0 || bins < 1 || half <= 0) return out;
  const width = (2 * half) / bins;
  for (let i = 0; i < n; i++) {
    const d = mine[i]! - theirs[i]!;
    const b = Math.max(0, Math.min(bins - 1, Math.floor((d + half) / width)));
    out[b]! += 1;
  }
  for (let b = 0; b < bins; b++) out[b]! /= n * width;
  return out;
}

/** A density smoothed just enough to draw, without moving where its mass is. */
export function smooth(pdf: Float64Array, radius: number): Float64Array {
  if (radius < 1) return pdf;
  const out = new Float64Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) {
    let sum = 0;
    let weight = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= pdf.length) continue;
      const w = 1 - Math.abs(k) / (radius + 1);
      sum += pdf[j]! * w;
      weight += w;
    }
    out[i] = weight > 0 ? sum / weight : 0;
  }
  return out;
}

/** Whether a producer met the shared grid. Checked at the port rather than trusted. */
export const isOnGrid = (pdf: Float64Array): boolean => pdf.length === GRID_SIZE;
