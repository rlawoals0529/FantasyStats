/**
 * How a figure is written down.
 *
 * One place, because the page's rule is that no figure appears without its uncertainty and the
 * rule is only enforceable if there is a single function that writes a figure. `odds` takes the
 * interval as a required argument for that reason: there is no call shape that prints a
 * probability on its own.
 */

/** Points, always one decimal. Two is a precision the data does not have. */
export const points = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : "-");

/** A signed points delta, with a real minus sign rather than a hyphen. */
export const delta = (v: number): string => {
  if (!Number.isFinite(v)) return "-";
  const s = Math.abs(v).toFixed(1);
  return v > 0.05 ? `+${s}` : v < -0.05 ? `−${s}` : `±0.0`;
};

/** A probability as whole per cent. The decimal place is noise at n = 10,000. */
export const pct = (p: number): string => (Number.isFinite(p) ? `${Math.round(p * 100)}` : "-");

/** A probability as "63 in 100", which is how the copy talks about odds. */
export const inHundred = (p: number): string => `${pct(p)} in 100`;

/**
 * A probability with its interval, which is the only way this page is allowed to print one.
 * `halfWidth` is the half-width in probability units, so 0.0096 renders as "± 1".
 */
export const odds = (p: number, halfWidth: number): string =>
  `${pct(p)}% ± ${Math.max(1, Math.round(halfWidth * 100))}`;

/** A quantile range, for the readouts beside every ridge. */
export const range = (lo: number, hi: number): string => `${points(lo)} to ${points(hi)}`;

/** A share as per cent, or an em-less dash when the feed had nothing. */
export const share = (v: number | null): string => (v == null ? "no data" : `${Math.round(v * 100)}%`);

/** Milliseconds, for the frame readout. Sub-millisecond frames are the normal case. */
export const ms = (v: number): string => (v >= 10 ? v.toFixed(0) : v.toFixed(2));

/** Thousands separated, for run counts. */
export const count = (v: number): string => v.toLocaleString("en-US");
