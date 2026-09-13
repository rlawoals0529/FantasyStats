/**
 * The board's ink.
 *
 * One canvas behind thirty-six rows, drawn from rectangles the rows themselves report. The
 * renderer knows no breakpoint and no row height: it is handed a list of lanes in canvas-local
 * pixels and it fills them. That is why the board reflows correctly at 400px without a second
 * code path, and why changing the row layout is a CSS edit rather than a CSS edit plus a
 * matching set of constants in here that somebody will forget.
 *
 * ONE VERTICAL SCALE ACROSS THE WHOLE BOARD, and it is the decision the picture rests on. Every
 * density integrates to 1, so a tight player is tall and narrow and a volatile one is short and
 * wide, with the same amount of ink under each. Normalising each lane to its own peak would
 * make every player the same height, which is the prettier picture and it throws away the
 * comparison: equal area is what lets a reader see that two shapes carry the same probability
 * spread differently. The scale factor comes from the tallest visible lane, so the board uses
 * its full height without any lane being clipped.
 *
 * No text is drawn here. Not one label, not one number. Everything a reader has to read is a
 * DOM node over this canvas, which is what makes the board keyboard-navigable, screen-readable,
 * selectable, and measurable by the contrast sweep. A number painted into a canvas is a number
 * nobody can check and nobody can copy.
 */

import { gridIndex, gridPoints } from "./ports.ts";
import type { Scale } from "./scales.ts";
import type { Palette } from "./tokens.ts";

/** One player's slot on the board, in canvas-local CSS pixels. */
export type Lane = {
  readonly id: string;
  /** The ink rectangle, measured off the row's own empty lane element. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly density: Float64Array;
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  /** Whether this row can be told apart from the row above it. Row 0 is always true. */
  readonly separableFromAbove: boolean;
  /** Best and worst rank this player is consistent with, as lane indexes from 0. */
  readonly lo: number;
  readonly hi: number;
};

export type StackScene = {
  readonly lanes: readonly Lane[];
  /** Index of the selected lane, or -1. */
  readonly selected: number;
  /** Ids the selected player cannot be separated from. */
  readonly tiedTo: ReadonlySet<string>;
  /** Points value of the spike gate. Everything at or past it is filled in --accent. */
  readonly gate: number;
  /** The left rail, in canvas-local pixels, where the tie chain is drawn. */
  readonly railX: number;
  readonly railW: number;
};

/**
 * Trace a density as a path along a lane baseline. Shared by the ridge and by its echo on a
 * tied lane, so the two cannot be drawn from different arithmetic.
 *
 * `xs` is the pixel of every grid index, computed once per draw rather than per lane. All the
 * lanes share one horizontal scale, so recomputing it per lane was the same numbers thirty-six
 * times over.
 */
function tracePath(
  ctx: CanvasRenderingContext2D,
  density: Float64Array,
  xs: Float64Array,
  lane: { x: number; y: number; w: number; h: number },
  unit: number,
  from: number,
  to: number,
): void {
  const base = lane.y + lane.h;
  ctx.beginPath();
  let started = false;
  for (let i = from; i <= to; i++) {
    const px = xs[i]!;
    if (px < lane.x - 2 || px > lane.x + lane.w + 2) continue;
    const py = base - density[i]! * unit;
    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }
  }
}

/**
 * Draw the whole board.
 *
 * Measured on a 36-lane board at 1180px wide this runs in well under a millisecond, because it
 * is 36 paths of about 200 points each and nothing is allocated inside the loop. It is called
 * on selection change and on resize, not per frame: a board that redraws sixty times a second
 * to show the same picture is a battery bug with no visible symptom.
 */
