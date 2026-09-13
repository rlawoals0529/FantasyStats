/**
 * The buy-low and sell-high list, with its effect sizes attached.
 *
 * A diverging bar from a centre line, because the quantity genuinely has a sign and a zero: a
 * player is scoring above or below what their opportunity usually buys, and nought is the
 * interesting value. Drawn in the DOM rather than on a canvas, because ten bars is ten divs and
 * a canvas here would be a second rendering path to keep in step with the palette for no gain.
 *
 * Sign is carried by --ok and --err rather than by colour alone: the bar's side of the centre
 * line says it first, and the signed figure beside it says it in text. Both clear 4.8:1 on --bg
 * on every palette, so the figures are readable even where the bars are not distinguishable.
 */

import { el, fill } from "./dom.ts";
import * as fmt from "./format.ts";
import type { WeekBoard } from "./ports.ts";

export function mountRegression(host: HTMLElement, board: WeekBoard): void {
  const byId = new Map(board.players.map((p) => [p.outlook.playerId, p]));
  const widest = board.regression.reduce((m, r) => Math.max(m, Math.abs(r.gap)), 0.1);

  fill(
    host,
    board.regression.map((entry) => {
      const player = byId.get(entry.playerId);
      if (!player) return null;
      const sell = entry.gap > 0;
      const width = (Math.abs(entry.gap) / widest) * 50;
      const spoken =
        `${player.name}, ${player.position}. ` +
        `${sell ? "Scoring above" : "Scoring below"} what this opportunity usually buys, ` +
        `by ${fmt.points(Math.abs(entry.gap))} points per game. ` +
        `Touchdown rate ${fmt.delta(entry.touchdownGap)} against expectation. ` +
        entry.because.map((r) => `${r.label}: ${r.basis}.`).join(" ");

      return el("div", { class: "regress__row" }, [
        el("div", { class: "regress__who", "aria-hidden": "true" }, [
          player.name,
          el("span", { text: `${player.position} ${player.team}` }),
        ]),
        el("div", { class: "regress__bar", "aria-hidden": "true" }, [
          el("span", {
            class: `regress__fill ${sell ? "sell" : "buy"}`,
            style: sell ? `left:50%;width:${width}%` : `right:50%;width:${width}%`,
          }),
        ]),
        el("div", { class: "regress__val", "aria-hidden": "true" }, [
          `${fmt.delta(entry.gap)}`,
          el("span", { text: sell ? "sell" : "buy" }),
        ]),
        el("span", { class: "sr-only", text: spoken }),
      ]);
    }),
  );
}
