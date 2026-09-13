/**
 * A 2D context that records instead of painting.
 *
 * The point of this is that a canvas renderer is otherwise untestable, and "untestable" in
 * practice means "asserted by looking at it once". Everything the board claims - that the area
 * past the gate is filled in the accent, that the shared region of a tie is drawn only on the
 * lanes that are actually tied, that no text is ever painted into the canvas - is a statement
 * about the call sequence, and a recorder turns each of them into a test that can fail.
 *
 * jsdom returns null from `getContext`, so this doubles as the thing that lets the board mount
 * in a unit test at all.
 */

export type Call = { op: string; args: unknown[]; fill: string; stroke: string; lineWidth: number };

export class Recorder {
  readonly calls: Call[] = [];
  fillStyle: string | CanvasGradient | CanvasPattern = "#000000";
  strokeStyle: string | CanvasGradient | CanvasPattern = "#000000";
  lineWidth = 1;
  canvas: { width: number; height: number };

  constructor(canvas: { width: number; height: number } = { width: 300, height: 150 }) {
    this.canvas = canvas;
    const ops = [
      "clearRect",
      "beginPath",
      "closePath",
      "moveTo",
      "lineTo",
      "arc",
      "fill",
      "stroke",
      "fillRect",
      "strokeRect",
      "setTransform",
      "setLineDash",
      "drawImage",
      "save",
      "restore",
      "fillText",
      "strokeText",
      "translate",
      "scale",
      "rotate",
      "clip",
      "rect",
    ];
    for (const op of ops) {
      (this as unknown as Record<string, unknown>)[op] = (...args: unknown[]) => {
        this.calls.push({
          op,
          args,
          fill: String(this.fillStyle),
          stroke: String(this.strokeStyle),
          lineWidth: this.lineWidth,
        });
      };
    }
  }

  /** Every call of one kind, in order. */
  of(op: string): Call[] {
    return this.calls.filter((c) => c.op === op);
  }

  /** Every distinct fill colour actually used by a `fill` or `fillRect`. */
  fillsUsed(): string[] {
    return [...new Set(this.calls.filter((c) => c.op === "fill" || c.op === "fillRect").map((c) => c.fill))];
  }

  /** Every distinct stroke colour actually used by a `stroke`. */
  strokesUsed(): string[] {
    return [...new Set(this.of("stroke").map((c) => c.stroke))];
  }

  reset(): void {
    this.calls.length = 0;
  }

  as(): CanvasRenderingContext2D {
    return this as unknown as CanvasRenderingContext2D;
  }
}

/**
 * Make every canvas in the document hand back a recorder, and give `getComputedStyle` a real
 * palette to read.
 *
 * jsdom resolves a custom property only if a stylesheet in the document sets it, and this suite
 * does not load `palettes.css`. Rather than stub `getComputedStyle`, which would also fake the
 * thing the palette code is being tested for, the caller injects a real `<style>` and jsdom's
 * own cascade resolves it.
 */
export function installFakeCanvas(): { recorders: Recorder[] } {
  const recorders: Recorder[] = [];
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    const recorder = new Recorder(this);
    recorders.push(recorder);
    return recorder.as();
    // Through unknown: the real signature is an overload set covering webgl and bitmaprenderer
    // too, and a 2D-only stub does not overlap it enough for a direct assertion.
  } as unknown as HTMLCanvasElement["getContext"];
  return { recorders };
}

/**
 * The browser APIs jsdom does not ship, as no-ops.
 *
 * No-ops rather than working fakes, and that is the honest shape. jsdom reports every element
 * as zero by zero, so a `ResizeObserver` can never have anything true to report and one that
 * fired would be inventing a signal; `scrollIntoView` has nothing to scroll. What this suite
 * covers is the behaviour that follows from the DOM. The layout arithmetic is measured in the
 * browser scripts under `e2e/`, where the boxes are real.
 */
export function installJsdomGaps(): void {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}

/** The default palette's tokens, as a stylesheet jsdom can resolve. Values from palettes.css. */
export const TWILIGHT_COMET = `
:root, [data-theme="twilight-comet"] {
  --bg: #0d0d15;
  --panel: #171520;
  --raised: #201f2c;
  --accent: #8b7cf6;
  --accent-2: #4fd8c4;
  --fg: #eef1ff;
  --dim: #8087a3;
  --edge: #4b5170;
  --ok: #4fd8c4;
  --warn: #f5b878;
  --err: #ff5d73;
  --caution: #f5b878;
  --accent-text: #8b7cf6;
  --on-accent: #0d0d15;
  --edge-strong: #565d80;
  --radius: 12px;
}`;