export function drawStack(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  scene: StackScene,
  scale: Scale,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  const lanes = scene.lanes;
  if (lanes.length === 0) return;

  let maxDensity = 0;
  for (const lane of lanes) {
    for (let i = 0; i < lane.density.length; i++) {
      if (lane.density[i]! > maxDensity) maxDensity = lane.density[i]!;
    }
  }
  if (maxDensity <= 0) return;
  // 0.92 rather than 1.0: a curve that touches the top of its lane reads as clipped even when
  // it is not, and a hairline of air above the tallest peak is what makes the rest look placed.
  const unit = (lanes[0]!.h * 0.92) / maxDensity;

  // Every grid index resolved to a pixel, once. Every lane shares this mapping.
  const size = lanes[0]!.density.length;
  const xs = new Float64Array(size);
  for (let i = 0; i < size; i++) xs[i] = scale.at(gridPoints(i));
  const gatePx = scale.at(scene.gate);
  const selected = scene.selected >= 0 && scene.selected < lanes.length ? lanes[scene.selected]! : null;

  /* ---- The rail: where the ordering stops meaning anything -------------------------- */

  // A vertical hairline joining every pair of rows the model will not separate. Drawn once, as
  // a set of runs, so a chain of thirty rows is one stroke rather than thirty.
  ctx.strokeStyle = palette.hex["dim"];
  ctx.lineWidth = 1;
  const railCentre = Math.round(scene.railX + scene.railW / 2) + 0.5;
  ctx.beginPath();
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]!;
    const mid = Math.round(lane.y + lane.h / 2) + 0.5;
    // A 3px tick at every row, so the rail reads as a scale even where nothing is tied.
    ctx.moveTo(railCentre - 1.5, mid);
    ctx.lineTo(railCentre + 1.5, mid);
    if (i > 0 && !lane.separableFromAbove) {
      const above = lanes[i - 1]!;
      ctx.moveTo(railCentre, Math.round(above.y + above.h / 2) + 0.5);
      ctx.lineTo(railCentre, mid);
    }
  }
  ctx.stroke();

  // The selected player's actual rank range, which is the claim the rail only gestures at.
  if (selected) {
    const lo = lanes[Math.max(0, Math.min(lanes.length - 1, selected.lo))]!;
    const hi = lanes[Math.max(0, Math.min(lanes.length - 1, selected.hi))]!;
    ctx.fillStyle = palette.alpha("accent-text", 0.55);
    ctx.fillRect(railCentre - 2, lo.y + 2, 4, hi.y + hi.h - lo.y - 4);
  }

  /* ---- The lanes -------------------------------------------------------------------- */

  const last = size - 1;
  // The grid index the gate falls on, so the below-gate and at-gate halves are filled as two
  // paths that meet on the line rather than overlapping by a pixel.
  const gateIndex = Math.max(0, Math.min(last, gridIndex(scene.gate)));

  // Deliberately lopsided. The part of a week below twenty points wins nothing, so it is a
  // wash you can see through; the part at or past the gate is the reading, so it is the only
  // saturated ink on the board. Equal weights made a pretty stripe and buried the argument.
  const subFill = palette.alpha("dim", 0.14);
  const spikeFill = palette.alpha("accent", 0.74);
  const curveStroke = palette.hex["dim"];
  const spikeStroke = palette.hex["accent-text"];

  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]!;
    const base = lane.y + lane.h;
    const isSelected = i === scene.selected;

    // The measured span, drawn on the baseline. A hairline from the 10th to the 90th
    // percentile: the one summary a reader of a scale expects to be able to lay a ruler along.
    ctx.strokeStyle = palette.alpha("dim", 0.5);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(scale.at(lane.p10), Math.round(base) + 0.5);
    ctx.lineTo(scale.at(lane.p90), Math.round(base) + 0.5);
    ctx.stroke();

    // Below the gate. Neutral ink: this is the part of the week that does not win anything.
    ctx.fillStyle = subFill;
    tracePath(ctx, lane.density, xs, lane, unit, 0, gateIndex);
    ctx.lineTo(Math.min(gatePx, lane.x + lane.w), base);
    ctx.lineTo(lane.x, base);
    ctx.closePath();
    ctx.fill();

    // At and past the gate. This filled area IS the spike probability: the figure printed in
    // the row beside it is the integral of exactly this region, so a reader who does not
    // believe the number can check it against the ink.
    ctx.fillStyle = spikeFill;
    tracePath(ctx, lane.density, xs, lane, unit, gateIndex, last);
    ctx.lineTo(lane.x + lane.w, base);
    ctx.lineTo(Math.min(gatePx, lane.x + lane.w), base);
    ctx.closePath();
    ctx.fill();

    // The outline. Held to --dim rather than --edge: the curve is the reading, not a divider,
    // and --edge measures 1.42:1 against the page on the palest palette.
    ctx.strokeStyle = isSelected ? palette.hex["fg"] : curveStroke;
    ctx.lineWidth = isSelected ? 1.6 : 1;
    tracePath(ctx, lane.density, xs, lane, unit, 0, last);
    ctx.stroke();

    // The spike half of the outline, again, in the readable sibling of the fill.
    ctx.strokeStyle = spikeStroke;
    ctx.lineWidth = isSelected ? 1.8 : 1.2;
    tracePath(ctx, lane.density, xs, lane, unit, gateIndex, last);
    ctx.stroke();

    // The median, as a notch off the baseline rather than a full-height rule. A full-height
    // rule through every lane turns the board into a grid and the grid wins the eye.
    ctx.strokeStyle = palette.hex["fg"];
    ctx.lineWidth = 1;
    const mid = Math.round(scale.at(lane.p50)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(mid, base + 0.5);
    ctx.lineTo(mid, base - Math.min(7, lane.h * 0.4));
    ctx.stroke();
  }

  /* ---- The tie, drawn ---------------------------------------------------------------- */

  /*
   * The overlap is not asserted anywhere on this page. Select a player and their curve is
   * echoed onto every lane they cannot be separated from, with the shared region - the
   * pointwise minimum of the two densities, which is the integral `SEPARABLE_OVERLAP` is a
   * threshold on - filled solid. The reader is not told these two are the same player. They
   * are shown the part that is identical, and on a pair at 0.94 there is almost nothing left
   * over.
   */
  if (selected) {
    const shared = palette.alpha("accent-2", 0.28);
    const echo = palette.hex["accent-2"];
    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i]!;
      if (i === scene.selected || !scene.tiedTo.has(lane.id)) continue;
      const base = lane.y + lane.h;

      // The shared region. Built as one path over the pointwise minimum, which is the only
      // honest way to draw it: two translucent curves stacked would show their blend, and the
      // blend is a different quantity that happens to look similar.
      ctx.fillStyle = shared;
      ctx.beginPath();
      let started = false;
      for (let k = 0; k <= last; k++) {
        const px = xs[k]!;
        if (px < lane.x - 2 || px > lane.x + lane.w + 2) continue;
        const py = base - Math.min(lane.density[k]!, selected.density[k]!) * unit;
        if (!started) {
          ctx.moveTo(px, base);
          started = true;
        }
        ctx.lineTo(px, py);
      }
      if (started) {
        ctx.lineTo(Math.min(xs[last]!, lane.x + lane.w), base);
        ctx.closePath();
        ctx.fill();
      }

      ctx.strokeStyle = echo;
      ctx.lineWidth = 1;
      tracePath(ctx, selected.density, xs, lane, unit, 0, last);
      ctx.stroke();
    }
  }
}
