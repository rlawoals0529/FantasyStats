/**
 * How long a frame actually took, kept honestly.
 *
 * A mean frame time is the figure that hides the problem: one 40ms frame inside sixty 2ms ones
 * averages to 2.6 and reads as fine, while what the reader saw was a stutter. So this keeps the
 * samples and reports percentiles, and the page prints p95 beside p50 rather than one number.
 *
 * The ring is fixed at 240 samples, four seconds at 60Hz, because the question is "is it smooth
 * now" and a figure that includes the first frame after a layout change answers a different one.
 */

export type FrameStats = {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly worst: number;
};

export class FrameMeter {
  readonly capacity: number;
  #samples: Float64Array;
  #next = 0;
  #filled = 0;

  constructor(capacity = 240) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.#samples = new Float64Array(this.capacity);
  }

  /** Record one frame's draw time in milliseconds. Negative and NaN are dropped, not stored. */
  push(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.#samples[this.#next] = ms;
    this.#next = (this.#next + 1) % this.capacity;
    if (this.#filled < this.capacity) this.#filled++;
  }

  get size(): number {
    return this.#filled;
  }

  /** Time one call and record it. Returns whatever the call returned. */
  measure<T>(fn: () => T, now: () => number = () => performance.now()): T {
    const t0 = now();
    const out = fn();
    this.push(now() - t0);
    return out;
  }

  stats(): FrameStats {
    if (this.#filled === 0) return { count: 0, p50: 0, p95: 0, worst: 0 };
    const live = Array.from(this.#samples.subarray(0, this.#filled)).sort((a, b) => a - b);
    const at = (q: number) => live[Math.min(live.length - 1, Math.floor(q * (live.length - 1)))]!;
    return { count: this.#filled, p50: at(0.5), p95: at(0.95), worst: live[live.length - 1]! };
  }

  reset(): void {
    this.#next = 0;
    this.#filled = 0;
    this.#samples = new Float64Array(this.capacity);
  }
}
