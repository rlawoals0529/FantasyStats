/**
 * The composition rules, checked rather than admired.
 *
 * This page was redesigned away from a shape it had in common with every other page its author
 * has shipped: a full-viewport display heading, a muted lede under it, one word in the accent
 * colour, and bordered cards below. Each rule below is one of the moves that took it somewhere
 * else, and each is the kind of thing that creeps back one reasonable-looking commit at a time.
 * A rule nobody can fail is a preference; these can fail and they name what broke.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;
const read = (path: string) => readFileSync(ROOT + path, "utf8");

const html = read("index.html");
const css = read("src/ui/app.css");
const railSource = read("src/ui/rail.ts");

/** Every innermost rule in the stylesheet, with any @media prelude already skipped. */
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
const blocks = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selector: selector!.trim().replace(/\s+/g, " "),
  /** One rule can carry several selectors, and a lookup by any one of them has to find it. */
  parts: selector!
    .split(",")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean),
  body: body!,
}));
const blocksFor = (selector: string) => blocks.filter((b) => b.parts.includes(selector));

describe("the page opens on the instrument, not on a headline", () => {
  it("puts the board first in the sheet, with no hero section before it", () => {
    const sections = [...html.matchAll(/<section class="ch" id="([a-z]+)"/g)].map((m) => m[1]);
    expect(sections[0]).toBe("board");
    // Anything at all between the sheet opening and the board that is not the readings tape.
    const before = html.slice(html.indexOf('<main class="sheet">'), html.indexOf('<section class="ch" id="board"'));
    expect(before).not.toMatch(/<h1|<h2/);
    expect(before.match(/<section/g) ?? []).toHaveLength(0);
  });

  it("carries one h1, and it is the nameplate on the rail rather than a display heading", () => {
    const headings = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)];
    expect(headings).toHaveLength(1);
    expect(headings[0]![0]).toContain('class="rail__mark"');
    const rail = html.slice(html.indexOf("<header class=\"rail\">"), html.indexOf("</header>"));
    expect(rail).toContain("<h1");
  });

  it("has none of the shapes the old composition was built out of", () => {
    for (const gone of ["masthead", "lede", "facts", "band__", "class=\"mark\""]) {
      expect(html.includes(gone), `index.html still carries ${gone}`).toBe(false);
      expect(stripped.includes(gone), `app.css still styles ${gone}`).toBe(false);
    }
  });
});

