/**
 * The board: thirty-six distributions on one scale, and the keyboard path through them.
 *
 * Two rules shape everything in here.
 *
 * THE CANVAS IS NOT THE INTERFACE. It draws ink and nothing else. Every row is a real element
 * with real text in it, the list is a listbox with one tab stop, and the shapes are behind all
 * of that. A canvas-only board would be unreachable without a pointer, unreadable by a screen
 * reader, unselectable, and invisible to the contrast sweep, which are four different ways of
 * saying the same thing: a picture is not a user interface.
 *
 * THE RENDERER IS TOLD WHERE THE LANES ARE, it does not decide. Row geometry comes from
 * `getBoundingClientRect` on each row's own empty lane element, so the board is correct at any
 * width without the renderer knowing a breakpoint, and a CSS change to the row layout needs no
 * matching change here.
 */

import { fill, el, need, context2d } from "./dom.ts";
import * as fmt from "./format.ts";
import { drawStack, type Lane } from "./ridge.ts";
import { linear, sizeCanvas, ticks } from "./scales.ts";
import { rankRanges, type RankRange } from "./stats.ts";
import { readPalette, type Palette } from "./tokens.ts";
import { GRID_MAX, type PlayerEntry, type WeekBoard } from "./ports.ts";
import { SEPARABLE_OVERLAP, SPIKE_POINTS, type Position } from "../shared/player.ts";

/** The visible points window. The grid runs to 48 but almost nothing lives past 45. */
const AXIS: readonly [number, number] = [0, 45];
/** Room the gate label needs. A tick closer than this is dropped rather than overlapped. */
const GATE_LABEL_PX = 62;

type SortKey = "spike" | "median" | "width";
type Filter = "ALL" | Position;

const SORTS: readonly { key: SortKey; label: string; of: (p: PlayerEntry) => number }[] = [
  { key: "spike", label: "spike odds", of: (p) => p.outlook.spike },
  { key: "median", label: "median", of: (p) => p.outlook.p50 },
  { key: "width", label: "spread", of: (p) => p.outlook.p90 - p.outlook.p10 },
];

const POSITION_WORD: Record<Position, string> = {
  QB: "quarterback",
  RB: "running back",
  WR: "wide receiver",
  TE: "tight end",
};

export type Board = {
  /** Re-read the palette off the cascade and repaint. Called when the picker changes. */
  repaint(): void;
  /** Current lane count, so the boot sequence can assert the board is not empty. */
  readonly size: number;
  /** Last measured draw time in milliseconds, for the instrument's own readout. */
  readonly lastDrawMs: number;
};

/**
 * @param onPaint handed the draw time of each board paint, in milliseconds.
 *
 * A value rather than a bare signal, and it is a value because of a real bug. The callback
 * fires for the first time from inside this function, while the caller is still evaluating
 * the `const board = mountBoard(...)` that will hold the return, so a callback that reached
 * back through that binding threw before the page had painted once.
 */
