/**
 * The fast half of the contrast story: the pairings, checked against all fifteen palettes in a
 * few milliseconds and with no browser.
 *
 * `e2e/contrast-sweep.mjs` is the other half and neither replaces the other. This says the
 * pairings the stylesheet was written against are sound. The sweep says those are the pairings
 * that actually ended up on screen, which is a question no token file can answer: a --dim label
 * is comfortable on --bg and marginal on --raised, and only a browser knows which one a given
 * element was painted over. The sweep found two elements this file could never have: a ruler
 * tick label sitting inside its own 1px --edge line, at 2.01:1, and the gate label inside the
 * --accent-text rule, at 1.00:1.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AA_BOUNDARY,
  AA_TEXT,
  BOUNDARY_PAIRINGS,
  TEXT_PAIRINGS,
  parsePalettes,
  ratio,
  survey,
  worstFor,
} from "../../src/ui/contrast.ts";

const palettes = parsePalettes(
  readFileSync(new URL("../../src/theme/palettes.css", import.meta.url), "utf8"),
);
const app = readFileSync(new URL("../../src/ui/app.css", import.meta.url), "utf8");
const token = (id: string, name: string) => palettes.find((p) => p.id === id)!.tokens[name]!;

describe("every palette", () => {
  it("was found and parsed", () => {
    expect(palettes).toHaveLength(15);
    expect(palettes.map((p) => p.id)).toContain("twilight-comet");
    for (const p of palettes) expect(Object.keys(p.tokens).length).toBeGreaterThanOrEqual(15);
  });

  it("parses both notations palettes.css is authored in", () => {
    // hsl with space separators for the grounds, hex for everything else. A parser that
    // silently dropped one would leave a third of the pairings unchecked and still look green.
    expect(token("twilight-comet", "bg")).toEqual([13, 13, 21]);
    expect(token("twilight-comet", "accent")).toEqual([139, 124, 246]);
  });

  for (const pairing of TEXT_PAIRINGS) {
    it(`reads --${pairing.fg} on --${pairing.bg} at 4.5 or better: ${pairing.what}`, () => {
      const worst = worstFor(palettes, pairing);
      expect(
        worst.ratio,
        `${worst.palette}: --${pairing.fg} on --${pairing.bg} is ${worst.ratio.toFixed(2)}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }

  for (const pairing of BOUNDARY_PAIRINGS) {
    it(`draws --${pairing.fg} on --${pairing.bg} at 3 or better: ${pairing.what}`, () => {
      const worst = worstFor(palettes, pairing);
      expect(
        worst.ratio,
        `${worst.palette}: --${pairing.fg} on --${pairing.bg} is ${worst.ratio.toFixed(2)}`,
      ).toBeGreaterThanOrEqual(AA_BOUNDARY);
    });
  }

  it("has its two tightest text pairings where the tokens put them, not where a rule did", () => {
    /*
     * A regression guard on the survey itself, and a statement of where the slack has gone.
     *
     * The tightest is --on-accent on --accent at exactly 4.50 on plushie-pink, and that is the
     * palette's own arithmetic rather than a choice made here: --on-accent IS the colour the
     * palette designates as readable on its accent, so the one filled button on the page has
     * no alternative and no headroom. It is why that button carries no opacity, no lightened
     * hover and no dimmed disabled state.
     *
     * Next is --dim on --bg at 4.80, which is the pairing everything else on the page rests on.
     * If something weaker than these two appears, the design's margin moved and the block of
     * measurements at the top of app.css is out of date.
     */
    const weakest = survey(palettes, TEXT_PAIRINGS);
    expect(`${weakest[0]!.pairing.fg}/${weakest[0]!.pairing.bg}`).toBe("on-accent/accent");
    expect(weakest[0]!.ratio).toBeGreaterThanOrEqual(AA_TEXT);
    expect(`${weakest[1]!.pairing.fg}/${weakest[1]!.pairing.bg}`).toBe("dim/bg");
    expect(weakest[1]!.ratio).toBeGreaterThanOrEqual(AA_TEXT);
    expect(weakest[1]!.ratio).toBeLessThan(5);
  });
});

