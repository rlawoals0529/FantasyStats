/**
 * The checks that only a real browser can make, and that a rule scan would get wrong.
 *
 *   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node e2e/interaction.mjs
 *
 * A walk rather than a markup audit, on purpose. What makes a page like this unusable is
 * behaviour a linter cannot see: a list that reorders under the cursor, thirty-six tab stops
 * between the board and the simulator, a transparent overlay swallowing every click, a focus
 * ring clipped by its own scroller. Each of those looks perfect in the source.
 *
 * Frame times are measured here too, off the page's own meter, because a frame-time claim made
 * anywhere else is a claim about a machine nobody can check.
 */
import { browser, ready, serve, bold, green, red } from "./serve.mjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? green("pass") : red("FAIL")}  ${name}${detail ? `  ${detail}` : ""}`);
};

const server = await serve(4320);
const chrome = await browser();

try {
  const desktop = await chrome.newContext({ viewport: { width: 1380, height: 1000 } });
  const { page, problems } = await ready(desktop, server.url);

  console.log(bold("\n  the page"));
  check("boots with no console error and no uncaught exception", problems.length === 0, problems.join("; "));
  check(
    "built every lane the fixture carries",
    (await page.evaluate(() => window.__spike.lanes())) === 36,
    `${await page.evaluate(() => window.__spike.lanes())} lanes`,
  );

  /* ---- The overlay ------------------------------------------------------------------- */

  console.log(bold("\n  the overlay, which covers the whole viewport"));

  /*
   * The real check, and the reason the CSS rule has a unit test AND this.
   *
   * `.gauge` is fixed at inset 0 over every canvas on the page. The unit test asserts the
   * declaration is present; this asks the browser what is actually on top of a board row, which
   * is the thing that breaks. A page whose overlay eats pointers looks completely correct in a
   * screenshot and responds to nothing.
   */
  const onTop = await page.evaluate(() => {
    const row = document.querySelectorAll(".row")[8];
    const box = row.getBoundingClientRect();
    row.scrollIntoView({ block: "center" });
    const after = row.getBoundingClientRect();
    const hit = document.elementFromPoint(after.left + after.width * 0.55, after.top + after.height / 2);
    return {
      hitsOverlay: hit?.closest(".gauge") !== null,
      insideTheRow: hit?.closest(".row") !== null,
      tag: hit?.tagName,
      cls: hit?.getAttribute("class"),
      had: box.width > 0,
    };
  });
  check("a point over the board does not land on the overlay", !onTop.hitsOverlay, `${onTop.tag}.${onTop.cls}`);
  check("a point over the board lands inside its row", onTop.insideTheRow);

  const gauge = await page.evaluate(() => {
    const el = document.querySelector(".gauge");
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      pointerEvents: cs.pointerEvents,
      coversViewport: box.width >= innerWidth - 1 && box.height >= innerHeight - 1,
    };
  });
  check("the overlay really does cover the viewport", gauge.coversViewport);
  check("and takes no pointer events", gauge.pointerEvents === "none", gauge.pointerEvents);

  /* ---- The ink is painted in the palette, not in a fallback ---------------------------- */

  console.log(bold("\n  the canvas reads its colours off the cascade"));
  /*
   * Sample the board's own pixels and compare them with the palette the DOM is using.
   *
   * A canvas cannot use a CSS variable, so every drawing colour is copied out of
   * getComputedStyle at paint time, and if that read happens before the palette is applied,
   * every token resolves to the empty string and falls back to mid grey. The board then paints
   * a complete, plausible, entirely monochrome picture with no error anywhere. That shipped
   * once and took a pixel sample to find, which is why this check is a pixel sample.
   */
  const ink = await page.evaluate(() => {
    const canvas = document.querySelector(".stack__ink");
    const host = document.querySelector(".stack__rows").getBoundingClientRect();
    const row = document.querySelectorAll(".row")[0];
    const lane = row.querySelector(".row__ink").getBoundingClientRect();
    const dpr = canvas.width / host.width;
    const ctx = canvas.getContext("2d");
    // Just past the gate, near the baseline, where the accent fill is thickest.
    const x = Math.round((lane.left - host.left + lane.width * 0.62) * dpr);
    const y = Math.round((lane.top - host.top + lane.height * 0.82) * dpr);
    const [r, g, b, alpha] = ctx.getImageData(x, y, 1, 1).data;
    const declared = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    const probe = document.createElement("canvas").getContext("2d");
    probe.fillStyle = declared;
    return { pixel: [r, g, b], alpha, accent: probe.fillStyle, theme: document.documentElement.dataset.theme };
  });
  const hex = "#" + ink.pixel.map((v) => v.toString(16).padStart(2, "0")).join("");
  check(
    "the spike fill is this palette's --accent and not a grey fallback",
    hex === ink.accent,
    `${hex} against ${ink.accent} on ${ink.theme}`,
  );

  /* ---- The keyboard ------------------------------------------------------------------ */

  console.log(bold("\n  the keyboard path"));

  const stops = await page.evaluate(() => {
    const focusable = [...document.querySelectorAll("a[href], button, select, [tabindex]")].filter(
      (el) => el.checkVisibility?.() !== false && !el.closest("[hidden]"),
    );
    return focusable.map((el) => `${el.tagName}.${el.getAttribute("class") ?? ""}`);
  });
  check(
    "the board is one tab stop, not thirty-six",
    stops.filter((s) => s.startsWith("LI")).length === 0,
    `${stops.length} stops on the whole page`,
  );

  /*
   * The skip link, checked as the property rather than by pressing Tab once.
   *
   * A bare Tab from a page nobody has clicked moves focus off the document chrome rather than
   * into the page, so the press proves nothing about the page. What matters is that the link is
   * the first thing in tab order, that focusing it brings it ON SCREEN, and that following it
   * lands on the board. A skip link that is reachable and never visible is a link nobody knows
   * they have.
   */
  const skip = await page.evaluate(() => {
    const order = [...document.querySelectorAll("a[href], button, select, [tabindex]")].filter(
      (el) => !el.closest("[hidden]") && el.getAttribute("tabindex") !== "-1",
    );
    const link = document.querySelector(".skip");
    const offscreen = link.getBoundingClientRect();
    link.focus();
    const shown = link.getBoundingClientRect();
    return {
      isFirst: order[0] === link,
      positive: order.some((el) => Number(el.getAttribute("tabindex")) > 0),
      hiddenUntilFocus: offscreen.right < 0,
      visibleOnFocus: shown.left >= 0 && shown.top >= 0 && shown.right <= innerWidth,
      target: link.getAttribute("href"),
      targetExists: document.querySelector(link.getAttribute("href")) !== null,
    };
  });
  check("the skip link is first in tab order", skip.isFirst);
  check("no positive tabindex anywhere, so DOM order is tab order", !skip.positive);
  check("it is out of the way until focused, then on screen", skip.hiddenUntilFocus && skip.visibleOnFocus);
  check("and it points at something", skip.targetExists, skip.target);

  const walk = await page.evaluate(async () => {
    const list = document.querySelector(".stack__rows");
    list.focus();
    const read = () => document.querySelector(".stack__rows").getAttribute("aria-activedescendant");
    const press = (key) =>
      list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    const seen = [read()];
    for (let i = 0; i < 12; i++) {
      press("ArrowDown");
      seen.push(read());
    }
    press("End");
    const last = read();
    press("Home");
    return { seen, last, home: read(), selected: document.querySelectorAll('[aria-selected="true"]').length };
  });
  check("arrow keys move the active row", new Set(walk.seen).size === 13);
  check("End and Home reach both ends", walk.last !== walk.home);
  check("exactly one row is ever selected", walk.selected === 1);

  const spoken = await page.evaluate(() => {
    const row = document.querySelector(`#${CSS.escape(document.querySelector(".stack__rows").getAttribute("aria-activedescendant"))}`);
    return row?.textContent ?? "";
  });
  check(
    "the active row carries its numbers as text",
    /in 100/.test(spoken) && /Median \d/.test(spoken) && /percentile/.test(spoken),
    spoken.slice(0, 72).replace(/\s+/g, " "),
  );

  const focusRing = await page.evaluate(() => {
    const list = document.querySelector(".stack__rows");
    list.focus();
    const row = document.querySelector('.row[aria-selected="true"]');
    const box = row.getBoundingClientRect();
    const host = row.closest(".stack").getBoundingClientRect();
    // A ring drawn outside its own scroller is a ring nobody sees.
    return { visible: box.top >= host.top - 2 && box.bottom <= host.bottom + 2, outline: getComputedStyle(row).outlineStyle };
  });
  check("the selected row sits inside its container so a ring is not clipped", focusRing.visible);

  /* ---- The board does not move under the pointer -------------------------------------- */

  console.log(bold("\n  stability"));
  const before = await page.evaluate(() => [...document.querySelectorAll(".row")].map((r) => r.id));
  await page.mouse.move(700, 500);
  await page.mouse.move(700, 560);
  const after = await page.evaluate(() => [...document.querySelectorAll(".row")].map((r) => r.id));
  check("hovering the board does not reorder it", JSON.stringify(before) === JSON.stringify(after));

  /* ---- 400px --------------------------------------------------------------------------- */

  console.log(bold("\n  400px"));
  const phone = await chrome.newContext({ viewport: { width: 400, height: 820 } });
  const small = await ready(phone, server.url);
  const layout = await small.page.evaluate(() => {
    const doc = document.documentElement;
    const sheet = document.querySelector(".sheet");
    const cs = getComputedStyle(sheet);
    const box = sheet.getBoundingClientRect();
    let widest = 0;
    let culprit = "";
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.right > widest) {
        widest = r.right;
        culprit = `${el.tagName}.${el.getAttribute("class") ?? ""}`;
      }
    }
    return {
      overflow: doc.scrollWidth - doc.clientWidth,
      leftGutter: box.left + parseFloat(cs.paddingLeft),
      rightGutter: innerWidth - box.right + parseFloat(cs.paddingRight),
      widest,
      culprit,
    };
  });
  check("no horizontal scroll", layout.overflow === 0, `${layout.overflow}px overflow`);
  check(
    "the gutter holds on both sides",
    layout.leftGutter >= 16 && layout.rightGutter >= 16,
    `${layout.leftGutter}px left, ${layout.rightGutter}px right`,
  );
  check("nothing reaches past the viewport", layout.widest <= 400, `${layout.widest.toFixed(0)}px, ${layout.culprit}`);

  /* ---- Frame times --------------------------------------------------------------------- */

  console.log(bold("\n  frame times, measured by the page on this machine"));
  // A fresh run so the numbers describe a full simulation rather than whatever is left on the
  // meter after the keyboard walk.
  const frames = await page.evaluate(async () => {
    document.querySelector(".sim__run button").click();
    await new Promise((resolve) => {
      const wait = () => {
        const done = document
          .querySelector('[data-plot="cloud"] .plot__val')
          ?.textContent?.startsWith("10,000");
        done ? resolve() : setTimeout(wait, 100);
      };
      setTimeout(wait, 300);
    });
    return window.__spike.frames();
  });
  /*
   * And the frame itself, which is the number that decides whether it looks smooth.
   *
   * The page's own meter times the PAINT, which is what a renderer controls. This times the gap
   * between frames, which is what a reader sees, and it includes the simulation, the layout and
   * everything else the tab is doing. A paint budget met inside a frame that is being missed is
   * a renderer exonerating itself.
   */
  const wall = await page.evaluate(async () => {
    document.querySelector(".sim__run button").click();
    const gaps = [];
    let previous = performance.now();
    await new Promise((resolve) => {
      const tick = (now) => {
        gaps.push(now - previous);
        previous = now;
        const done = document
          .querySelector('[data-plot="cloud"] .plot__val')
          ?.textContent?.startsWith("10,000");
        done ? resolve() : requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // The first gap spans the click, not a frame.
    const live = gaps.slice(1).sort((x, y) => x - y);
    const at = (q) => live[Math.min(live.length - 1, Math.floor(q * (live.length - 1)))];
    return { count: live.length, p50: at(0.5), p95: at(0.95), worst: live[live.length - 1] };
  });

  const fmt = (s) => `p50 ${s.p50.toFixed(2)}ms  p95 ${s.p95.toFixed(2)}ms  worst ${s.worst.toFixed(2)}ms  over ${s.count} frames`;
  console.log(`        board paint, 36 lanes    ${fmt(frames.board)}`);
  console.log(`        simulator paint          ${fmt(frames.sim)}`);
  console.log(`        whole frame, wall clock  ${fmt(wall)}`);
  console.log("        performance.now() is clamped to 100us in Chromium, so these are quantised");
  check("the simulator holds a 60Hz budget at p95", frames.sim.p95 < 16.7, `${frames.sim.p95.toFixed(2)}ms`);
  check("the board paints a full 36-lane repaint inside one frame", frames.board.p95 < 16.7, `${frames.board.p95.toFixed(2)}ms`);
  check("the animation holds a real 60Hz frame at p95", wall.p95 < 20, `${wall.p95.toFixed(2)}ms between frames`);

  /* ---- The interval actually collapses --------------------------------------------------- */

  console.log(bold("\n  the interval, which is the whole exhibit"));
  /*
   * Read early in a run, then at the end.
   *
   * The axes are fixed by a throwaway pilot simulator on the same seed rather than by the first
   * four hundred draws of the real one, and this is what would catch that regressing: with the
   * pilot taken out of the real run the first reading lands at n = 400, the interval arrives
   * already narrow, and the collapse the plot exists to show has happened before the first
   * frame anybody sees.
   */
  const collapse = await page.evaluate(async () => {
    document.querySelector(".sim__run button").click();
    const read = () => document.querySelector('[data-plot="interval"] .plot__val')?.textContent ?? "";
    const width = (s) => Number(s.split(String.fromCharCode(0x00b1))[1] ?? NaN);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const early = read();
    await new Promise((resolve) => {
      const wait = () => {
        const done = document
          .querySelector('[data-plot="cloud"] .plot__val')
          ?.textContent?.startsWith("10,000");
        done ? resolve() : setTimeout(wait, 80);
      };
      wait();
    });
    return { early, earlyWidth: width(early), late: read(), lateWidth: width(read()) };
  });
  check(
    "it starts wide enough to contain a coin flip",
    collapse.earlyWidth >= 10,
    `${collapse.early} after two frames`,
  );
  check(
    "and ends about a point either side",
    collapse.lateWidth <= 2,
    `${collapse.late} at ten thousand runs`,
  );

  /* ---- Reduced motion ------------------------------------------------------------------ */

  console.log(bold("\n  prefers-reduced-motion"));
  const stillContext = await chrome.newContext({ viewport: { width: 1380, height: 1000 } });
  const still = await ready(stillContext, server.url, { reducedMotion: "reduce" });
  const composition = await still.page.evaluate(() => {
    const cells = [...document.querySelectorAll(".ladder__cell")];
    return {
      reduced: window.__spike.reducedMotion(),
      rungs: cells.length,
      labels: cells.map((c) => c.querySelector(".ladder__n")?.textContent),
      odds: cells.map((c) => c.querySelector(".ladder__p")?.textContent),
      simFramesPainted: window.__spike.frames().sim.count,
      cloudComplete: document
        .querySelector('[data-plot="cloud"] .plot__val')
        ?.textContent?.startsWith("10,000"),
    };
  });
  check("the page knows motion is off", composition.reduced === true);
  check("it renders a four rung sample ladder", composition.rungs === 4, composition.labels.join(", "));
  check(
    "each rung carries its own interval, and they narrow",
    composition.odds.every((o) => /±/.test(o)),
    composition.odds.join("  "),
  );
  check("no frames were animated", composition.simFramesPainted === 0, `${composition.simFramesPainted} painted`);
  check("the cloud is complete rather than frozen part way", composition.cloudComplete === true);
  check("that page booted cleanly too", still.problems.length === 0, still.problems.join("; "));

  const failures = results.filter((r) => !r.ok);
  console.log(
    failures.length === 0
      ? green(`\n  ${results.length} checks, all pass\n`)
      : red(`\n  ${failures.length} of ${results.length} FAILED: ${failures.map((f) => f.name).join("; ")}\n`),
  );
  process.exit(failures.length === 0 ? 0 : 1);
} finally {
  await chrome.close();
  server.stop();
}
