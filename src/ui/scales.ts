/**
 * The mapping from points to pixels, and the ticks along it.
 *
 * Separated from every renderer because it is the one thing they must agree on. The ridge
 * stack, the ruler above it, the tie bands drawn across two lanes and the simulator's margin
 * strip all place things at the same points value, and if any two of them computed that
 * placement independently the page's whole claim - that you can compare these shapes by eye -
 * would be true only by coincidence.
 */

export type Scale = {
  /** Points to pixels. */
  readonly at: (points: number) => number;
  /** Pixels back to points, for the crosshair readout. */
  readonly invert: (px: number) => number;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
};

export function linear(domain: readonly [number, number], range: readonly [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  // A zero-width domain would divide by zero and paint every value at the same pixel, which
  // looks like a render bug rather than like bad input. Collapse to the range start instead.
  const span = d1 - d0;
  const k = span === 0 ? 0 : (r1 - r0) / span;
  return {
    at: (points) => r0 + (points - d0) * k,
    invert: (px) => (k === 0 ? d0 : d0 + (px - r0) / k),
    domain,
    range,
  };
}

/**
 * Tick values at a round step, covering the domain.
 *
 * `target` is a wish, not a promise: the step is snapped to 1, 2, 5 or 10 times a power of ten,
 * so a ruler on a 400px phone and the same ruler on a desktop carry the same kind of number.
 * Ticks at 7.3 and 14.6 are what an auto-scaler gives you and they are unreadable on a scale
 * whose whole job is to be read.
 */
export function ticks(min: number, max: number, target: number): number[] {
  if (!(max > min) || target < 1) return [];
  const raw = (max - min) / target;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const out: number[] = [];
  // Start at the first round multiple at or above min, and guard the count: a NaN domain used
  // to spin this loop forever with the tab pinned at 100%.
  for (let t = Math.ceil(min / step) * step, guard = 0; t <= max + 1e-9 && guard < 1000; t += step, guard++) {
    // Floating point leaves 19.999999999999996 where 20 belongs, and that renders as a label
    // wide enough to push the ruler off the page.
    out.push(Math.round(t / step) * step);
  }
  return out;
}

/**
 * Device-pixel sizing for a canvas, returned rather than applied to a global.
 *
 * Every canvas here does the same three things and got them subtly different twice: set the
 * backing store to CSS size times DPR, leave the CSS size alone, and scale the context so all
 * drawing code can keep working in CSS pixels. `dpr` is capped at 2 because a 3x phone backing
 * store for a 10,000-point scatter is nine times the fill rate for a difference nobody can see
 * on a density curve.
 */
export function sizeCanvas(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  devicePixelRatio: number,
): { width: number; height: number; dpr: number } {
  const dpr = Math.min(2, Math.max(1, devicePixelRatio || 1));
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  // Assigning width/height clears the canvas even when the value is unchanged, which threw
  // away an accumulated scatter every time the pointer moved. Only touch it on a real change.
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: w, height: h, dpr };
}