describe("the three traps this interface was designed around", () => {
  it("confirms --dim has almost no headroom, so nothing may soften it toward --bg", () => {
    const worst = worstFor(palettes, { fg: "dim", bg: "bg", what: "labels" });
    expect(worst.ratio).toBeGreaterThanOrEqual(AA_TEXT);
    // Under half a ratio point of slack. An `opacity: .9` on a dim label spends it.
    expect(worst.ratio).toBeLessThan(AA_TEXT + 0.5);
  });

  it("confirms --edge-strong fails 3:1 on --panel, which is why it bounds no control", () => {
    const edge = worstFor(palettes, { fg: "edge-strong", bg: "panel", what: "unused" });
    expect(edge.ratio).toBeLessThan(AA_BOUNDARY);
    // And --dim, which app.css uses instead, clears it on every palette.
    const dim = worstFor(palettes, { fg: "dim", bg: "panel", what: "control outline" });
    expect(dim.ratio).toBeGreaterThanOrEqual(AA_BOUNDARY);
  });

  it("confirms --accent alone is not readable, which is why it only ever fills", () => {
    const worst = worstFor(palettes, { fg: "accent", bg: "bg", what: "unused" });
    expect(worst.ratio).toBeLessThan(AA_BOUNDARY);
    // Its readable sibling, which every meaningful stroke and every accent word uses instead.
    expect(worstFor(palettes, { fg: "accent-text", bg: "bg", what: "" }).ratio).toBeGreaterThanOrEqual(
      AA_TEXT,
    );
  });
});

describe("the arithmetic", () => {
  it("agrees with the two ends of the WCAG scale", () => {
    expect(ratio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 6);
    expect(ratio([120, 120, 120], [120, 120, 120])).toBeCloseTo(1, 9);
  });

  it("is symmetric in its arguments", () => {
    const a = token("sakura-lake", "dim");
    const b = token("sakura-lake", "bg");
    expect(ratio(a, b)).toBeCloseTo(ratio(b, a), 12);
  });
});

describe("app.css obeys its own rules", () => {
  const stripped = app.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector!.trim(),
    body: body!,
  }));

  it("never paints a surface --raised, where --dim measures exactly the 4.50 floor", () => {
    const worst = worstFor(palettes, { fg: "dim", bg: "raised", what: "unused" });
    expect(worst.ratio).toBeLessThan(AA_TEXT + 0.01);
    expect(stripped).not.toMatch(/background:\s*var\(--raised\)/);
  });

  it("hardcodes no colour", () => {
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(stripped).not.toMatch(/\brgba?\(/);
    expect(stripped).not.toMatch(/\bhsla?\(/);
  });

  it("puts no opacity on anything", () => {
    // --dim clears the text floor by under half a ratio point on the worst palette, so any
    // opacity at all on dim ink takes it under. Rather than police which rules carry text, the
    // property is banned outright: nothing in this design needs it.
    for (const block of blocks) {
      expect(block.body, `${block.selector} sets opacity`).not.toMatch(/(^|[;\s])opacity\s*:/);
    }
  });

  it("never sets --accent as a text colour or a border", () => {
    // The one line rule this design runs on. --accent falls to 2.11:1 against --bg on
    // moonlit-skyline, so an accent-coloured word is illegible on a palette nobody has open.
    // It fills; --accent-text is the readable sibling for anything that must be read.
    expect(stripped).not.toMatch(/color:\s*var\(--accent\)/);
    expect(stripped).not.toMatch(/border[^:]*:\s*[^;]*var\(--accent\)/);
  });

  it("would notice if a colour were hardcoded", () => {
    expect(/#[0-9a-fA-F]{3,8}\b/.test(".x { color: #ff0000 }")).toBe(true);
    expect(/(^|[;\s])opacity\s*:/.test("color: var(--dim); opacity: .8")).toBe(true);
  });
});
