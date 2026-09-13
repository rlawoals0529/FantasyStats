/**
 * Stand up the real page and a real browser, for the two scripts that need both.
 *
 * The dev server rather than a built bundle: what these check is the source as written, and a
 * build step between the file and the measurement is one more place a difference can hide.
 *
 * Playwright is not a dependency of this project and is not going to become one. `npm test` and
 * `tsc --noEmit` have to stay green on a checkout that has never downloaded a browser, so these
 * scripts are run on demand and told where an install lives:
 *
 *   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node e2e/contrast-sweep.mjs
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;

export const PALETTES = JSON.parse(readFileSync(new URL("../src/theme/palettes.json", import.meta.url), "utf8"));

/** A vite dev server on a port of its own, and a function that stops it. */
export async function serve(port = 4319) {
  const child = spawn("npx", ["vite", "--port", String(port), "--strictPort"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const url = `http://localhost:${port}/`;
  for (let tries = 0; tries < 120; tries++) {
    if (child.exitCode !== null) throw new Error(`vite exited early:\n${log}`);
    try {
      const res = await fetch(url);
      if (res.ok) return { url, stop: () => child.kill("SIGTERM") };
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  child.kill("SIGTERM");
  throw new Error(`vite never came up on ${port}:\n${log}`);
}

export async function browser() {
  const modulePath = process.env["PLAYWRIGHT_MODULE"];
  if (!modulePath) {
    throw new Error(
      "PLAYWRIGHT_MODULE is not set. Point it at a playwright install, for example\n" +
        "  PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs node e2e/<script>.mjs",
    );
  }
  const { chromium } = await import(modulePath);
  return chromium.launch();
}

/**
 * A page with the board built and the simulation finished.
 *
 * `__spike` is the page's own read-only measurement window, and waiting on it rather than on a
 * timeout means a slow machine does not turn into a flaky check.
 */
export async function ready(context, url, { reducedMotion = "no-preference" } = {}) {
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  await page.emulateMedia({ reducedMotion });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.__spike === "object", null, { timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelector(".verdict__odds")?.textContent?.length > 0,
    null,
    { timeout: 15000 },
  );
  // The animated run finishes on its own clock; the plot header says when it is done.
  await page.waitForFunction(
    () => document.querySelector('[data-plot="cloud"] .plot__val')?.textContent?.startsWith("10,000"),
    null,
    { timeout: 15000 },
  );
  return { page, problems };
}

export const bold = (s) => `[1m${s}[0m`;
export const green = (s) => `[32m${s}[0m`;
export const red = (s) => `[31m${s}[0m`;