describe("the digits are the typography", () => {
  /*
   * The ceiling, and the three things allowed past it.
   *
   * The rule this expresses is that the largest thing on any screen of this page is a reading
   * and never a heading. It is checked as arithmetic on the stylesheet rather than by eye,
   * because "the heading crept up to 48px" is invisible in a diff and obvious on the page.
   */
  const CEILING = 30;
  const READINGS = [".tape__lead b", ".readout__odds", ".verdict__odds"];

  /**
   * The largest size a rule can produce. A clamp is taken at its cap.
   *
   * EVERY font-size in the block, not the first one. Read first-only, a rule that already sets
   * 14px and then sets 48px four lines later is graded on the 14, which is the one shape this
   * check has to catch: nobody adds a heading at 48px, they raise one that was already there.
   * Relative units are skipped rather than guessed at; a 0.16em unit under a 68px reading is
   * small by construction.
   */
  const maxPx = (body: string): number =>
    [...body.matchAll(/font-size:\s*([^;]+);/g)]
      .flatMap((m) => [...m[1]!.matchAll(/([\d.]+)px/g)])
      .reduce((m, n) => Math.max(m, Number(n[1])), 0);

  const sized = blocks.map((b) => ({ selector: b.selector, px: maxPx(b.body) })).filter((b) => b.px > 0);

  it("sets nothing but a reading above 30px", () => {
    const tall = sized.filter((b) => b.px > CEILING && !READINGS.includes(b.selector));
    expect(
      tall.map((b) => `${b.selector} at ${b.px}px`),
      "these are set larger than the figures they annotate",
    ).toEqual([]);
  });

  it("and every reading that is allowed past it actually is past it", () => {
    // Without this the rule above passes for the wrong reason the moment somebody shrinks the
    // readouts: a page where nothing is large has no hierarchy rather than the right one.
    for (const selector of READINGS) {
      const px = sized.filter((b) => b.selector === selector).reduce((m, b) => Math.max(m, b.px), 0);
      expect(px, `${selector} is only ${px}px`).toBeGreaterThan(CEILING);
    }
  });

  it("gives every figure on the page tabular numerals", () => {
    // A reading that updates in place and is not tabular slides sideways as its digits change,
    // which reads as the page glitching rather than as the number moving.
    const FIGURES = [
      ".fig",
      ".rail__val",
      ".rail__who",
      ".rail__unit",
      ".tape__cell b",
      ".row__spike",
      ".row__span",
      ".row__rank",
      ".readout__odds",
      ".verdict__odds",
      ".verdict__fig b",
      ".reason__effect",
      ".regress__val",
      ".ladder__p",
      ".plot__val",
      ".gauge__cell b",
    ];
    for (const selector of FIGURES) {
      const found = blocksFor(selector);
      expect(found.length, `no rule for ${selector}`).toBeGreaterThan(0);
      expect(
        found.some((b) => /font-variant-numeric:\s*tabular-nums/.test(b.body)),
        `${selector} sets no tabular figures`,
      ).toBe(true);
    }
  });

  it("never asks for any other numeral style", () => {
    for (const block of blocks) {
      const set = block.body.match(/font-variant-numeric:\s*([^;]+);/)?.[1]?.trim();
      if (set === undefined) continue;
      expect(set, `${block.selector} sets font-variant-numeric`).toBe("tabular-nums");
    }
  });
});

describe("the typeface", () => {
  it("loads no display serif, and neither of the two that are banned by name", () => {
    const link = html.match(/fonts\.googleapis\.com\/css2\?([^"]+)/)?.[1] ?? "";
    expect(link, "index.html requests no webfont").not.toBe("");
    expect(link).toContain("IBM+Plex+Mono");
    for (const banned of ["Fraunces", "Instrument+Serif", "Instrument Serif"]) {
      expect(html.includes(banned), `index.html still loads ${banned}`).toBe(false);
      expect(css.includes(banned), `app.css still names ${banned}`).toBe(false);
    }
  });

  it("redefines --font-display away from the vendored serif, to the mono face", () => {
    // src/theme/type.css is vendored and never edited, and it sets --font-display to Fraunces.
    // The override has to live here, and it has to be a real override: a page that merely stops
    // loading the webfont still asks for Georgia and still gets a serif.
    const display = stripped.match(/--font-display:\s*([^;]+);/)?.[1] ?? "";
    expect(display).toContain("IBM Plex Mono");
    expect(display, "--font-display still falls back to a serif").not.toMatch(/(^|[\s,"])serif/);
  });
});

describe("the fixed rail, and what is placed against it", () => {
  it("publishes its measured height rather than letting the stylesheet guess", () => {
    expect(railSource).toMatch(/setProperty\("--rail-h"/);
    expect(blocksFor(":root")[0]?.body, ":root declares no --rail-h fallback").toMatch(/--rail-h:/);
  });

  it("places the sticky ruler, the sheet and the board's scroll margin against it", () => {
    // Each of these is a place the fixed rail would otherwise cover: the ruler sticks under it,
    // the sheet starts under it, and an arrow keypress scrolls the active row out from under it.
    expect(blocksFor(".ruler")[0]?.body).toMatch(/top:\s*(var\(--rail-h\)|calc\(var\(--rail-h\))/);
    expect(blocksFor(".sheet")[0]?.body).toMatch(/padding-block:\s*calc\(var\(--rail-h\)/);
    expect(blocksFor(".row")[0]?.body).toMatch(/scroll-margin-block:\s*calc\(var\(--rail-h\)/);
    expect(blocksFor(".ch")[0]?.body).toMatch(/scroll-margin-top:\s*calc\(var\(--rail-h\)/);
  });
});
