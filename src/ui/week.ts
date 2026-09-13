/**
 * The week simulator.
 *
 * Ten thousand Sundays, drawn on a schedule that is exponential rather than linear. A linear
 * ramp spends nine tenths of the animation adding draws that change nothing, because the
 * estimate is already settled by two thousand; the interesting part, where a hundred draws
 * cannot tell you anything and a thousand nearly can, goes past in the first two frames. So the
 * sample count advances at a constant rate on a LOG scale, which is the same axis the interval
 * plot is drawn on, and the collapse happens at an even pace across the whole run.
 *
 * The reduced-motion page is not this with the clock removed. It draws all ten thousand at once
 * and then adds the exhibit the animation cannot give you: four finished clouds at 100, 1,000,
 * 5,000 and 10,000 draws, side by side with their intervals. Same argument, laid out in space,
 * and you can look back and forth instead of having to remember.
 */

import { context2d, el, fill, need, prefersReducedMotion } from "./dom.ts";
import * as fmt from "./format.ts";
import {
  CloudPainter,
  cloudDomain,
  cloudScales,
  drawInterval,
  drawMargin,
  drawStill,
  marginHalfWidth,
  newTrace,
  pushTrace,
  type Trace,
} from "./matchup.ts";
import { sizeCanvas } from "./scales.ts";
import { estimate, type Estimate } from "./stats.ts";
import { readPalette, type Palette } from "./tokens.ts";
import type { MatchupSimulator, SimulatorFactory, WeekBoard } from "./ports.ts";

const RUNS = 10000;
/** Fixed, so the picture is the same on every reload and two people can talk about it. */
const SEED = 0x5b1ce;
const SLOTS = 5;
/** Sample sizes the still composition exhibits. Geometric, so each cell is a real step. */
const LADDER = [100, 1000, 5000, RUNS] as const;

type Plot = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  value: HTMLElement;
  height: number;
};

export type Week = {
  repaint(): void;
  /** p95 draw time of the last run, in milliseconds. Zero before the first run. */
  readonly frame: { p50: number; p95: number; worst: number; count: number };
};

