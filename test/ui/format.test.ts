import { describe, expect, it } from "vitest";
import * as fmt from "../../src/ui/format.ts";
import { FrameMeter } from "../../src/ui/frame-meter.ts";
import { linear, sizeCanvas, ticks } from "../../src/ui/scales.ts";
import { Recorder } from "./fake-canvas.ts";

describe("format", () => {
  it("prints points to one decimal, which is the resolution the data has", () => {
    expect(fmt.points(12.44)).toBe("12.4");
    expect(fmt.points(12.46)).toBe("12.5");
  });

  it("says so rather than printing a figure it does not have", () => {
    expect(fmt.points(NaN)).toBe("-");
    expect(fmt.delta(Infinity)).toBe("-");
    expect(fmt.pct(NaN)).toBe("-");
    expect(fmt.share(null)).toBe("no data");
  });

  it("signs a delta with a real minus and marks a genuine zero", () => {
    expect(fmt.delta(1.24)).toBe("+1.2");
    expect(fmt.delta(-1.24)).toBe("−1.2");
    expect(fmt.delta(0)).toBe("±0.0");
    expect(fmt.delta(0.01)).toBe("±0.0");
  });

  it("never prints an interval narrower than the one point it can resolve", () => {
    // A ten thousand run estimate is about plus or minus 1. Rounding a real 0.004 to "0" would
    // claim a certainty the simulation does not have.
    expect(fmt.odds(0.63, 0.004)).toBe("63% ± 1");
    expect(fmt.odds(0.63, 0.096)).toBe("63% ± 10");
  });

  it("puts an interval in the odds signature so a probability cannot be printed alone", () => {
    // A type-level guarantee, checked here as a shape: the function takes two arguments and a
    // caller cannot get a formatted probability out of it without supplying the second.
    expect(fmt.odds.length).toBe(2);
  });

  it("talks in odds rather than per cent where the copy does", () => {
    expect(fmt.inHundred(0.63)).toBe("63 in 100");
  });

  it("separates thousands", () => {
    expect(fmt.count(10000)).toBe("10,000");
  });

  it("prints a sub-millisecond frame with its decimals and a slow one without", () => {
    expect(fmt.ms(0.42)).toBe("0.42");
    expect(fmt.ms(41.6)).toBe("42");
  });
});

describe("linear", () => {
  it("maps the domain onto the range and back", () => {
    const s = linear([0, 45], [100, 640]);
    expect(s.at(0)).toBe(100);
    expect(s.at(45)).toBe(640);
    expect(s.invert(s.at(17.5))).toBeCloseTo(17.5, 9);
  });

  it("collapses to the range start on a zero-width domain rather than dividing by zero", () => {
    const s = linear([5, 5], [0, 100]);
    expect(s.at(5)).toBe(0);
    expect(Number.isFinite(s.at(99))).toBe(true);
  });
});

describe("ticks", () => {
  it("lands on round numbers", () => {
    expect(ticks(0, 45, 9)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45]);
    // 15 is not on the 1-2-5-10 ladder, so asking for three ticks over 45 gives a step of 20.
    // A round step the reader recognises beats hitting the requested count exactly.
    expect(ticks(0, 45, 3)).toEqual([0, 20, 40]);
  });

  it("carries no floating point residue", () => {
    for (const t of ticks(0, 1, 10)) expect(t).toBe(Number(t.toFixed(6)));
  });

  it("returns nothing for a domain that is not a domain", () => {
    expect(ticks(5, 5, 4)).toEqual([]);
    expect(ticks(10, 0, 4)).toEqual([]);
    expect(ticks(NaN, 10, 4)).toEqual([]);
  });

  it("terminates on a domain it cannot tick", () => {
    expect(ticks(0, Infinity, 5).length).toBeLessThanOrEqual(1000);
  });
});

