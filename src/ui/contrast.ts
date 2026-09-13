/**
 * The colour pairings this interface puts on screen, and the arithmetic to grade them.
 *
 * A source module rather than a block of test fixtures, because two different things need it
 * and they must not drift: `test/ui/contrast.test.ts` fails the build when a pairing breaches
 * its floor, and `e2e/contrast-sweep.mjs` prints the worst reading it found so a green run says
 * how much room it had rather than merely that it passed.
 *
 * This half and the browser sweep answer different questions and neither replaces the other.
 * This one says the pairings the stylesheet was written against are sound, in milliseconds,
 * with no browser. The sweep says those are the pairings that actually ended up on screen,
 * which no amount of reading the token file can establish.
 *
 * CONTRAST IS V-SHAPED in the other colour's luminance, so the worst case sits at a crossing
 * point and not at either extreme. Every pairing is checked against all fifteen palettes for
 * that reason; reasoning from the darkest and the lightest would miss it.
 */

export const AA_TEXT = 4.5;
export const AA_BOUNDARY = 3;

export type Rgb = readonly [number, number, number];
export type Palette = { readonly id: string; readonly tokens: Readonly<Record<string, Rgb>> };

/** What is painted, on what, and what it is, so a failure names an element and not a variable. */
export type Pairing = { readonly fg: string; readonly bg: string; readonly what: string };

/** Held to 4.5. Everything a reader reads. */
export const TEXT_PAIRINGS: readonly Pairing[] = [
  { fg: "fg", bg: "bg", what: "body copy and every player name" },
  { fg: "fg", bg: "panel", what: "a name on a selected or hovered row" },
  { fg: "dim", bg: "bg", what: "every label, tick, caption and meta line" },
  { fg: "dim", bg: "panel", what: "the frame readout and a dim cell on a selected row" },
  { fg: "accent-text", bg: "bg", what: "the wordmark, the gate label, the headline figure" },
  { fg: "accent-2", bg: "bg", what: "the opponent lineup heading" },
  { fg: "ok", bg: "bg", what: "a buy figure in the regression list" },
  { fg: "err", bg: "bg", what: "a sell figure, and the MAE that got worse" },
  { fg: "on-accent", bg: "accent", what: "the run button's label" },
];

/** Held to 3. Anything whose shape or edge carries meaning. */
export const BOUNDARY_PAIRINGS: readonly Pairing[] = [
  { fg: "dim", bg: "bg", what: "a control outline, a select, the segmented groups" },
  { fg: "dim", bg: "panel", what: "a control outline over a tinted row" },
  { fg: "accent-text", bg: "bg", what: "the focus ring, the spike gate rule, a ridge past the gate" },
  { fg: "fg", bg: "bg", what: "the decision diagonal and the zero line" },
];

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

export const luminance = (rgb: Rgb): number =>
  0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);

export function ratio(a: Rgb, b: Rgb): number {
  const x = luminance(a);
  const y = luminance(b);
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

/** Both notations `palettes.css` is authored in: plain hex, and hsl with space separators. */
export function parseColour(value: string): Rgb | null {
  const v = value.trim();
  if (v.startsWith("#")) {
    const h = v.slice(1);
    const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h.slice(0, 6);
    if (full.length !== 6) return null;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }
  const m = v.match(/hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)/);
  if (!m) return null;
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(Math.min(k(n) - 3, 9 - k(n)), 1));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Every palette in the vendored stylesheet, with its tokens resolved to rgb. */
export function parsePalettes(css: string): Palette[] {
  return [...css.matchAll(/\[data-theme="([^"]+)"\]\s*\{([^}]+)\}/g)].map(([, id, body]) => {
    const tokens: Record<string, Rgb> = {};
    for (const [, name, value] of body!.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
      const rgb = parseColour(value!);
      if (rgb) tokens[name!] = rgb;
    }
    return { id: id!, tokens };
  });
}

export type Reading = { readonly pairing: Pairing; readonly palette: string; readonly ratio: number };

/** The worst palette for one pairing. The answer to "how much room is left". */
export function worstFor(palettes: readonly Palette[], pairing: Pairing): Reading {
  let worst: Reading | null = null;
  for (const palette of palettes) {
    const fg = palette.tokens[pairing.fg];
    const bg = palette.tokens[pairing.bg];
    if (!fg || !bg) continue;
    const value = ratio(fg, bg);
    if (!worst || value < worst.ratio) worst = { pairing, palette: palette.id, ratio: value };
  }
  if (!worst) throw new Error(`no palette carries --${pairing.fg} and --${pairing.bg}`);
  return worst;
}

/** Every pairing's worst palette, weakest first. */
export function survey(palettes: readonly Palette[], pairings: readonly Pairing[]): Reading[] {
  return pairings.map((p) => worstFor(palettes, p)).sort((a, b) => a.ratio - b.ratio);
}
