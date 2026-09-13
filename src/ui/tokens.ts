/**
 * The palette, read off the cascade instead of written down.
 *
 * A canvas cannot use a CSS variable. It needs a colour string, and the tempting way to get one
 * is to paste the hex in beside the drawing code, at which point fourteen of the fifteen
 * palettes are wrong and nothing says so: the DOM around the canvas recolours on a palette
 * switch and the picture inside it does not. So every drawing colour comes from
 * `getComputedStyle` on the element the canvas actually sits in, and a palette switch is
 * followed by one re-read and a redraw.
 *
 * Alpha is the second half of the problem. `--accent` arrives as `#8b7cf6` on some palettes and
 * `hsl(247 24.4% 6.5%)` on others, and neither can have an alpha bolted on by string surgery.
 * A scratch 2D context normalises any colour the browser can parse into `#rrggbb`, which is the
 * one conversion that does not need a CSS colour parser in here.
 */

export type TokenName =
  | "bg"
  | "panel"
  | "raised"
  | "accent"
  | "accent-2"
  | "fg"
  | "dim"
  | "edge"
  | "edge-strong"
  | "ok"
  | "warn"
  | "err"
  | "caution"
  | "accent-text"
  | "on-accent";

const NAMES: readonly TokenName[] = [
  "bg",
  "panel",
  "raised",
  "accent",
  "accent-2",
  "fg",
  "dim",
  "edge",
  "edge-strong",
  "ok",
  "warn",
  "err",
  "caution",
  "accent-text",
  "on-accent",
];

export type Palette = {
  /** Every token as the browser resolved it, ready to hand to a canvas. */
  readonly hex: Readonly<Record<TokenName, string>>;
  /** The same token with an alpha applied, for fills under a stroke. */
  alpha(name: TokenName, a: number): string;
  /** Mix two tokens. Used for the one colour the tokens do not carry: a shared tie region. */
  mix(a: TokenName, b: TokenName, t: number): string;
  /** Which way this palette paints, so a renderer can pick the right direction to lighten. */
  readonly dark: boolean;
};

/** The scratch context that normalises a colour. One per document, created on first use. */
let scratch: CanvasRenderingContext2D | null = null;
function normalise(value: string, fallback: string): [number, number, number] {
  if (!scratch) {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    scratch = c.getContext("2d");
  }
  const ctx = scratch;
  // A context can genuinely be null: a browser with 2D disabled, or a test environment with a
  // stub canvas. Returning a visible fallback beats throwing inside a paint.
  if (!ctx) return hexToRgb(fallback);
  ctx.fillStyle = fallback;
  ctx.fillStyle = value.trim() || fallback;
  const out = ctx.fillStyle;
  return typeof out === "string" && out.startsWith("#") ? hexToRgb(out) : hexToRgb(fallback);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h.slice(0, 6).padEnd(6, "0");
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ];
}

const rgbString = ([r, g, b]: [number, number, number]) => `rgb(${r}, ${g}, ${b})`;

/**
 * Read the palette currently in force on an element.
 *
 * Call it after a palette switch, not once at boot. Caching this is the exact bug it exists to
 * prevent: the DOM repaints from the cascade and a cached canvas palette does not.
 */
export function readPalette(host: Element = document.documentElement): Palette {
  const cs = getComputedStyle(host);
  const rgb = {} as Record<TokenName, [number, number, number]>;
  const hex = {} as Record<TokenName, string>;
  for (const name of NAMES) {
    // The fallback is a mid grey rather than black or white: on a palette that somehow lost a
    // token, mid grey is visible against both grounds, so the gap shows up instead of hiding.
    const raw = cs.getPropertyValue(`--${name}`);
    const triple = normalise(raw, "#808080");
    rgb[name] = triple;
    hex[name] = rgbString(triple);
  }
  // Luminance of the page ground decides which way "lighter" means. Asking the palette
  // manifest would work too, but the manifest is not what the canvas is sitting on.
  const [r, g, b] = rgb.bg;
  const dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;

  return {
    hex,
    dark,
    alpha(name, a) {
      const [rr, gg, bb] = rgb[name];
      return `rgba(${rr}, ${gg}, ${bb}, ${Math.max(0, Math.min(1, a))})`;
    },
    mix(a, b, t) {
      const k = Math.max(0, Math.min(1, t));
      const x = rgb[a];
      const y = rgb[b];
      return rgbString([
        Math.round(x[0] + (y[0] - x[0]) * k),
        Math.round(x[1] + (y[1] - x[1]) * k),
        Math.round(x[2] + (y[2] - x[2]) * k),
      ]);
    },
  };
}

/** Relative luminance, exported so the unit suite can hold a pairing to a ratio. */
export function luminance(rgb: readonly [number, number, number]): number {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2]);
}

/** WCAG contrast between two colours given as rgb triples. */
export function contrast(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Parse `rgb(r, g, b)` back to a triple, so the unit suite can measure what a palette returned. */
export function toTriple(value: string): [number, number, number] {
  const m = value.match(/rgba?\(([^)]+)\)/);
  if (!m) return hexToRgb(value);
  const parts = m[1]!.split(/[,\s/]+/).filter(Boolean).map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}
