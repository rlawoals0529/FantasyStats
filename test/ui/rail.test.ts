/** @vitest-environment jsdom */
/**
 * The status rail, which is the half of this composition that has to keep working.
 *
 * The rail replaces a heading, and a heading cannot go wrong. A live readout can: it can stop
 * following the board, it can start printing a bare number with no unit, and it can publish a
 * height of zero and take the sticky ruler down with it. Each of those looks completely correct
 * in a screenshot taken one second after load.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { mountBoard } from "../../src/ui/board.ts";
import { mountRail } from "../../src/ui/rail.ts";
import { fixtureBoard } from "../../src/ui/fixtures/generate.ts";
import * as fmt from "../../src/ui/format.ts";
import { installFakeCanvas, installJsdomGaps, TWILIGHT_COMET } from "./fake-canvas.ts";

const MARKUP = `
  <header class="rail"><h1 class="rail__mark">FantasyStats</h1><div class="rail__chans"></div></header>
  <section id="board">
    <div class="controls"></div>
    <div class="ruler"><div class="ruler__track"></div></div>
    <div class="stack">
      <canvas class="stack__ink"></canvas>
      <ul class="stack__rows" role="listbox" tabindex="0"></ul>
    </div>
    <div class="readout"></div>
    <div class="numbers numbers--wide" hidden></div>
  </section>`;

const week = fixtureBoard();
const ordered = [...week.players].sort((a, b) => b.outlook.spike - a.outlook.spike);

function mount(board = week) {
  document.body.innerHTML = MARKUP;
  document.head.innerHTML = `<style>${TWILIGHT_COMET}</style>`;
  document.documentElement.setAttribute("data-theme", "twilight-comet");
  document.documentElement.style.removeProperty("--rail-h");
  const rail = mountRail(document.querySelector<HTMLElement>(".rail")!);
  mountBoard(
    document.getElementById("board") as HTMLElement,
    board,
    () => {},
    (selection) => {
      if (!selection) {
        rail.set("sel", { value: "none", unit: "on this filter" });
        return;
      }
      rail.set("sel", {
        who: selection.player.name,
        value: fmt.pct(selection.player.outlook.spike),
        unit: `in 100, rank ${selection.rank} of ${selection.of}`,
      });
    },
  );
  return { rail };
}

const channel = (id: string) => document.querySelector(`[data-channel="${id}"]`)!;
const key = (name: string) =>
  document
    .querySelector(".stack__rows")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));

beforeEach(() => {
  installFakeCanvas();
  installJsdomGaps();
});

describe("the rail", () => {
  it("builds one channel per reading, each with its own label", () => {
    mount();
    expect(document.querySelectorAll(".rail__ch")).toHaveLength(3);
    expect([...document.querySelectorAll(".rail__key")].map((k) => k.textContent)).toEqual([
      "week",
      "selected",
      "matchup",
    ]);
  });

  it("reports the board's selection without being asked after mounting", () => {
    // The board fires its first selection from inside mountBoard, before the caller's own const
    // exists. The same shape of bug already cost this project a page that would not boot.
    mount();
    const top = ordered[0]!;
    expect(channel("sel").textContent).toContain(top.name);
    expect(channel("sel").textContent).toContain(fmt.pct(top.outlook.spike));
  });

  it("follows the keyboard down the board", () => {
    mount();
    const before = channel("sel").textContent;
    key("ArrowDown");
    const after = channel("sel").textContent;
    expect(after).not.toBe(before);
    expect(after).toContain(ordered[1]!.name);
    expect(after).toContain("rank 2 of");
    key("End");
    expect(channel("sel").textContent).toContain(ordered[ordered.length - 1]!.name);
  });

  it("renumbers against the filtered board rather than the whole one", () => {
    mount();
    const te = [...document.querySelectorAll<HTMLButtonElement>(".controls button")].find(
      (b) => b.dataset["value"] === "TE",
    )!;
    te.click();
    const shown = week.players.filter((p) => p.position === "TE");
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(week.players.length);
    expect(channel("sel").textContent).toContain(`of ${shown.length}`);
  });

  it("says so rather than holding a stale player when a filter empties the board", () => {
    /*
     * A board with no tight ends on it, then filtered to tight ends.
     *
     * This is the path that cannot be reached through the shipped fixture, because it carries
     * every position, and it is the one that matters: with nothing selected the readout empties
     * and a rail that is only ever told about real selections goes on printing the last player
     * it saw, beside a board that no longer contains them.
     */
    const noTightEnds = { ...week, players: week.players.filter((p) => p.position !== "TE") };
    expect(noTightEnds.players.length).toBeLessThan(week.players.length);
    mount(noTightEnds);
    const before = channel("sel").textContent;
    const te = [...document.querySelectorAll<HTMLButtonElement>(".controls button")].find(
      (b) => b.dataset["value"] === "TE",
    )!;
    te.click();
    expect(document.querySelectorAll(".row")).toHaveLength(0);
    expect(channel("sel").textContent).not.toBe(before);
    expect(channel("sel").textContent).toContain("none");
  });

  it("never prints a figure without its unit", () => {
    // The page's own rule, applied to the chrome: a bare 72 at the top of an instrument is the
    // one thing a reader cannot check.
    const { rail } = mount();
    rail.set("week", { value: "18", unit: "of 2025" });
    rail.set("sim", { value: "84% ± 1", unit: "over 10,000" });
    for (const id of ["week", "sel", "sim"]) {
      const unit = channel(id).querySelector(".rail__unit")!;
      expect(unit.textContent!.trim(), `the ${id} channel prints a bare figure`).not.toBe("");
    }
  });

  it("publishes no rail height when it cannot measure one", () => {
    /*
     * jsdom reports every box as zero by zero, and so does a page whose fonts have not landed.
     * Writing `--rail-h: 0px` there would put the sticky ruler back underneath the fixed rail
     * for whoever's first paint happened to fall in that window, and the stylesheet's own
     * fallback is a better answer than a measurement that cannot be true.
     */
    const { rail } = mount();
    expect(rail.measure()).toBe(0);
    expect(document.documentElement.style.getPropertyValue("--rail-h")).toBe("");
  });
});