export function mountWeek(
  root: HTMLElement,
  board: WeekBoard,
  simulate: SimulatorFactory,
  meter: { push(ms: number): void; stats(): { p50: number; p95: number; worst: number; count: number }; reset(): void },
): Week {
  const lineupHost = need(root, ".lineups");
  const runHost = need(root, ".sim__run");
  const panelHost = need(root, ".sim__panels");
  const verdict = need(root, ".verdict");

  let palette: Palette = readPalette(root);
  const byId = new Map(board.players.map((p) => [p.outlook.playerId, p]));

  // Two plausible lineups rather than two random ones: the first five and the next five of the
  // board, so the default matchup is close enough that the interval genuinely matters. A
  // lopsided default would resolve in four hundred draws and the whole point would be missed.
  const ordered = [...board.players].sort((a, b) => b.outlook.p50 - a.outlook.p50);
  const mine = ordered.slice(0, SLOTS).map((p) => p.outlook.playerId);
  const theirs = ordered.slice(SLOTS, SLOTS * 2).map((p) => p.outlook.playerId);

  /* ---- Lineups ------------------------------------------------------------------------ */

  const options = (selectedId: string) =>
    ordered.map((p) =>
      el("option", {
        value: p.outlook.playerId,
        selected: p.outlook.playerId === selectedId,
        text: `${p.name} · ${p.position} · ${fmt.points(p.outlook.p50)} med`,
      }),
    );

  const totalOf = (ids: readonly string[]) =>
    ids.reduce((sum, id) => sum + (byId.get(id)?.outlook.p50 ?? 0), 0);

  function renderLineups(): void {
    const side = (which: "mine" | "theirs", ids: string[], title: string) =>
      el("div", { class: `lineup ${which}` }, [
        el("h3", { text: title }),
        el("span", {
          class: "lineup__total",
          text: `${fmt.points(totalOf(ids))} median total`,
        }),
        ...ids.map((id, slot) =>
          el("label", { class: "slot" }, [
            el("span", { class: "sr-only", text: `${title}, slot ${slot + 1}` }),
            el("select", { "data-side": which, "data-slot": String(slot) }, options(id)),
          ]),
        ),
      ]);

    fill(lineupHost, [side("mine", mine, "your lineup"), side("theirs", theirs, "their lineup")]);
  }

  lineupHost.addEventListener("change", (event) => {
    const select = event.target as HTMLSelectElement;
    const side = select.dataset["side"];
    const slot = Number(select.dataset["slot"]);
    if (side !== "mine" && side !== "theirs") return;
    (side === "mine" ? mine : theirs)[slot] = select.value;
    // Only the totals move, so the selects are left alone. Rebuilding them here would reset
    // the focused control mid-keyboard-selection, which is the classic way a form becomes
    // unusable with the keyboard while looking fine with a mouse.
    for (const [which, ids] of [["mine", mine], ["theirs", theirs]] as const) {
      const label = lineupHost.querySelector(`.lineup.${which} .lineup__total`);
      if (label) label.textContent = `${fmt.points(totalOf(ids))} median total`;
    }
    run();
  });

  /* ---- Controls ----------------------------------------------------------------------- */

  const runButton = el("button", { type: "button", class: "primary", text: `run ${fmt.count(RUNS)}` });
  const runNote = el("span", { class: "label", text: "or change any slot" });
  fill(runHost, [runButton, runNote]);
  runButton.addEventListener("click", () => run());

  /* ---- Plots -------------------------------------------------------------------------- */

  const plot = (key: string, title: string, axis: readonly string[], height: number): Plot => {
    const canvas = el("canvas", { "aria-hidden": "true" });
    const value = el("span", { class: "plot__val" });
    panelHost.appendChild(
      el("div", { class: "plot", "data-plot": key }, [
        el("div", { class: "plot__head" }, [el("span", { class: "label", text: title }), value]),
        canvas,
        el("div", { class: "plot__axis" }, axis.map((a) => el("span", { text: a }))),
      ]),
    );
    return { canvas, ctx: context2d(canvas), value, height };
  };

  fill(panelHost, []);
  const cloudPlot = plot("cloud", "every matchup, yours across and theirs up", [], 0);
  const marginPlot = plot("margin", "the margin, yours minus theirs", [], 132);
  const intervalPlot = plot(
    "interval",
    "the estimate, against how many runs it has seen",
    ["10 runs", "dashed line is a coin flip", `${fmt.count(RUNS)} runs`],
    128,
  );

  const painter = new CloudPainter();
  let sim: MatchupSimulator | null = null;
  let trace: Trace = newTrace();
  let domain: [number, number] = [0, 200];
  let half = 40;
  let raf = 0;
  let startedAt = 0;
  let ladderHost: HTMLElement | null = null;

  const cloudHeight = () => {
    const w = cloudPlot.canvas.getBoundingClientRect().width || 320;
    // Square where there is room. A scatter read against its own diagonal stops meaning what it
    // says the moment the axes disagree about what a point is worth: the line is still the
    // boundary, but "ten points clear" stops being the same distance across as it is up.
    return Math.round(Math.max(230, Math.min(w, 440)));
  };

  /* ---- The run ------------------------------------------------------------------------ */

  function run(): void {
    cancelAnimationFrame(raf);
    meter.reset();
    trace = newTrace();
    /*
     * A throwaway pilot fixes the axes before the real run starts, and it is a SEPARATE
     * simulator on the same seed rather than the first four hundred draws of the real one.
     *
     * Rescaling the scatter mid-run is not an option: every dot already on the accumulation
     * canvas was projected through the old scales and there is no way to re-project it. But
     * taking the pilot out of the real simulator cost the whole exhibit. The interval plot's
     * first reading was then at n = 400, which on a log axis running to 10,000 is two thirds
     * of the way across, so the band arrived already narrow and the collapse - the one thing
     * the plot is for - happened before the first frame. Same seed means the pilot's four
     * hundred draws ARE the real run's first four hundred, so the axes are exact either way.
     */
    const pilot = simulate({ mine, theirs, runs: 400, seed: SEED });
    pilot.draw(400);
    domain = cloudDomain(pilot.mine, pilot.theirs, pilot.drawn);
    half = marginHalfWidth(pilot.mine, pilot.theirs, pilot.drawn);

    sim = simulate({ mine, theirs, runs: RUNS, seed: SEED });

    resizeCanvases();
    if (ladderHost) {
      ladderHost.remove();
      ladderHost = null;
    }

    if (prefersReducedMotion()) {
      while (sim.draw(2000) > 0) {
        /* all ten thousand at once */
      }
      buildTraceFromScratch(sim);
      paint(sim, true);
      buildLadder(sim);
      return;
    }

    startedAt = performance.now();
    raf = requestAnimationFrame(step);
  }

  /**
   * One frame: draw up to the sample count the exponential schedule says we should be at, paint,
   * and measure. The measurement is the paint only, not the simulation: what the reported frame
   * time is meant to answer is whether the rendering is keeping up.
   */
  function step(now: number): void {
    if (!sim) return;
    const elapsed = Math.min(1, (now - startedAt) / 2200);
    const target = Math.round(Math.pow(10, 1 + elapsed * (Math.log10(RUNS) - 1)));
    sim.draw(Math.max(0, Math.min(RUNS, target) - sim.drawn));

    const t0 = performance.now();
    paint(sim, false);
    meter.push(performance.now() - t0);

    if (sim.drawn < RUNS) raf = requestAnimationFrame(step);
    else paint(sim, true);
  }

  function paint(current: MatchupSimulator, done: boolean): void {
    const est = estimate(current.mine, current.theirs, current.drawn);
    pushTrace(trace, est);

    const w = Math.round(cloudPlot.canvas.getBoundingClientRect().width) || 320;
    const h = cloudHeight();
    const { x, y } = cloudScales(w, h, domain);
    painter.add(current.mine, current.theirs, current.drawn, palette, x, y);
    painter.blit(cloudPlot.ctx, palette, x, y);

    const mw = Math.round(marginPlot.canvas.getBoundingClientRect().width) || 320;
    drawMargin(marginPlot.ctx, palette, current.mine, current.theirs, current.drawn, half, mw, marginPlot.height);

    const iw = Math.round(intervalPlot.canvas.getBoundingClientRect().width) || 320;
    drawInterval(intervalPlot.ctx, palette, trace, RUNS, iw, intervalPlot.height);

    cloudPlot.value.textContent = `${fmt.count(current.drawn)} of ${fmt.count(RUNS)}`;
    marginPlot.value.textContent = `${fmt.points(medianMargin(current))} median, ${fmt.pct(est.p)}% above zero`;
    intervalPlot.value.textContent = fmt.odds(est.p, est.halfWidth);

    renderVerdict(est, done);
  }

  /**
   * The median margin, off a capped prefix.
   *
   * Capped at four thousand because this sorts, and a sort of ten thousand doubles every frame
   * is the one thing in this loop that would show up in the frame time. The median of four
   * thousand draws and of ten thousand agree to well inside a tenth of a point, which is the
   * resolution the figure is printed at.
   */
  const medianMargin = (current: MatchupSimulator): number => {
    const n = Math.min(current.drawn, 4000);
    if (n === 0) return 0;
    const sample = new Float64Array(n);
    for (let i = 0; i < n; i++) sample[i] = current.mine[i]! - current.theirs[i]!;
    sample.sort();
    return sample[n >> 1]!;
  };

  /* ---- The verdict -------------------------------------------------------------------- */

  function renderVerdict(est: Estimate, done: boolean): void {
    const lo = est.p - est.halfWidth;
    const hi = est.p + est.halfWidth;
    const called = lo > 0.5 || hi < 0.5;
    fill(verdict, [
      el("b", {}, [fmt.pct(est.p), el("i", { text: `in 100, give or take ${Math.max(1, Math.round(est.halfWidth * 100))}` })]),
      el("p", {
        text: called
          ? `Called at ${fmt.count(est.drawn)} runs: the interval clears a coin flip. The ${fmt.pct(1 - est.p - est.level)} in 100 where it does not go your way are the weeks one of theirs goes for thirty, and nothing in four seasons of data says which week that is.`
          : `Not called. At ${fmt.count(est.drawn)} runs the interval still contains fifty, so the honest answer is a coin flip${done ? ", and more runs will not move it. What is uncertain here is the players, not the simulation." : "."}`,
      }),
      el("p", {
        class: "label",
        text: `${fmt.count(est.drawn)} runs · ${fmt.pct(est.level)} in 100 finish exactly level · seed fixed, so this picture is the same on every reload`,
      }),
    ]);
  }

  /* ---- The still composition ----------------------------------------------------------- */

  /** The same estimates the animation would have produced, computed directly. */
  function buildTraceFromScratch(current: MatchupSimulator): void {
    trace = newTrace();
    for (let n = 10; n < RUNS; n = Math.max(n + 1, Math.round(n * 1.06))) {
      pushTrace(trace, estimate(current.mine, current.theirs, n));
    }
    pushTrace(trace, estimate(current.mine, current.theirs, RUNS));
  }

  function buildLadder(current: MatchupSimulator): void {
    const cells = LADDER.map((n) => {
      const canvas = el("canvas", { "aria-hidden": "true" });
      const est = estimate(current.mine, current.theirs, n);
      return {
        n,
        canvas,
        node: el("div", { class: "ladder__cell" }, [
          canvas,
          el("span", { class: "ladder__n", text: `${fmt.count(n)} runs` }),
          el("span", { class: "ladder__p", text: fmt.odds(est.p, est.halfWidth) }),
        ]),
      };
    });
    ladderHost = el("div", { class: "ladder" }, cells.map((c) => c.node));
    panelHost.appendChild(
      el("div", { class: "plot" }, [
        el("div", { class: "plot__head" }, [
          el("span", { class: "label", text: "the same matchup at four sample sizes" }),
          el("span", { class: "plot__val", text: "each cloud is complete, not a frame of one" }),
        ]),
        ladderHost,
      ]),
    );
    for (const cell of cells) {
      const box = cell.canvas.getBoundingClientRect();
      const w = Math.max(60, Math.round(box.width) || 120);
      const ctx = context2d(cell.canvas);
      sizeCanvas(cell.canvas, ctx, w, w, window.devicePixelRatio);
      drawStill(ctx, palette, current.mine, current.theirs, cell.n, domain, w, w);
    }
  }

  /* ---- Sizing ------------------------------------------------------------------------- */

  function resizeCanvases(): void {
    const cw = Math.round(cloudPlot.canvas.getBoundingClientRect().width) || 320;
    const ch = cloudHeight();
    sizeCanvas(cloudPlot.canvas, cloudPlot.ctx, cw, ch, window.devicePixelRatio);
    painter.reset(cw, ch, window.devicePixelRatio);

    for (const p of [marginPlot, intervalPlot]) {
      const w = Math.round(p.canvas.getBoundingClientRect().width) || 320;
      sizeCanvas(p.canvas, p.ctx, w, p.height, window.devicePixelRatio);
    }
  }

  const observer = new ResizeObserver(() => {
    if (!sim) return;
    // A resize invalidates the accumulated cloud, because every dot on it was projected through
    // the old scales. Repainting from the draws already taken is exact and costs one pass.
    resizeCanvases();
    paint(sim, sim.drawn >= RUNS);
  });
  observer.observe(panelHost);

  if (typeof matchMedia === "function") {
    matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", () => run());
  }

  renderLineups();
  run();

  return {
    repaint() {
      palette = readPalette(root);
      if (sim) {
        resizeCanvases();
        paint(sim, sim.drawn >= RUNS);
        if (prefersReducedMotion()) {
          if (ladderHost) {
            ladderHost.parentElement?.remove();
            ladderHost = null;
          }
          buildLadder(sim);
        }
      }
    },
    get frame() {
      return meter.stats();
    },
  };
}