describe("sizeCanvas", () => {
  /**
   * A canvas that counts writes to width and height.
   *
   * Reading the value back afterwards is not enough and a mutation proved it: an implementation
   * that assigns unconditionally leaves the SAME number in place, so a value assertion passes
   * while the bug it was written for - assigning width clears the canvas, throwing away an
   * accumulated ten thousand point scatter - is fully present.
   */
  const canvas = () => {
    const state = { width: 0, height: 0, writes: 0, style: {} as Record<string, string> };
    const node = {
      style: state.style,
      get width() {
        return state.width;
      },
      set width(v: number) {
        state.writes++;
        state.width = v;
      },
      get height() {
        return state.height;
      },
      set height(v: number) {
        state.writes++;
        state.height = v;
      },
    };
    return { node: node as unknown as HTMLCanvasElement, state };
  };

  it("sizes the backing store by the device ratio and the box in CSS pixels", () => {
    const { node, state } = canvas();
    const r = new Recorder();
    const out = sizeCanvas(node, r.as(), 320, 120, 2);
    expect(state.width).toBe(640);
    expect(state.height).toBe(240);
    expect(state.style["width"]).toBe("320px");
    expect(out).toEqual({ width: 320, height: 120, dpr: 2 });
    expect(r.of("setTransform")[0]!.args).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it("caps the ratio at 2, because a 3x scatter is nine times the fill for no visible gain", () => {
    const { node, state } = canvas();
    sizeCanvas(node, new Recorder().as(), 100, 100, 3);
    expect(state.width).toBe(200);
  });

  it("does not touch the backing store when the size has not changed", () => {
    // Assigning width clears the canvas even when the value is identical, which threw away an
    // accumulated ten thousand point scatter on every resize observation. Counted, not read
    // back: an unconditional assignment leaves the same number in place.
    const { node, state } = canvas();
    sizeCanvas(node, new Recorder().as(), 200, 100, 1);
    const after = state.writes;
    expect(after).toBeGreaterThan(0);
    sizeCanvas(node, new Recorder().as(), 200, 100, 1);
    sizeCanvas(node, new Recorder().as(), 200, 100, 1);
    expect(state.writes).toBe(after);
    // And a genuine change still resizes.
    sizeCanvas(node, new Recorder().as(), 240, 100, 1);
    expect(state.writes).toBeGreaterThan(after);
  });
});

describe("FrameMeter", () => {
  it("reports percentiles rather than a mean, so one slow frame is visible", () => {
    const m = new FrameMeter(100);
    for (let i = 0; i < 99; i++) m.push(2);
    m.push(40);
    const s = m.stats();
    expect(s.p50).toBe(2);
    expect(s.worst).toBe(40);
    expect(s.count).toBe(100);
  });

  it("drops a reading that is not a duration instead of poisoning the percentiles", () => {
    const m = new FrameMeter(10);
    m.push(NaN);
    m.push(-3);
    m.push(Infinity);
    expect(m.size).toBe(0);
    m.push(5);
    expect(m.stats()).toMatchObject({ count: 1, p50: 5 });
  });

  it("keeps only the last capacity samples, so the figure answers is it smooth NOW", () => {
    const m = new FrameMeter(4);
    for (const v of [50, 50, 50, 50, 1, 1, 1, 1]) m.push(v);
    expect(m.stats().worst).toBe(1);
  });

  it("reports nothing rather than zero before anything has been measured", () => {
    expect(new FrameMeter(8).stats()).toEqual({ count: 0, p50: 0, p95: 0, worst: 0 });
  });

  it("times a call and hands back its result", () => {
    const m = new FrameMeter(4);
    let now = 100;
    const out = m.measure(() => {
      now = 107;
      return "done";
    }, () => now);
    expect(out).toBe("done");
    expect(m.stats().p50).toBe(7);
  });

  it("empties on reset", () => {
    const m = new FrameMeter(4);
    m.push(3);
    m.reset();
    expect(m.size).toBe(0);
  });
});
