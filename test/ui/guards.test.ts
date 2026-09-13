/**
 * The rules that are not about arithmetic, and that nothing else would catch.
 *
 * Each of these has cost somebody real time somewhere, and each is invisible in review: a page
 * that takes no clicks looks perfect in a screenshot, a restated subtitle reads as helpful, and
 * a stray em dash is one character.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** Everything this slice owns. The vendored trees are somebody else's and are not policed. */
const OWNED = [
  ...walk(join(ROOT, "src/ui")),
  ...walk(join(ROOT, "test/ui")),
  ...walk(join(ROOT, "e2e")).filter((f) => !f.endsWith("contrast-probe.ts")),
  join(ROOT, "index.html"),
];

const read = (path: string) => readFileSync(path, "utf8");

describe("the overlay cannot swallow the page", () => {
  const app = read(join(ROOT, "src/ui/app.css"));
  const stripped = app.replace(/\/\*[\s\S]*?\*\//g, "");
  const block = (selector: string): string => {
    const match = stripped.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
    return match?.[1] ?? "";
  };

  it("gives .gauge pointer-events: none", () => {
    /*
     * `.gauge` is `position: fixed; inset: 0`, so it covers the viewport and sits over every
     * canvas on the page. Without this declaration every pointer aimed at the board lands on a
     * transparent div: hover never fires, clicks select nothing, and the page looks completely
     * correct in a screenshot. This test fails if the line is removed, and
     * `e2e/interaction.mjs` checks the behaviour itself by asking the browser what is actually
     * on top of a row.
     */
    expect(block(".gauge")).toMatch(/pointer-events:\s*none/);
  });

  it("keeps .gauge full-viewport, so the rule above is not idly true", () => {
    // If the overlay stopped covering the page, the test above would pass for the wrong reason
    // and stop protecting anything.
    expect(block(".gauge")).toMatch(/position:\s*fixed/);
    expect(block(".gauge")).toMatch(/inset:\s*0/);
  });

  it("gives the board canvas pointer-events: none so the rows take the clicks", () => {
    expect(block(".stack__ink")).toMatch(/pointer-events:\s*none/);
  });

  it("gives the plot canvases pointer-events: none", () => {
    expect(stripped).toMatch(/\.plot canvas\s*\{[^}]*pointer-events:\s*none/);
  });
});

describe("copy", () => {
  // Built from escapes, never written as a literal. A character class holding the two
  // characters would make this file the first thing its own check finds, and the obvious fix
  // for that - exempting the file - is how a guard quietly stops guarding.
  const LONG_DASH = () => new RegExp("[\\u2013\\u2014]", "g");

  it("contains no em dash or en dash anywhere in this slice", () => {
    for (const file of OWNED) {
      const bad = [...read(file).matchAll(LONG_DASH())];
      expect(bad, `${file.replace(ROOT, "")} contains a dash that is not a hyphen`).toEqual([]);
    }
  });

  it("would catch a long dash if one appeared", () => {
    // Built with fromCharCode for the same reason the pattern is: a literal here would be a
    // finding in this file, and the guard would have to start exempting itself.
    const en = String.fromCharCode(0x2013);
    const em = String.fromCharCode(0x2014);
    expect(`a ${em} b`.match(LONG_DASH())).toHaveLength(1);
    expect(`a ${en} b`.match(LONG_DASH())).toHaveLength(1);
    expect(`a - b, and a ${String.fromCharCode(0x2212)} sign`.match(LONG_DASH())).toBeNull();
  });

  it("mentions no tool that did not write it", () => {
    const banned = /generated with|co-authored-by|\bclaude\b|\bcopilot\b|\bchatgpt\b/i;
    // This file is exempt from this one check and only this one, because the checker has to
    // contain the strings it bans. Every other file, including this one's dash check above, is
    // scanned normally.
    const self = join(ROOT, "test/ui/guards.test.ts");
    for (const file of OWNED) {
      if (file === self) continue;
      expect(banned.test(read(file)), file.replace(ROOT, "")).toBe(false);
    }
  });

  it("would catch a watermark if one appeared", () => {
    // A guard nobody has seen fail is a guard nobody knows works.
    const banned = /generated with|co-authored-by|\bclaude\b|\bcopilot\b|\bchatgpt\b/i;
    expect(banned.test("// Generated with something")).toBe(true);
    expect(banned.test("the model claimed 47 spikes")).toBe(false);
  });

  it("has no subtitle that restates its heading", () => {
    /*
     * Every heading in index.html, against the first paragraph under it. A subtitle earns its
     * place by carrying a unit, a constraint or a consequence; one that repeats the heading's
     * own words is decoration. Checked as a content-word overlap rather than by eye, because by
     * eye is how they get in.
     */
    const html = read(join(ROOT, "index.html"));
    const stop = new Set([
      "the", "a", "an", "is", "are", "of", "on", "in", "and", "or", "to", "it", "this",
      "that", "with", "as", "at", "by", "for", "from", "so", "than", "then", "every",
    ]);
    const words = (s: string) =>
      new Set(
        s
          .toLowerCase()
          .replace(/<[^>]*>/g, " ")
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length > 2 && !stop.has(w)),
      );

    const pairs = [...html.matchAll(/<h([12])[^>]*>([\s\S]*?)<\/h\1>[\s\S]{0,400}?<p[^>]*>([\s\S]*?)<\/p>/g)];
    expect(pairs.length).toBeGreaterThan(2);
    for (const [, , heading, para] of pairs) {
      const head = words(heading!);
      const sub = words(para!);
      const shared = [...head].filter((w) => sub.has(w));
      expect(
        shared.length,
        `"${heading!.trim()}" and the copy under it share: ${shared.join(", ")}`,
      ).toBeLessThan(Math.max(2, head.size));
    }
  });
});

describe("the slice boundary", () => {
  // Modules only. DEPS.md documents the seam by quoting the two import lines that change when
  // the real pipeline lands, and a scan that reads prose as code turns its own documentation
  // into a violation.
  const modules = () => walk(join(ROOT, "src/ui")).filter((f) => f.endsWith(".ts"));

  it("imports nothing from the pipeline or the simulator", () => {
    // The whole integration story is that `src/ui/ports.ts` is the seam. A stray import from
    // src/model or src/pipeline would make this slice depend on a shape it does not own.
    for (const file of modules()) {
      expect(read(file), file.replace(ROOT, "")).not.toMatch(/from ["']\.\.\/(model|pipeline)\//);
    }
  });

  it("touches only shared, lib and theme outside its own directory", () => {
    // Resolved against the importing file rather than matched as a string: a nested module's
    // "../ports.ts" is inside src/ui and a string match on "../" cannot tell the two apart.
    const allowed = ["src/ui/", "src/shared/", "src/lib/", "src/theme/"];
    for (const file of modules()) {
      for (const [, spec] of read(file).matchAll(/from ["'](\.[^"']+)["']/g)) {
        const target = resolve(dirname(file), spec!).replace(ROOT, "");
        expect(
          allowed.some((prefix) => target.startsWith(prefix)),
          `${file.replace(ROOT, "")} imports ${spec}, which resolves to ${target}`,
        ).toBe(true);
      }
    }
  });

  it("keeps the fixtures out of every module except main", () => {
    // When the real pipeline lands, `src/ui/fixtures/` is deleted and only main.ts changes.
    for (const file of modules()) {
      if (file.includes("/fixtures/") || file.endsWith("/main.ts")) continue;
      expect(read(file), file.replace(ROOT, "")).not.toMatch(/from ["'][^"']*fixtures\//);
    }
  });
});
