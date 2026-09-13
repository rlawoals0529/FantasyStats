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
import { mountRail } from "./rail.ts";
import { mountRegression } from "./regression.ts";
import { drawScorecard, renderScorecardTable } from "./scorecard.ts";
import { sizeCanvas } from "./scales.ts";
import { readPalette } from "./tokens.ts";
import { mountWeek } from "./week.ts";
import { isOnGrid } from "./stats.ts";
import type { Wiring } from "./ports.ts";

// ---- The two lines the other slices replace. ----------------------------------------------
import { fixtureBoard, fixtureData, fixtureSimulator } from "./fixtures/generate.ts";
import { liveData } from "./live.ts";

// The real board, with the fixture as a named fallback rather than the default. See live.ts for
// why a silent fallback would be the worst outcome available here.
const live = liveData("data/board.json", () => fixtureBoard());
// The simulator is built from the board that was actually loaded, not from the fixture.
//
// It was bound to fixtureBoard() here while the data came from the live board, and
// fixtureSimulator drops ids it does not recognise rather than throwing, so both lineups came
// back empty and every matchup reported 0 per cent plus or minus 1. Silent, plausible, and
// wrong: the exact failure this project is organised against. It has to be built after load()
// resolves, because the ids it needs are the ones in the board.
const wiring: Pick<Wiring, "data"> = { data: live };
// -------------------------------------------------------------------------------------------

const boardMeter = new FrameMeter(120);
const simMeter = new FrameMeter(240);

async function boot(): Promise<void> {
  const root = document.documentElement;
  const week = await wiring.data.load();
  // Built from the board that was actually loaded. See the note above the wiring.
  const simulate = fixtureSimulator(week);

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

  /*
   * THE PALETTE IS APPLIED BEFORE ANYTHING PAINTS, and the order is the whole point.
   *
   * Mounting the picker sets `data-theme` on the root, and until that attribute exists none of
   * the palettes in `palettes.css` apply, so every `--token` resolves to the empty string.
   * Built the other way round, every canvas read its colours out of an empty cascade, fell back
   * to grey, and painted a complete and entirely plausible monochrome page with no error
   * anywhere. So the picker goes first and its repainters register afterwards.
   */
  const repainters: (() => void)[] = [];
  mountPicker(need<HTMLElement>(document, ".palette"), () => {
    // Every canvas holds colours copied out of the cascade at paint time, so a palette change
    // has to be followed by a re-read and a repaint or the pictures stay in the old palette
    // while everything around them changes. This is why `readPalette` is not cached anywhere.
    for (const repaint of repainters) repaint();
  });

  const applied = readPalette(root);
  if (applied.missing.length > 0) {
    throw new Error(`spike: the cascade carried no ${applied.missing.join(", ")}`);
  }

  const generated = document.querySelector("[data-generated]");
  if (generated) {
    generated.textContent = `run ${new Date(week.generatedAt).toISOString().slice(0, 16).replace("T", " ")}Z`;
  }

  /*
   * The rail goes up before anything below it is laid out.
   *
   * It publishes `--rail-h`, and the sheet's top padding, the sticky ruler and every scroll
   * margin on the board are expressed against that value. Mounted after the board, the first
   * layout would use the stylesheet's fallback and the ruler would spend one frame underneath
   * the rail on any width where the rail wraps.
   */
  const rail = mountRail(need<HTMLElement>(document, ".rail"));
  rail.set("week", { value: String(week.week), unit: `of ${week.season}` });
  rail.set("sim", { value: "not run", unit: `${fmt.count(10000)} queued` });

  const board = mountBoard(
    boardSection,
    week,
    (ms) => boardMeter.push(ms),
    (selection) => {
      if (!selection) {
        rail.set("sel", { value: "none", unit: "on this filter" });
        return;
      }
      rail.set("sel", {
        who: selection.player.name,
        value: fmt.pct(selection.player.outlook.spike),
        unit: `in 100, rank ${selection.rank} of ${selection.of}`,
      });
    },
  );
  // The heading names the week the board is actually for. It was a constant from the fixture
  // era and read "Week 7" over a week 18 board, which is the same class of error as the bye:
  // the page stating something it had not been told.
  const title = document.getElementById("board-title");
  if (title) title.textContent = "Week " + week.week + ", as shapes";
  const src = (wiring.data as { lastResult?: () => { live: boolean; note: string } | null }).lastResult?.();
  const note = document.getElementById("board-source");
  if (note && src) {
    note.textContent = src.note;
    note.dataset["live"] = String(src.live);
  }

  const weekPanel = mountWeek(weekSection, week, simulate, simMeter, (est, done) => {
    // While the run is still landing this counts up, which is the panel's whole argument stated
    // in the chrome: the odds are not a fact, they are an estimate that is still arriving.
    rail.set("sim", {
      value: fmt.odds(est.p, est.halfWidth),
      unit: done ? `over ${fmt.count(est.drawn)}` : `at ${fmt.count(est.drawn)}`,
    });
  });
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

  repainters.push(() => board.repaint(), () => weekPanel.repaint(), paintScorecard);

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
