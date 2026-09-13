/**
 * The model's own grades.
 *
 * A calibration plot: the chance the board claimed against the share that actually happened,
 * with the line where a claim would be exactly right drawn through it. A bucket below that line
 * is over-confidence, and on this model every bucket above a stated 35 per cent is below it.
 *
 * The dot area is the bucket's sample size, not its radius, because radius exaggerates: a
 * bucket of 1,841 drawn at fourteen times the radius of a bucket of nine looks two hundred
 * times more important, and the eye reads area whatever the code intended.
 *
 * Nobody else in this category publishes this, which is the only reason it is a section rather
 * than a footnote.
 */

import { context2d, el, fill } from "./dom.ts";
import { linear } from "./scales.ts";
import type { Palette } from "./tokens.ts";
import type { ScorecardBucket } from "./ports.ts";

/** The window both axes share. Nothing in four seasons claimed past 60 per cent. */
const AXIS: readonly [number, number] = [0, 0.6];
const PAD = 22;

export function drawScorecard(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  buckets: readonly ScorecardBucket[],
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  const x = linear(AXIS, [PAD, width - PAD / 2]);
  const y = linear(AXIS, [height - PAD, PAD / 2]);

  ctx.strokeStyle = palette.alpha("dim", 0.3);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const g of [0.2, 0.4]) {
    ctx.moveTo(x.at(g), y.at(AXIS[0]));
    ctx.lineTo(x.at(g), y.at(AXIS[1]));
    ctx.moveTo(x.at(AXIS[0]), y.at(g));
    ctx.lineTo(x.at(AXIS[1]), y.at(g));
  }
  ctx.stroke();

  // Perfect calibration. A claim that lands on this line was worth making.
  ctx.strokeStyle = palette.hex["fg"];
  ctx.lineWidth = 1.25;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x.at(AXIS[0]), y.at(AXIS[0]));
  ctx.lineTo(x.at(AXIS[1]), y.at(AXIS[1]));
  ctx.stroke();
  ctx.setLineDash([]);

  const biggest = buckets.reduce((m, b) => Math.max(m, b.n), 1);
  // The path from claim to outcome, so the drift is a shape rather than six unrelated dots.
  ctx.strokeStyle = palette.hex["accent-text"];
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  buckets.forEach((b, i) => {
    const px = x.at(b.predicted);
    const py = y.at(b.realised);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  for (const b of buckets) {
    // Area proportional to n, so the radius is its square root.
    const r = 3 + 9 * Math.sqrt(b.n / biggest);
    ctx.beginPath();
    ctx.arc(x.at(b.predicted), y.at(b.realised), r, 0, Math.PI * 2);
    ctx.fillStyle = palette.alpha("accent", 0.55);
    ctx.fill();
    ctx.strokeStyle = palette.hex["accent-text"];
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

/** The same six buckets as a table, because a dot cannot be read to a decimal place. */
export function renderScorecardTable(host: HTMLElement, buckets: readonly ScorecardBucket[]): void {
  fill(host, [
    el("table", {}, [
      el("caption", {
        text: "Every spike claim the board has made this season, bucketed by the chance it stated, against what actually happened.",
      }),
      el("thead", {}, [
        el("tr", {}, [
          el("th", { scope: "col", text: "claimed" }),
          el("th", { scope: "col", text: "happened" }),
          el("th", { scope: "col", text: "gap" }),
          el("th", { scope: "col", text: "player-weeks" }),
        ]),
      ]),
      el(
        "tbody",
        {},
        buckets.map((b) => {
          const gap = b.realised - b.predicted;
          return el("tr", {}, [
            el("td", { class: "fig", text: `${Math.round(b.predicted * 100)}%` }),
            el("td", { class: "fig", text: `${(b.realised * 100).toFixed(1)}%` }),
            el("td", {
              class: "fig",
              text: `${gap >= 0 ? "+" : "−"}${Math.abs(gap * 100).toFixed(1)}`,
            }),
            el("td", { class: "fig dim", text: b.n.toLocaleString("en-US") }),
          ]);
        }),
      ),
    ]),
  ]);
}

export { context2d };