export function mountBoard(root: HTMLElement, week: WeekBoard, onPaint: (ms: number) => void): Board {
  const canvas = need<HTMLCanvasElement>(root, ".stack__ink");
  const ctx = context2d(canvas);
  const list = need<HTMLUListElement>(root, ".stack__rows");
  const rulerTrack = need(root, ".ruler__track");
  const readout = need(root, ".readout");
  const numbersHost = need(root, ".numbers--wide");
  const controls = need(root, ".controls");

  const byId = new Map(week.players.map((p) => [p.outlook.playerId, p]));
  let sort: SortKey = "spike";
  let filter: Filter = "ALL";
  let selected = 0;
  let showNumbers = false;
  let palette: Palette = readPalette(root);
  let view: PlayerEntry[] = [];
  let ranges: RankRange[] = [];
  let lastDrawMs = 0;

  /* ---- Controls ---------------------------------------------------------------------- */

  const pressGroup = (group: Element, value: string) => {
    for (const button of group.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset["value"] === value));
    }
  };

  const sortGroup = el("div", { class: "controls__group", role: "group", "aria-label": "Order the board by" },
    SORTS.map((s) => el("button", { type: "button", "data-value": s.key, "aria-pressed": s.key === sort, text: s.label })),
  );
  const filterGroup = el("div", { class: "controls__group", role: "group", "aria-label": "Limit to one position" },
    (["ALL", "QB", "RB", "WR", "TE"] as const).map((f) =>
      el("button", { type: "button", "data-value": f, "aria-pressed": f === filter, text: f === "ALL" ? "all" : f }),
    ),
  );
  const numbersButton = el("button", {
    type: "button",
    "aria-pressed": "false",
    text: "numbers only",
  });

  fill(controls, [
    el("span", { class: "controls__label", text: "order" }),
    sortGroup,
    el("span", { class: "controls__label", text: "position" }),
    filterGroup,
    el("div", { class: "controls__group" }, [numbersButton]),
  ]);

  sortGroup.addEventListener("click", (event) => {
    const value = (event.target as HTMLElement).closest("button")?.dataset["value"];
    if (!value) return;
    sort = value as SortKey;
    pressGroup(sortGroup, sort);
    rebuild(currentId());
  });

  filterGroup.addEventListener("click", (event) => {
    const value = (event.target as HTMLElement).closest("button")?.dataset["value"];
    if (!value) return;
    filter = value as Filter;
    pressGroup(filterGroup, filter);
    rebuild(currentId());
  });

  numbersButton.addEventListener("click", () => {
    showNumbers = !showNumbers;
    numbersButton.setAttribute("aria-pressed", String(showNumbers));
    numbersButton.textContent = showNumbers ? "shapes" : "numbers only";
    numbersHost.hidden = !showNumbers;
    if (showNumbers) renderNumbers();
  });

  /* ---- Building the view -------------------------------------------------------------- */

  const currentId = (): string | null => view[selected]?.outlook.playerId ?? null;

  function rebuild(keepId: string | null = null): void {
    const sorter = SORTS.find((s) => s.key === sort) ?? SORTS[0]!;
    view = week.players
      .filter((p) => filter === "ALL" || p.position === filter)
      .sort((a, b) => sorter.of(b) - sorter.of(a));
    ranges = rankRanges(view.map((p) => p.outlook.playerId), week.ties);
    const kept = keepId === null ? -1 : view.findIndex((p) => p.outlook.playerId === keepId);
    selected = kept >= 0 ? kept : 0;
    renderRows();
    if (showNumbers) renderNumbers();
    layout();
    renderReadout();
  }

  function renderRows(): void {
    fill(
      list,
      view.map((player, i) => {
        const range = ranges[i]!;
        const o = player.outlook;
        const tiedCount = range.tiedWith.length;
        // The spoken version. Everything the shape says, in words, in the same element the
        // shape belongs to, so a screen reader gets the reading and not a description of a
        // picture of the reading.
        const spoken =
          `Rank ${range.rank} of ${view.length}. ` +
          `${player.name}, ${POSITION_WORD[player.position]}, ${player.team}` +
          `${player.opponent ? ` against ${player.opponent}` : ""}. ` +
          `${fmt.inHundred(o.spike)} chance of ${SPIKE_POINTS} points or more. ` +
          `Median ${fmt.points(o.p50)}, tenth percentile ${fmt.points(o.p10)}, ` +
          `ninetieth ${fmt.points(o.p90)}. ` +
          `${fmt.inHundred(o.bust)} chance of 5 or fewer. ` +
          (tiedCount === 0
            ? "Separable from every other player on this board."
            : `Cannot be separated from ${tiedCount} other${tiedCount === 1 ? "" : "s"}, ` +
              `so this player could rank anywhere from ${range.lo} to ${range.hi}.`);

        return el(
          "li",
          {
            class: "row",
            role: "option",
            id: `lane-${player.outlook.playerId}`,
            "aria-selected": String(i === selected),
            "data-index": String(i),
          },
          [
            el("span", { class: "row__rail", "aria-hidden": "true" }),
            el("span", { class: "row__rank fig", "aria-hidden": "true", text: String(range.rank) }),
            el("span", { class: "row__id" }, [
              el("span", { class: "row__name", "aria-hidden": "true", text: player.name }),
              el("span", {
                class: "row__meta",
                "aria-hidden": "true",
                text: `${player.position} ${player.team}${player.opponent ? ` v ${player.opponent}` : ""}`,
              }),
            ]),
            el("span", { class: "row__ink", "aria-hidden": "true" }),
            el("span", { class: "row__fig", "aria-hidden": "true" }, [
              el("span", { class: "row__spike" }, [fmt.pct(o.spike), el("i", { text: "%" })]),
              el("span", {
                class: "row__span",
                text: `${fmt.points(o.p10)} to ${fmt.points(o.p90)}`,
              }),
            ]),
            el("span", { class: "sr-only", text: spoken }),
          ],
        );
      }),
    );
    list.setAttribute("aria-activedescendant", view[selected] ? `lane-${view[selected]!.outlook.playerId}` : "");
  }

  /* ---- The readout -------------------------------------------------------------------- */

  function renderReadout(): void {
    const player = view[selected];
    const range = ranges[selected];
    if (!player || !range) {
      fill(readout, [el("p", { class: "readout__tie", text: "No player on the board matches that filter." })]);
      return;
    }
    const o = player.outlook;
    const tied = range.tiedWith.length;

    fill(readout, [
      el("div", {}, [
        el("p", { class: "readout__odds" }, [fmt.pct(o.spike), el("i", { text: `in 100` })]),
        el("p", {
          class: "readout__who",
          text: `${player.name} reaches ${SPIKE_POINTS} points`,
        }),
        el("p", {
          class: "readout__tie",
          text:
            tied === 0
              ? `Nothing else on this board overlaps this shape past ${Math.round(SEPARABLE_OVERLAP * 100)} per cent, so rank ${range.rank} is a claim the model will make.`
              : `This shape overlaps ${tied} other${tied === 1 ? "" : "s"} by ${Math.round(range.minOverlap * 100)} to ${Math.round(range.maxOverlap * 100)} per cent. Printed at ${range.rank}, it belongs anywhere from ${range.lo} to ${range.hi}, and the shaded areas on those rows are the part the model cannot tell apart.`,
        }),
        el("p", {
          class: "readout__tie",
          text: `Median ${fmt.points(o.p50)}. Middle eighty per cent of weeks land between ${fmt.points(o.p10)} and ${fmt.points(o.p90)}. ${fmt.pct(o.bust)} in 100 it finishes at 5 or fewer.`,
        }),
      ]),
      el(
        "div",
        { class: "reasons" },
        o.because.map((reason) =>
          el("div", { class: "reason" }, [
            el("span", { class: "reason__label", text: reason.label }),
            el("span", {
              class: `reason__effect ${reason.effect > 0.05 ? "up" : reason.effect < -0.05 ? "down" : ""}`,
              text: `${fmt.delta(reason.effect)} ppg`,
            }),
            el("span", { class: "reason__basis" }, [
              el("span", { class: "reason__value", text: reason.value }),
              ". ",
              reason.basis,
            ]),
          ]),
        ),
      ),
    ]);
  }

  function renderNumbers(): void {
    const head = ["rank", "player", "pos", "spike", "bust", "p10", "p50", "p90", "spread", "could rank"];
    fill(numbersHost, [
      el("table", {}, [
        el("caption", {
          text:
            "The same board with the shapes removed. Every column here is a summary of a distribution, and the last one is what the first one costs: a rank that is printed as one number and is consistent with a range of them.",
        }),
        el("thead", {}, [el("tr", {}, head.map((h) => el("th", { scope: "col", text: h })))]),
        el(
          "tbody",
          {},
          view.map((player, i) => {
            const o = player.outlook;
            const range = ranges[i]!;
            return el("tr", {}, [
              el("td", { class: "fig dim", text: String(range.rank) }),
              el("td", { text: player.name }),
              el("td", { class: "dim", text: player.position }),
              el("td", { class: "fig", text: `${fmt.pct(o.spike)}%` }),
              el("td", { class: "fig dim", text: `${fmt.pct(o.bust)}%` }),
              el("td", { class: "fig dim", text: fmt.points(o.p10) }),
              el("td", { class: "fig", text: fmt.points(o.p50) }),
              el("td", { class: "fig dim", text: fmt.points(o.p90) }),
              el("td", { class: "fig", text: fmt.points(o.p90 - o.p10) }),
              el("td", { class: "fig dim", text: range.lo === range.hi ? `${range.rank}` : `${range.lo} to ${range.hi}` }),
            ]);
          }),
        ),
      ]),
    ]);
  }

  /* ---- Layout and paint ---------------------------------------------------------------- */

  function layout(): void {
    const rows = [...list.querySelectorAll<HTMLElement>(".row")];
    if (rows.length === 0) return;
    const host = list.getBoundingClientRect();
    const width = Math.max(1, Math.round(host.width));
    const height = Math.max(1, Math.round(host.height));
    const size = sizeCanvas(canvas, ctx, width, height, window.devicePixelRatio);

    const lanes: Lane[] = [];
    let inkLeft = 0;
    let inkWidth = 0;
    for (let i = 0; i < rows.length; i++) {
      const player = view[i];
      const range = ranges[i];
      if (!player || !range) continue;
      const ink = rows[i]!.querySelector<HTMLElement>(".row__ink");
      if (!ink) continue;
      const r = ink.getBoundingClientRect();
      inkLeft = r.left - host.left;
      inkWidth = r.width;
      lanes.push({
        id: player.outlook.playerId,
        x: r.left - host.left,
        y: r.top - host.top,
        w: r.width,
        h: r.height,
        density: player.density,
        p10: player.outlook.p10,
        p50: player.outlook.p50,
        p90: player.outlook.p90,
        // Row 0 has nothing above it, so it is separable by definition rather than by
        // measurement. Anything else would put a dangling tie mark at the top of the board.
        separableFromAbove: i === 0 || !ranges[i]!.tiedWith.includes(view[i - 1]!.outlook.playerId),
        lo: range.lo - 1,
        hi: range.hi - 1,
      });
    }
    if (lanes.length === 0) return;

    // The rail is the same column on every row, so one row is enough to place it.
    const railEl = rows[0]!.querySelector<HTMLElement>(".row__rail");
    const railRect = railEl ? railEl.getBoundingClientRect() : new DOMRect(host.left, host.top, 0, 0);
    const scale = linear(AXIS, [inkLeft, inkLeft + inkWidth]);

    const t0 = performance.now();
    drawStack(
      ctx,
      palette,
      {
        lanes,
        selected,
        tiedTo: new Set(ranges[selected]?.tiedWith ?? []),
        gate: SPIKE_POINTS,
        railX: railRect.left - host.left,
        railW: railRect.width,
      },
      scale,
      size.width,
      size.height,
    );
    lastDrawMs = performance.now() - t0;
    onPaint(lastDrawMs);

    renderRuler(inkLeft, inkWidth);
  }

  function renderRuler(inkLeft: number, inkWidth: number): void {
    const rulerBox = rulerTrack.parentElement!.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    const offset = listBox.left - rulerBox.left + inkLeft;
    (rulerTrack as HTMLElement).style.marginLeft = `${Math.round(offset)}px`;
    (rulerTrack as HTMLElement).style.width = `${Math.round(inkWidth)}px`;

    const scale = linear(AXIS, [0, inkWidth]);
    // Fewer ticks on a narrow ruler, because a label every 5 points at 300px overlaps into an
    // unreadable smear and the ruler is the one thing on this page that must stay readable.
    const wanted = inkWidth < 320 ? 3 : inkWidth < 560 ? 5 : 9;
    // Dropped by PIXEL distance, not by points. At 45 points across a 250px phone ruler a
    // five-point gap is 28px and the gate label lands on the next number; at 960px the same gap
    // is 107px and nothing collides. Filtering on the points value gets one of those two wrong.
    const gatePx = scale.at(SPIKE_POINTS);
    const marks = ticks(AXIS[0], Math.min(AXIS[1], GRID_MAX), wanted).filter(
      (t) => Math.abs(scale.at(t) - gatePx) > GATE_LABEL_PX,
    );
    fill(rulerTrack, [
      ...marks.map((t) =>
        el("span", { class: "ruler__tick", style: `left:${scale.at(t)}px` }, [
          el("span", { class: "fig", text: String(t) }),
        ]),
      ),
      el("span", { class: "ruler__gate", style: `left:${gatePx}px` }, [
        el("span", { text: `${SPIKE_POINTS} spike` }),
      ]),
    ]);
  }

  /* ---- Selection ------------------------------------------------------------------------ */

  function select(next: number): void {
    const clamped = Math.max(0, Math.min(view.length - 1, next));
    if (clamped === selected) return;
    const previous = list.querySelector('[aria-selected="true"]');
    if (previous) previous.setAttribute("aria-selected", "false");
    selected = clamped;
    const node = list.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    if (node) {
      node.setAttribute("aria-selected", "true");
      list.setAttribute("aria-activedescendant", node.id);
      node.scrollIntoView({ block: "nearest" });
    }
    renderReadout();
    layout();
  }

  list.addEventListener("click", (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(".row");
    if (!row) return;
    list.focus();
    select(Number(row.dataset["index"] ?? 0));
  });

  /*
   * One tab stop for the whole board, and the arrows move inside it.
   *
   * Thirty-six focusable rows would put thirty-six stops between the board and the simulator,
   * which is the standard way a keyboard-accessible page becomes a keyboard-hostile one.
   */
  list.addEventListener("keydown", (event) => {
    const jump = 10;
    const moves: Record<string, number> = {
      ArrowDown: selected + 1,
      ArrowUp: selected - 1,
      PageDown: selected + jump,
      PageUp: selected - jump,
      Home: 0,
      End: view.length - 1,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  });

  /* ---- Wiring -------------------------------------------------------------------------- */

  const observer = new ResizeObserver(() => layout());
  observer.observe(list);

  rebuild();

  return {
    repaint() {
      palette = readPalette(root);
      layout();
    },
    get size() {
      return view.length;
    },
    get lastDrawMs() {
      return lastDrawMs;
    },
  };
}
