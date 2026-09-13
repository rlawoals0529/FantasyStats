/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { mountBoard } from "../../src/ui/board.ts";
import { fixtureBoard } from "../../src/ui/fixtures/generate.ts";
import { rankRanges } from "../../src/ui/stats.ts";
import { SPIKE_POINTS } from "../../src/shared/player.ts";
import { installFakeCanvas, installJsdomGaps, TWILIGHT_COMET } from "./fake-canvas.ts";

const MARKUP = `
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

function mount() {
  document.body.innerHTML = MARKUP;
  document.head.innerHTML = `<style>${TWILIGHT_COMET}</style>`;
  document.documentElement.setAttribute("data-theme", "twilight-comet");
  const root = document.getElementById("board") as HTMLElement;
  const paints: number[] = [];
  const board = mountBoard(root, week, (ms) => paints.push(ms));
  return { root, board, paints };
}

const rows = () => [...document.querySelectorAll<HTMLElement>(".row")];
const active = () => document.querySelector(".stack__rows")!.getAttribute("aria-activedescendant");
const key = (name: string) =>
  document
    .querySelector(".stack__rows")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));

beforeEach(() => {
  installFakeCanvas();
  installJsdomGaps();
});

describe("the board", () => {
  it("renders one row per player", () => {
    mount();
    expect(rows()).toHaveLength(week.players.length);
  });

  it("gives the paint callback a time on mount, before its own return value exists", () => {
    // The callback fires from inside mountBoard. It used to reach back through the const the
    // caller was still evaluating, and threw on every load.
    const { paints } = mount();
    expect(paints.length).toBeGreaterThan(0);
    expect(Number.isFinite(paints[0]!)).toBe(true);
  });

  it("puts every figure in the row as text, not only in the picture", () => {
    mount();
    const first = rows()[0]!;
    const text = first.textContent ?? "";
    const top = [...week.players].sort((a, b) => b.outlook.spike - a.outlook.spike)[0]!;
    expect(text).toContain(top.name);
    expect(text).toContain(`${Math.round(top.outlook.spike * 100)} in 100`);
    expect(text).toContain(top.outlook.p50.toFixed(1));
    expect(text).toContain(top.outlook.p10.toFixed(1));
    expect(text).toContain(top.outlook.p90.toFixed(1));
    expect(text).toContain(String(SPIKE_POINTS));
  });

  it("states the rank range in the row text wherever the model will not order", () => {
    mount();
    const order = [...week.players].sort((a, b) => b.outlook.spike - a.outlook.spike);
    const ranges = rankRanges(order.map((p) => p.outlook.playerId), week.ties);
    const tied = ranges.findIndex((r) => r.lo !== r.hi);
    expect(tied).toBeGreaterThanOrEqual(0);
    const r = ranges[tied]!;
    expect(rows()[tied]!.textContent).toContain(`anywhere from ${r.lo} to ${r.hi}`);
  });

  it("moves the selection with the arrow keys and only one row is ever selected", () => {
    mount();
    const first = active();
    key("ArrowDown");
    expect(active()).not.toBe(first);
    expect(document.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
    key("ArrowUp");
    expect(active()).toBe(first);
  });

  it("jumps with Home, End and PageDown, and stops at the ends", () => {
    mount();
    key("End");
    expect(active()).toBe(rows()[rows().length - 1]!.id);
    key("ArrowDown");
    expect(active()).toBe(rows()[rows().length - 1]!.id);
    key("Home");
    expect(active()).toBe(rows()[0]!.id);
    key("PageDown");
    expect(active()).toBe(rows()[10]!.id);
  });

  it("leaves a key it does not handle to the page", () => {
    mount();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.querySelector(".stack__rows")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("is one tab stop, not one per row", () => {
    mount();
    expect(document.querySelectorAll("[tabindex]")).toHaveLength(1);
    expect(rows().some((r) => r.hasAttribute("tabindex"))).toBe(false);
  });

  it("names the selected player and its tie set in the readout", () => {
    mount();
    const readout = document.querySelector(".readout")!;
    const top = [...week.players].sort((a, b) => b.outlook.spike - a.outlook.spike)[0]!;
    expect(readout.textContent).toContain(top.name);
    expect(readout.textContent).toContain("overlaps");
    for (const reason of top.outlook.because) {
      expect(readout.textContent).toContain(reason.basis);
    }
  });

  it("filters to one position and renumbers the ranks", () => {
    mount();
    const te = [...document.querySelectorAll<HTMLButtonElement>(".controls button")].find(
      (b) => b.dataset["value"] === "TE",
    )!;
    te.click();
    const expected = week.players.filter((p) => p.position === "TE").length;
    expect(rows()).toHaveLength(expected);
    expect(rows()[0]!.textContent).toContain(`Rank 1 of ${expected}`);
  });

  it("reorders on a different sort key", () => {
    mount();
    const bySpike = rows().map((r) => r.id);
    const spread = [...document.querySelectorAll<HTMLButtonElement>(".controls button")].find(
      (b) => b.dataset["value"] === "width",
    )!;
    spread.click();
    expect(rows().map((r) => r.id)).not.toEqual(bySpike);
    expect(rows()).toHaveLength(week.players.length);
  });

  it("keeps the selected player selected across a re-sort", () => {
    mount();
    key("ArrowDown");
    key("ArrowDown");
    const chosen = active();
    const median = [...document.querySelectorAll<HTMLButtonElement>(".controls button")].find(
      (b) => b.dataset["value"] === "median",
    )!;
    median.click();
    expect(active()).toBe(chosen);
  });

  it("shows every player and every column when the numbers are asked for", () => {
    mount();
    const host = document.querySelector<HTMLElement>(".numbers--wide")!;
    expect(host.hidden).toBe(true);
    const toggle = [...document.querySelectorAll<HTMLButtonElement>(".controls button")].find(
      (b) => b.textContent === "numbers only",
    )!;
    toggle.click();
    expect(host.hidden).toBe(false);
    expect(host.querySelectorAll("tbody tr")).toHaveLength(week.players.length);
    expect(host.querySelectorAll("thead th")).toHaveLength(10);
    expect(host.textContent).toContain("could rank");
  });

  it("marks the ruler with the spike gate", () => {
    mount();
    const gate = document.querySelector(".ruler__gate");
    expect(gate?.textContent).toContain(String(SPIKE_POINTS));
  });

  it("selects the row a pointer lands on", () => {
    mount();
    rows()[4]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(active()).toBe(rows()[4]!.id);
  });
});
