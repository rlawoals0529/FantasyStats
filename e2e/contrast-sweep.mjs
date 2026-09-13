/**
 * Every piece of visible text on this page, in all fifteen palettes, against the surface it is
 * actually painted on.
 *
 *   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node e2e/contrast-sweep.mjs
 *   PLAYWRIGHT_MODULE=...                            node e2e/contrast-sweep.mjs --self-test
 *
 * `test/ui/contrast.test.ts` already checks the token pairings this interface says it uses, in
 * milliseconds and with no browser. This checks something the token file cannot know: where
 * those colours landed. A --dim label is fine on --bg and marginal on --raised, and only the
 * browser knows which one a given element ended up over.
 *
 * SIX STATES, not one page. The probe's own documentation is blunt about this and it is right:
 * a state with a table in it has surfaces the empty state does not, and neither contains the
 * other. The board with a row selected paints a tinted row; the numbers view paints a table
 * head; the reduced-motion page paints an exhibit that does not exist otherwise; 400px paints
 * a different row layout entirely.
 *
 * `--self-test` plants a colour at about 2:1 and requires the sweep to go red. A check nobody
 * has watched fail is a check nobody knows works, and this one has a specific way of failing
 * open: the probe walks ancestors looking for an opaque ground, so a page that changed its
 * layering could have every reading measured against the wrong surface and still come back
 * clean.
 */
import { readFileSync } from "node:fs";
import { probeContrast, describeFailures } from "./contrast-probe.ts";
import {
  AA_BOUNDARY,
  AA_TEXT,
  BOUNDARY_PAIRINGS,
  TEXT_PAIRINGS,
  parsePalettes,
  survey,
} from "../src/ui/contrast.ts";
import { browser, PALETTES, ready, serve, bold, green, red } from "./serve.mjs";

const selfTest = process.argv.includes("--self-test");

/*
 * A colour with no contrast, mixed rather than written flat.
 *
 * color-mix serialises as `color(srgb ...)` in Chromium, which is the notation the probe was
 * extended to parse after a 2:1 caption sailed through a version that only matched rgb(). So
 * planting it this way exercises the parser as well as the threshold.
 */
const POISON = `.ch__note { color: color-mix(in srgb, var(--fg) 17%, var(--bg)) !important; }`;

async function sweep(context, url, label, prepare, options = {}) {
  const { page, problems } = await ready(context, url, options);
  if (selfTest) await page.addStyleTag({ content: POISON });
  if (prepare) await prepare(page);
  const probe = await probeContrast(page, PALETTES, { backdrop: "#ffffff" });
  await page.close();
  return { label, probe, problems };
}

const server = await serve(4319);
const chrome = await browser();
let failed = false;

try {
  const desktop = await chrome.newContext({ viewport: { width: 1380, height: 1000 } });
  const phone = await chrome.newContext({ viewport: { width: 400, height: 820 } });

  const states = [
    await sweep(desktop, server.url, "board, nothing selected"),
    await sweep(desktop, server.url, "a row selected, with its tie set", async (page) => {
      await page.locator(".stack__rows").focus();
      for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
    }),
    await sweep(desktop, server.url, "numbers only, the whole table", async (page) => {
      await page.getByRole("button", { name: "numbers only" }).click();
      await page.waitForSelector(".numbers--wide table");
    }),
    await sweep(desktop, server.url, "a light palette picked by hand", async (page) => {
      await page.locator(".palette select").selectOption("cherry-blossom-dusk");
      await page.waitForTimeout(200);
    }),
    await sweep(desktop, server.url, "reduced motion, with the sample ladder", null, {
      reducedMotion: "reduce",
    }),
    await sweep(phone, server.url, "400px wide"),
  ];

  console.log(bold("\n  contrast sweep"));
  console.log(`  ${PALETTES.length} palettes, ${states.length} states\n`);

  for (const { label, probe, problems } of states) {
    const ok = probe.failures.length === 0;
    const mark = ok ? green("pass") : red("FAIL");
    console.log(
      `  ${mark}  ${label.padEnd(34)} ${String(probe.measured).padStart(5)} readings, ` +
        `${probe.styles} distinct styles, ${probe.distinctPalettes} palettes painted differently`,
    );

    // A sweep that measured almost nothing is not a pass, it is a sweep that did not run. Both
    // of these have failed open before in other projects: a selector that stopped matching, and
    // an `apply` that silently did nothing so one palette was measured fifteen times.
    if (probe.styles < 12) {
      console.log(red(`        only ${probe.styles} text styles found. This state did not render.`));
      failed = true;
    }
    if (probe.distinctPalettes < PALETTES.length - 1) {
      console.log(
        red(`        only ${probe.distinctPalettes} palettes painted differently. Switching is broken.`),
      );
      failed = true;
    }
    if (problems.length > 0) {
      console.log(red(`        ${problems.join("\n        ")}`));
      failed = true;
    }
    if (!ok) {
      failed = true;
      console.log(
        describeFailures(probe.failures)
          .split("\n")
          .slice(0, 12)
          .map((line) => `        ${line}`)
          .join("\n"),
      );
      if (probe.failures.length > 12) console.log(`        and ${probe.failures.length - 12} more`);
    }
  }

  const all = states.flatMap((s) => s.probe.failures);
  const measured = states.reduce((n, s) => n + s.probe.measured, 0);
  console.log(`\n  ${measured} readings in total, ${all.length} below their floor`);

  /*
   * How much room is left, which a pass/fail line does not say.
   *
   * The probe reports only what breached a floor, so a green sweep on its own cannot tell a
   * design with four points of slack from one sitting a hundredth above the line. These are
   * the same pairings `test/ui/contrast.test.ts` gates on, from the same module, each shown
   * against the palette that is worst for it.
   */
  const palettes = parsePalettes(readFileSync(new URL("../src/theme/palettes.css", import.meta.url), "utf8"));
  for (const [title, pairings, floor] of [
    ["text, floor 4.5", TEXT_PAIRINGS, AA_TEXT],
    ["boundaries, floor 3.0", BOUNDARY_PAIRINGS, AA_BOUNDARY],
  ]) {
    console.log(bold(`\n  worst palette per pairing, ${title}`));
    for (const reading of survey(palettes, pairings)) {
      const { fg, bg, what } = reading.pairing;
      const slack = reading.ratio - floor;
      console.log(
        `   ${reading.ratio.toFixed(2).padStart(6)}:1  ` +
          `--${fg} on --${bg}`.padEnd(30) +
          `${reading.palette.padEnd(21)} ${slack < 0.4 ? red("no room") : "     ok"}  ${what}`,
      );
    }
  }

  if (selfTest) {
    const caught = all.some((f) => f.cls.includes("ch__note"));
    if (caught) {
      console.log(green(`\n  self-test: the planted 2:1 colour was found. The sweep can go red.\n`));
      process.exit(0);
    }
    console.log(red(`\n  self-test: the planted colour was NOT found. This sweep proves nothing.\n`));
    process.exit(1);
  }

  console.log(failed ? red("\n  FAILED\n") : green("\n  every reading clears its WCAG AA floor\n"));
  process.exit(failed ? 1 : 0);
} finally {
  await chrome.close();
  server.stop();
}
