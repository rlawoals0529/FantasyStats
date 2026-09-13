/**
 * The week, simulated, and the three pictures it resolves into.
 *
 * The thing being shown is not a score. It is that ten thousand plausible Sundays contain both
 * outcomes, and that the share of them you win only becomes a number you can say out loud after
 * a few thousand of them. So all three plots are about where the mass is, and the one that
 * matters most is the least obvious: the interval, collapsing.
 *
 *   CLOUD      every matchup as a dot at (your total, their total), with the line where the two
 *              are equal drawn through it. Below the line you won. The win probability is that
 *              share of the cloud, and it is literally the area you can see, not a figure in a
 *              box beside a picture of something else.
 *   MARGIN     the same ten thousand collapsed onto their difference, with zero marked. The
 *              filled half is the same quantity again, seen end-on.
 *   INTERVAL   the running estimate against a log sample count, with its 95 per cent band. It
 *              starts wide enough to contain a coin flip and ends about a point either side.
 *              While the band still crosses 50, the matchup is not called, and the page says so.
 *
 * THE SCATTER IS NEVER REDRAWN. Ten thousand dots repainted every frame is 600,000 fills a
 * second for a picture that only ever gains points. They accumulate on an offscreen canvas that
 * is blitted once per frame, so the per-frame cost is one image copy plus the overlay, and the
 * cost of a dot is paid exactly once. That is the whole reason this is canvas and not SVG: ten
 * thousand nodes is not slow to draw, it is slow to own.
 */

import { linear, sizeCanvas, type Scale } from "./scales.ts";
import { estimate, marginDensity, type Estimate } from "./stats.ts";
import type { Palette } from "./tokens.ts";

/* ---- The cloud ----------------------------------------------------------------------- */

/** Margins around the scatter, leaving room for a marginal density on two sides. */
const PAD = { left: 44, bottom: 44, top: 3, right: 3 } as const;

export class CloudPainter {
  #ink: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D | null = null;
  #width = 0;
  #height = 0;
  #dpr = 1;
  /** How many draws have already been painted, so a frame paints only what is new. */
  #painted = 0;
  #mineBins: Float64Array;
  #theirBins: Float64Array;
  #binPeak = 0;
  readonly bins: number;

  constructor(bins = 72) {
    this.bins = bins;
    this.#ink = document.createElement("canvas");
    this.#mineBins = new Float64Array(bins);
    this.#theirBins = new Float64Array(bins);
  }

  /** Size the accumulation buffer and throw away what is on it. Called on resize and on run. */
  reset(width: number, height: number, dpr: number): void {
    this.#width = Math.max(1, Math.round(width));
    this.#height = Math.max(1, Math.round(height));
    this.#dpr = Math.min(2, Math.max(1, dpr));
    this.#ink.width = Math.round(this.#width * this.#dpr);
    this.#ink.height = Math.round(this.#height * this.#dpr);
    const ctx = this.#ink.getContext("2d");
    if (ctx) ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    this.#ctx = ctx;
    this.#painted = 0;
    this.#mineBins.fill(0);
    this.#theirBins.fill(0);
    this.#binPeak = 0;
  }

  get painted(): number {
    return this.#painted;
  }

