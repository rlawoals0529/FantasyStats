/**
 * Boot.
 *
 * The only file that knows where the data comes from. Everything else takes `DataSource` and
 * `SimulatorFactory` from `ports.ts`, so when the pipeline and the simulator land, the two lines
 * marked below change and nothing else does.
 *
 * Stylesheet order matters and is not alphabetical. The vendored layers go first, structure
 * before character, and `app.css` last so that where this page disagrees with base.css - button
 * shape, heading size, the meaning of a section - it wins without a single `!important`.
 */

import "../theme/palettes.css";
import "../theme/base.css";
import "../theme/type.css";
import "../theme/layout-flat.css";
import "../theme/motion.css";
import "../theme/texture.css";
import "./app.css";

import { mountBoard } from "./board.ts";
import { context2d, el, fill, need, prefersReducedMotion } from "./dom.ts";
import { FrameMeter } from "./frame-meter.ts";
import * as fmt from "./format.ts";
import { mountPicker } from "./palette-picker.ts";
import { mountRegression } from "./regression.ts";
import { drawScorecard, renderScorecardTable } from "./scorecard.ts";
import { sizeCanvas } from "./scales.ts";
import { readPalette } from "./tokens.ts";
import { mountWeek } from "./week.ts";
import { isOnGrid } from "./stats.ts";
import type { Wiring } from "./ports.ts";

// ---- The two lines the other slices replace. ----------------------------------------------
import { fixtureBoard, fixtureData, fixtureSimulator } from "./fixtures/generate.ts";
const wiring: Wiring = { data: fixtureData(), simulate: fixtureSimulator(fixtureBoard()) };
// -------------------------------------------------------------------------------------------

const boardMeter = new FrameMeter(120);
const simMeter = new FrameMeter(240);

async function boot(): Promise<void> {
  const root = document.documentElement;
  const week = await wiring.data.load();

  // A producer that missed the shared grid would still draw, just wrongly and subtly: curves
  // squashed toward the left of the scale with their areas intact. Better to say so at boot.
  for (const player of week.players) {
    if (!isOnGrid(player.density)) {
      throw new Error(`spike: ${player.name} arrived off the shared grid, ${player.density.length} samples`);
    }
  }

  const hud = need(document, ".gauge__hud");
  const boardSection = need<HTMLElement>(document, "#board");
  const weekSection = need<HTMLElement>(document, "#week");

  const generated = document.querySelector("[data-generated]");
  if (generated) {
    generated.textContent = `run ${new Date(week.generatedAt).toISOString().slice(0, 16).replace("T", " ")}Z`;
  }

  const board = mountBoard(boardSection, week, (ms) => boardMeter.push(ms));
  const weekPanel = mountWeek(weekSection, week, wiring.simulate, simMeter);
  mountRegression(need<HTMLElement>(document, ".regress"), week);

  /* ---- Scorecard --------------------------------------------------------------------- */

  const gradeCanvas = need<HTMLCanvasElement>(document, ".grade__plot");
  const gradeCtx = context2d(gradeCanvas);
  const gradeNote = need<HTMLElement>(document, "[data-scorecard-note]");
  fill(gradeNote, [el("strong", { text: "Last week: " }), week.scorecardNote]);
  renderScorecardTable(need<HTMLElement>(document, "[data-scorecard-table]"), week.scorecard);

  function paintScorecard(): void {
    const w = Math.round(gradeCanvas.getBoundingClientRect().width) || 280;
    const h = Math.round(Math.min(300, Math.max(190, w)));
    const size = sizeCanvas(gradeCanvas, gradeCtx, w, h, window.devicePixelRatio);
    drawScorecard(gradeCtx, readPalette(root), week.scorecard, size.width, size.height);
  }
  new ResizeObserver(() => paintScorecard()).observe(gradeCanvas);
  paintScorecard();

  /* ---- The instrument's own readout ---------------------------------------------------- */

  /*
   * A bench meter that does not report its own state is asking to be trusted. This one prints
   * how long its last board paint took and the p50 and p95 of the simulator's paints, which is
   * the only honest way to put a frame-time claim on a page: measured here, on this machine,
   * in this palette, rather than quoted from somewhere else.
   */
  function renderHud(): void {
    const paint = boardMeter.stats();
    const sim = weekPanel.frame;
    const cells: [string, string][] = [
      [paint.count ? `${fmt.ms(paint.p50)} / ${fmt.ms(paint.p95)} ms` : "not drawn", "board p50 / p95"],
      [sim.count ? `${fmt.ms(sim.p50)} / ${fmt.ms(sim.p95)} ms` : "not run", "sim p50 / p95"],
      [`${board.size}`, "lanes"],
      [prefersReducedMotion() ? "still" : "animated", "motion"],
    ];
    fill(
      hud,
      cells.map(([value, label]) =>
        el("span", { class: "gauge__cell" }, [el("b", { text: value }), el("span", { text: label })]),
      ),
    );
  }
  renderHud();
  setInterval(renderHud, 500);

  /* ---- Palette ------------------------------------------------------------------------- */

  mountPicker(need<HTMLElement>(document, ".palette"), () => {
    // Every canvas holds colours copied out of the cascade at paint time, so a palette change
    // has to be followed by a re-read and a repaint or the pictures stay in the old palette
    // while everything around them changes. This is the entire reason `readPalette` is not
    // cached anywhere.
    board.repaint();
    weekPanel.repaint();
    paintScorecard();
  });

  /*
   * A read-only window on the measurements, for the browser scripts in `e2e/`.
   *
   * Deliberately one-way: it exposes what the page measured and offers no way to inject a
   * player, a draw or a palette. A test hook that can fabricate data is a route by which the
   * shipped page can show something the pipeline never produced, and this project's one rule
   * makes that the worst possible thing to build in.
   */
  Object.defineProperty(window, "__spike", {
    value: Object.freeze({
      frames: () => ({ board: boardMeter.stats(), sim: weekPanel.frame }),
      lanes: () => board.size,
      reducedMotion: () => prefersReducedMotion(),
    }),
    writable: false,
    configurable: false,
  });
}

boot().catch((error: unknown) => {
  // A page that fails silently is worse than one that fails loudly, and this one is about
  // refusing to show a figure it cannot back.
  const message = error instanceof Error ? error.message : String(error);
  document.body.prepend(el("p", { class: "err", role: "alert", text: `spike could not start: ${message}` }));
  throw error;
});
