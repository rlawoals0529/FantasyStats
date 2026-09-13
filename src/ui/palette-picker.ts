/**
 * The palette picker.
 *
 * Fifteen palettes, grouped night then day, applied by one attribute on the root because
 * `palettes.css` is scoped to `[data-theme]`. The store is `src/lib/theme.ts`, vendored and
 * never edited, which is also where `DEFAULT_THEME` lives: retyping that string is how two
 * other projects shipped opening on the wrong palette.
 *
 * A native `<select>` on purpose. A custom listbox here would be a second focus-management
 * implementation to get wrong, for a control that is used once.
 */

import { el, fill } from "./dom.ts";
import { createThemeStore, grouped, DEFAULT_THEME, type Theme } from "../lib/theme.ts";
import manifest from "../theme/palettes.json";

const THEMES = manifest as Theme[];

export type Picker = { current(): string };

/**
 * @param onChange run after the attribute is set, so canvases can re-read the cascade. Canvas
 * colours are copied out of `getComputedStyle` at paint time and nothing repaints them: without
 * this, the DOM changes palette and every picture stays in the old one.
 */
export function mountPicker(host: HTMLElement, onChange: (id: string) => void): Picker {
  const store = createThemeStore(THEMES, DEFAULT_THEME);
  let current = store.apply(store.initial());

  const select = el("select", { "aria-label": "Colour palette" });
  for (const group of grouped(THEMES)) {
    select.appendChild(
      el(
        "optgroup",
        { label: group.label },
        group.themes.map((t) =>
          el("option", { value: t.id, selected: t.id === current, text: t.label }),
        ),
      ),
    );
  }

  select.addEventListener("change", () => {
    current = store.apply(select.value);
    onChange(current);
  });

  fill(host, [select]);
  return { current: () => current };
}