  /**
   * Paint every matchup drawn since the last call.
   *
   * Batched by colour: all the wins in one pass, then all the losses. Switching `fillStyle`
   * between individual one-pixel fills is the single most expensive thing a 2D context can be
   * asked to do, and on a ten thousand point cloud it was most of the frame.
   */
  add(
    mine: Float64Array,
    theirs: Float64Array,
    drawn: number,
    palette: Palette,
    x: Scale,
    y: Scale,
  ): void {
    const ctx = this.#ctx;
    if (!ctx || drawn <= this.#painted) return;
    const from = this.#painted;

    for (const win of [true, false]) {
      // Not equal. The losing half is the ground the winning half is read against, so it is
      // held back; at matched alphas ten thousand dots of each read as one grey cloud and the
      // split the whole plot exists to show disappears into it.
      ctx.fillStyle = win ? palette.alpha("accent", 0.55) : palette.alpha("dim", 0.3);
      for (let i = from; i < drawn; i++) {
        const a = mine[i]!;
        const b = theirs[i]!;
        if (a > b !== win) continue;
        ctx.fillRect(x.at(a) - 0.75, y.at(b) - 0.75, 1.5, 1.5);
      }
    }

    const [lo, hi] = x.domain;
    const width = (hi - lo) / this.bins;
    for (let i = from; i < drawn; i++) {
      const ia = Math.max(0, Math.min(this.bins - 1, Math.floor((mine[i]! - lo) / width)));
      const ib = Math.max(0, Math.min(this.bins - 1, Math.floor((theirs[i]! - lo) / width)));
      this.#mineBins[ia]! += 1;
      this.#theirBins[ib]! += 1;
      if (this.#mineBins[ia]! > this.#binPeak) this.#binPeak = this.#mineBins[ia]!;
      if (this.#theirBins[ib]! > this.#binPeak) this.#binPeak = this.#theirBins[ib]!;
    }
    this.#painted = drawn;
  }

  /** Copy the accumulated cloud onto the visible canvas and draw the overlay over it. */
  blit(ctx: CanvasRenderingContext2D, palette: Palette, x: Scale, y: Scale): void {
    const w = this.#width;
    const h = this.#height;
    ctx.clearRect(0, 0, w, h);
    if (this.#ink.width > 0) ctx.drawImage(this.#ink, 0, 0, w, h);

    // The line where the two totals are equal. --fg rather than --accent: this is the boundary
    // the whole picture is read against, and --accent falls to 2.11:1 on one of the palettes.
    // Colour is not carrying the split either way - which side of this line a dot is on is.
    ctx.strokeStyle = palette.hex["fg"];
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    const [lo, hi] = x.domain;
    ctx.moveTo(x.at(lo), y.at(lo));
    ctx.lineTo(x.at(hi), y.at(hi));
    ctx.stroke();

    if (this.#binPeak > 0) {
      const [dlo, dhi] = x.domain;
      const step = (dhi - dlo) / this.bins;
      // Yours along the bottom, theirs up the left. Two one-dimensional views of the same cloud,
      // each placed on the axis it belongs to, so no legend is needed to say which is which.
      // Both grow AWAY from the scatter, into the margin the padding already reserved.
      this.#ridge(ctx, palette, this.#mineBins, step, dlo, x, h - PAD.bottom, PAD.bottom - 4, false);
      this.#ridge(ctx, palette, this.#theirBins, step, dlo, y, PAD.left, PAD.left - 4, true);
    }
  }

  /**
   * One marginal density along one edge.
   *
   * `base` is the edge it stands on and `depth` how far into the margin it may grow. `vertical`
   * swaps which coordinate carries the value: on the left edge the density grows in x and the
   * scale runs down y, and on the bottom edge it is the other way round. Both grow outward, so
   * neither ever paints over the cloud it is summarising.
   */
  #ridge(
    ctx: CanvasRenderingContext2D,
    palette: Palette,
    bins: Float64Array,
    step: number,
    lo: number,
    scale: Scale,
    base: number,
    depth: number,
    vertical: boolean,
  ): void {
    if (depth <= 0 || this.#binPeak <= 0) return;
    const unit = depth / this.#binPeak;
    const firstAt = scale.at(lo + 0.5 * step);
    const lastAt = scale.at(lo + (bins.length - 0.5) * step);
    ctx.beginPath();
    ctx.moveTo(vertical ? base : firstAt, vertical ? firstAt : base);
    for (let i = 0; i < bins.length; i++) {
      const at = scale.at(lo + (i + 0.5) * step);
      // Away from the plot: left of the left edge, below the bottom edge.
      const off = vertical ? base - bins[i]! * unit : base + bins[i]! * unit;
      ctx.lineTo(vertical ? off : at, vertical ? at : off);
    }
    ctx.lineTo(vertical ? base : lastAt, vertical ? lastAt : base);
    ctx.closePath();
    ctx.fillStyle = vertical ? palette.alpha("accent-2", 0.5) : palette.alpha("accent", 0.5);
    ctx.fill();
    ctx.strokeStyle = vertical ? palette.hex["accent-2"] : palette.hex["accent-text"];
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** The scatter's two scales, both over the same domain so the diagonal really is a diagonal. */
export function cloudScales(
  width: number,
  height: number,
  domain: readonly [number, number],
): { x: Scale; y: Scale } {
  return {
    x: linear(domain, [PAD.left, width - PAD.right]),
    y: linear(domain, [height - PAD.bottom, PAD.top]),
  };
}

/* ---- The margin ----------------------------------------------------------------------- */

/**
 * The difference between the two totals, filled on the side you win.
 *
 * Recomputed from the drawn prefix every frame rather than accumulated, because unlike the
 * scatter it is 72 bins whatever the sample size and the pass over ten thousand differences is
 * a few hundredths of a millisecond. Accumulating it would mean two code paths for the same
 * histogram and one of them would drift.
 */
export function drawMargin(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  mine: Float64Array,
  theirs: Float64Array,
  drawn: number,
  half: number,
  width: number,
  height: number,
  bins = 80,
): void {
  ctx.clearRect(0, 0, width, height);
  const pdf = marginDensity(mine, theirs, drawn, half, bins);
  let peak = 0;
  for (let i = 0; i < bins; i++) if (pdf[i]! > peak) peak = pdf[i]!;

  const x = linear([-half, half], [0, width]);
  const base = height - 16;
  const unit = peak > 0 ? (base - 4) / peak : 0;
  const step = (2 * half) / bins;

  for (const winning of [false, true]) {
    ctx.beginPath();
    ctx.moveTo(winning ? x.at(0) : 0, base);
    for (let i = 0; i < bins; i++) {
      const centre = -half + (i + 0.5) * step;
      if (winning !== centre > 0) continue;
      ctx.lineTo(x.at(centre), base - pdf[i]! * unit);
    }
    ctx.lineTo(winning ? width : x.at(0), base);
    ctx.closePath();
    ctx.fillStyle = winning ? palette.alpha("accent", 0.62) : palette.alpha("dim", 0.24);
    ctx.fill();
  }

  // The whole outline last, over both fills, so the shape reads as one distribution split by a
  // line rather than as two distributions that happen to touch.
  ctx.beginPath();
  for (let i = 0; i < bins; i++) {
    const centre = -half + (i + 0.5) * step;
    const py = base - pdf[i]! * unit;
    if (i === 0) ctx.moveTo(x.at(centre), py);
    else ctx.lineTo(x.at(centre), py);
  }
  ctx.strokeStyle = palette.hex["dim"];
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.strokeStyle = palette.hex["fg"];
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(Math.round(x.at(0)) + 0.5, 0);
  ctx.lineTo(Math.round(x.at(0)) + 0.5, base + 6);
  ctx.stroke();

  ctx.strokeStyle = palette.alpha("dim", 0.55);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(base) + 0.5);
  ctx.lineTo(width, Math.round(base) + 0.5);
  ctx.stroke();
}

/** A margin axis wide enough for the run and round enough to label. */
export function marginHalfWidth(mine: Float64Array, theirs: Float64Array, drawn: number): number {
  let worst = 0;
  const n = Math.min(drawn, mine.length, theirs.length);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(mine[i]! - theirs[i]!);
    if (d > worst) worst = d;
  }
  // Rounded up to a multiple of ten so the axis labels are numbers a person would say, and
  // floored at 20 so a lineup that is never close does not get a scale two points wide.
  return Math.max(20, Math.ceil(worst / 10) * 10);
}

/* ---- The interval ---------------------------------------------------------------------- */

/** One reading of the running estimate, kept so the trace can be redrawn after a resize. */
export type Trace = {
  n: Float64Array;
  p: Float64Array;
  lo: Float64Array;
  hi: Float64Array;
  length: number;
};

export function newTrace(capacity = 640): Trace {
  return {
    n: new Float64Array(capacity),
    p: new Float64Array(capacity),
    lo: new Float64Array(capacity),
    hi: new Float64Array(capacity),
    length: 0,
  };
}

export function pushTrace(trace: Trace, est: Estimate): void {
  if (trace.length >= trace.n.length || est.drawn < 1) return;
  const i = trace.length;
  trace.n[i] = est.drawn;
  trace.p[i] = est.p;
  trace.lo[i] = est.lo;
  trace.hi[i] = est.hi;
  trace.length = i + 1;
}

/**
 * Draw the running estimate and its 95 per cent band against a log sample count.
 *
 * The vertical scale is fixed at 0 to 1 and never rescales to the data. Zooming it would make
 * the collapse look more dramatic and would destroy the only thing on this plot worth knowing,
 * which is whether the band still contains 50. A matchup whose interval crosses the halfway
 * line has not been called, however many runs have gone into it, and a rescaled axis hides
 * exactly that.
 */
export function drawInterval(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  trace: Trace,
  runs: number,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  const x = linear([1, Math.log10(Math.max(100, runs))], [2, width - 2]);
  const y = linear([0, 1], [height - 3, 3]);

  ctx.strokeStyle = palette.alpha("dim", 0.35);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const g of [0.25, 0.75]) {
    ctx.moveTo(0, Math.round(y.at(g)) + 0.5);
    ctx.lineTo(width, Math.round(y.at(g)) + 0.5);
  }
  ctx.stroke();

  // The coin flip. Everything on this plot is read against it.
  ctx.strokeStyle = palette.hex["fg"];
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, Math.round(y.at(0.5)) + 0.5);
  ctx.lineTo(width, Math.round(y.at(0.5)) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  if (trace.length < 2) return;

  ctx.fillStyle = palette.alpha("accent", 0.4);
  ctx.beginPath();
  for (let i = 0; i < trace.length; i++) ctx.lineTo(x.at(Math.log10(trace.n[i]!)), y.at(trace.hi[i]!));
  for (let i = trace.length - 1; i >= 0; i--) ctx.lineTo(x.at(Math.log10(trace.n[i]!)), y.at(trace.lo[i]!));
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = palette.hex["accent-text"];
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let i = 0; i < trace.length; i++) {
    const px = x.at(Math.log10(trace.n[i]!));
    const py = y.at(trace.p[i]!);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

/* ---- The still composition ------------------------------------------------------------ */

/**
 * One rung of the reduced-motion exhibit: a finished cloud at one sample size.
 *
 * Four of these side by side at 100, 1,000, 5,000 and 10,000 draws say the same thing the
 * animation says, and arguably say it better, because the reader can look back and forth
 * instead of having to remember what a hundred draws looked like two seconds ago. It is a
 * composition, not the animation with its clock removed.
 */
export function drawStill(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  mine: Float64Array,
  theirs: Float64Array,
  drawn: number,
  domain: readonly [number, number],
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  const x = linear(domain, [1, width - 1]);
  const y = linear(domain, [height - 1, 1]);
  for (const win of [true, false]) {
      ctx.fillStyle = win ? palette.alpha("accent", 0.62) : palette.alpha("dim", 0.24);
    for (let i = 0; i < drawn; i++) {
      const a = mine[i]!;
      const b = theirs[i]!;
      if (a > b !== win) continue;
      ctx.fillRect(x.at(a) - 0.5, y.at(b) - 0.5, 1.2, 1.2);
    }
  }
  ctx.strokeStyle = palette.hex["fg"];
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x.at(domain[0]), y.at(domain[0]));
  ctx.lineTo(x.at(domain[1]), y.at(domain[1]));
  ctx.stroke();
}

/** The square domain both axes of a cloud share, rounded to something a person would say. */
export function cloudDomain(
  mine: Float64Array,
  theirs: Float64Array,
  drawn: number,
): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const n = Math.min(drawn, mine.length, theirs.length);
  for (let i = 0; i < n; i++) {
    const a = mine[i]!;
    const b = theirs[i]!;
    if (a < lo) lo = a;
    if (b < lo) lo = b;
    if (a > hi) hi = a;
    if (b > hi) hi = b;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [0, 200];
  return [Math.floor(lo / 10) * 10, Math.ceil(hi / 10) * 10];
}

export { estimate, sizeCanvas };
