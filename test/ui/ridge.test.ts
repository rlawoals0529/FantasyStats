/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { drawStack, type Lane, type StackScene } from "../../src/ui/ridge.ts";
import { linear } from "../../src/ui/scales.ts";
import { readPalette, type Palette } from "../../src/ui/tokens.ts";
import { GRID_SIZE } from "../../src/ui/ports.ts";
import { SPIKE_POINTS } from "../../src/shared/player.ts";
import { lognormalDensity } from "../../src/ui/fixtures/generate.ts";
import { installFakeCanvas, Recorder, TWILIGHT_COMET } from "./fake-canvas.ts";

const WIDTH = 800;
const HEIGHT = 200;
const LANE_H = 40;

let palette: Palette;

beforeEach(() => {
  installFakeCanvas();
  document.head.innerHTML = `<style>${TWILIGHT_COMET}</style>`;
  document.documentElement.setAttribute("data-theme", "twilight-comet");
  palette = readPalette(document.documentElement);
});

const lane = (id: string, index: number, mean: number, sd: number): Lane => ({
  id,
  x: 100,
  y: index * LANE_H,
  w: WIDTH - 140,
  h: LANE_H - 6,
  density: lognormalDensity(mean, sd),
  p10: mean - sd,
  p50: mean,
  p90: mean + sd,
  separableFromAbove: true,
  lo: index,
  hi: index,
});

const scene = (lanes: Lane[], over: Partial<StackScene> = {}): StackScene => ({
  lanes,
  selected: -1,
  tiedTo: new Set<string>(),
  gate: SPIKE_POINTS,
  railX: 0,
  railW: 16,
  ...over,
});

function draw(s: StackScene): Recorder {
  const r = new Recorder({ width: WIDTH, height: HEIGHT });
  drawStack(r.as(), palette, s, linear([0, 45], [100, WIDTH - 40]), WIDTH, HEIGHT);
  return r;
}

describe("drawStack", () => {
  it("paints nothing into the canvas as text", () => {
    // The whole accessibility and contrast story rests on this: every figure a reader sees is a
    // DOM node over the canvas, never a glyph inside it.
    const r = draw(scene([lane("a", 0, 16, 8), lane("b", 1, 11, 7)]));
    expect(r.of("fillText")).toEqual([]);
    expect(r.of("strokeText")).toEqual([]);
  });

  it("fills the area past the gate in the accent and nothing else in it", () => {
    const r = draw(scene([lane("a", 0, 16, 8)]));
    const accent = palette.alpha("accent", 0.74);
    expect(r.fillsUsed()).toContain(accent);
    // And the accent appears exactly once per lane: one fill, for the spike region.
    const accentFills = r.calls.filter((c) => c.op === "fill" && c.fill === accent);
    expect(accentFills).toHaveLength(1);
  });

  it("scales every lane against one shared peak, so equal probability is equal area", () => {
    // A tight distribution and a wide one, both integrating to 1. Under one shared scale the
    // tight one must reach higher off its baseline than the wide one does off its own.
    const tight = lane("tight", 0, 8, 2.9);
    const wide = lane("wide", 1, 16, 8.4);
    const r = draw(scene([tight, wide]));
    const tops = (l: Lane) => {
      const base = l.y + l.h;
      const ys = r
        .of("lineTo")
        .map((c) => c.args[1] as number)
        .filter((y) => y <= base && y > l.y - 1);
      return base - Math.min(...ys);
    };
    expect(tops(tight)).toBeGreaterThan(tops(wide) * 1.4);
  });

  it("clears the canvas before drawing, so a repaint cannot stack on the last one", () => {
    const r = draw(scene([lane("a", 0, 16, 8)]));
    expect(r.calls[0]!.op).toBe("clearRect");
  });

  it("draws the shared area only on the lanes the selection is actually tied to", () => {
    const lanes = [lane("a", 0, 16, 8), lane("b", 1, 15.5, 8), lane("c", 2, 4, 3)];
    const shared = palette.alpha("accent-2", 0.28);
    const withTie = draw(scene(lanes, { selected: 0, tiedTo: new Set(["b"]) }));
    const sharedFills = withTie.calls.filter((c) => c.op === "fill" && c.fill === shared);
    expect(sharedFills).toHaveLength(1);

    const withoutTie = draw(scene(lanes, { selected: 0, tiedTo: new Set<string>() }));
    expect(withoutTie.calls.filter((c) => c.op === "fill" && c.fill === shared)).toHaveLength(0);
  });

  it("draws the rank-range bar only when something is selected", () => {
    const lanes = [lane("a", 0, 16, 8), lane("b", 1, 15, 8), lane("c", 2, 14, 8)];
    const bar = palette.alpha("accent-text", 0.55);
    const none = draw(scene(lanes));
    expect(none.calls.filter((c) => c.op === "fillRect" && c.fill === bar)).toHaveLength(0);

    const picked = draw(
      scene([{ ...lanes[0]!, lo: 0, hi: 2 }, lanes[1]!, lanes[2]!], { selected: 0 }),
    );
    const bars = picked.calls.filter((c) => c.op === "fillRect" && c.fill === bar);
    expect(bars).toHaveLength(1);
    // Spanning all three lanes, which is what "could rank anywhere from 1 to 3" means.
    expect(bars[0]!.args[3] as number).toBeGreaterThan(2 * LANE_H);
  });

  it("survives an empty board and a zero density without throwing", () => {
    expect(() => draw(scene([]))).not.toThrow();
    const dead = { ...lane("a", 0, 16, 8), density: new Float64Array(GRID_SIZE) };
    expect(() => draw(scene([dead]))).not.toThrow();
  });

  it("uses no colour it did not read off the palette", () => {
    const r = draw(scene([lane("a", 0, 16, 8), lane("b", 1, 15, 8)], { selected: 0, tiedTo: new Set(["b"]) }));
    const known = new Set<string>();
    for (const token of ["bg", "panel", "accent", "accent-2", "fg", "dim", "accent-text"] as const) {
      known.add(palette.hex[token]);
      for (let a = 0; a <= 100; a++) known.add(palette.alpha(token, a / 100));
    }
    for (const used of [...r.fillsUsed(), ...r.strokesUsed()]) {
      expect(known.has(used), `${used} is not a palette colour`).toBe(true);
    }
  });
});
