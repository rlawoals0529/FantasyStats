/**
 * The instrument's chrome: a fixed rail across the top of the page.
 *
 * There is no hero on this page and no heading anybody scrolls past. What sits above the board
 * is a status strip, and a status strip earns the space it takes by REPORTING: the week under
 * test, the player the reader currently has selected, and where the matchup simulation has got
 * to. The last two update in place as the reader arrows down the board and as the ten thousand
 * runs land, so the top of the page is never stale and never decorative.
 *
 * A READING IS A FIGURE, A UNIT AND OPTIONALLY A NAME, in that order and never bare. The figure
 * is the only part set in --fg, which is what makes the rail scan as three numbers rather than
 * as a sentence. The name is the part that does not fit on a phone and it is the part the page
 * repeats twice below, in the selected row and in the readout, so it is the part that drops.
 *
 * It also owns one number the rest of the layout depends on.
 *
 * `--rail-h` IS MEASURED, NOT ASSUMED. The rail is `position: fixed`, so it is out of flow and
 * everything underneath has to be placed against its height by hand: the sheet's top padding,
 * the sticky ruler's `top`, the scroll margin that stops an arrow keypress parking the active
 * row underneath it, and where the skip link lands when it is focused. The rail wraps to three
 * rows below 700px, so a constant in the stylesheet is correct on a desktop and about fifty
 * pixels wrong on a phone, which is exactly the width where the ruler is hardest to get back.
 * So the height is read off the box and written to the root, and a ResizeObserver keeps it true
 * through a rotation or a font swapping in late.
 *
 * A zero is never written. jsdom reports every box as zero by zero, and a page that had briefly
 * set `--rail-h: 0px` would put the ruler back under the rail for anyone whose first paint
 * happened to land there. Zero means "not measurable", and the stylesheet's own fallback is a
 * better answer than a measurement that cannot be true.
 */

import { el, fill, need } from "./dom.ts";

/** One live reading on the rail. */
export type Channel = "week" | "sel" | "sim";

/** What a channel currently says. `unit` and `who` are --dim; only `value` is --fg. */
export type Reading = {
  readonly value: string;
  readonly unit?: string;
  /** The thing being measured, shown only where there is room for it. */
  readonly who?: string;
};

export type Rail = {
  set(channel: Channel, reading: Reading): void;
  /** Re-measure and publish `--rail-h`. Returns the height written, or 0 if it wrote nothing. */
  measure(): number;
};

const KEYS: readonly { id: Channel; key: string }[] = [
  { id: "week", key: "week" },
  { id: "sel", key: "selected" },
  { id: "sim", key: "matchup" },
];

type Cell = { who: HTMLElement; value: HTMLElement; unit: HTMLElement };

/**
 * @param rail the fixed `<header class="rail">` itself, because the height being published is
 * the whole rail's and not the channel strip's.
 */
export function mountRail(rail: HTMLElement): Rail {
  const host = need(rail, ".rail__chans");
  const cells = new Map<Channel, Cell>();

  fill(
    host,
    KEYS.map(({ id, key }) => {
      const cell: Cell = {
        who: el("span", { class: "rail__who" }),
        value: el("b", { class: "rail__val fig" }),
        unit: el("span", { class: "rail__unit" }),
      };
      cells.set(id, cell);
      return el("div", { class: "rail__ch", "data-channel": id }, [
        el("span", { class: "rail__key", text: key }),
        cell.who,
        cell.value,
        cell.unit,
      ]);
    }),
  );

  function measure(): number {
    const height = Math.ceil(rail.getBoundingClientRect().height);
    if (height <= 0) return 0;
    document.documentElement.style.setProperty("--rail-h", `${height}px`);
    return height;
  }

  if (typeof ResizeObserver === "function") new ResizeObserver(() => measure()).observe(rail);
  measure();

  return {
    set(channel, reading) {
      const cell = cells.get(channel);
      if (!cell) return;
      cell.who.textContent = reading.who ?? "";
      cell.value.textContent = reading.value;
      cell.unit.textContent = reading.unit ?? "";
    },
    measure,
  };
}
