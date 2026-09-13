/**
 * The three lines of DOM plumbing every panel here needs, written once.
 *
 * Not a framework and not the beginning of one. What this page updates is a handful of text
 * nodes and one attribute per row, and reconciliation for that is a dependency, a build step
 * and a second mental model in exchange for nothing.
 */

type Attrs = Record<string, string | number | boolean | null | undefined>;

/** An element with attributes and children in one call. `false` and `null` drop an attribute. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** Replace an element's children in one go. */
export function fill(host: Element, children: (Node | string | null | undefined)[]): void {
  host.replaceChildren(...children.filter((c): c is Node | string => c !== null && c !== undefined));
}

/** Query, and say which selector failed rather than handing back a null to trip over later. */
export function need<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`spike: no element matches ${selector}`);
  return found;
}

/**
 * A 2D context, or a thrown error naming the canvas.
 *
 * `getContext` returns null on a browser with canvas disabled and in a few test environments.
 * Every caller here would immediately dereference it, so the useful place to fail is at the
 * call rather than eleven frames into a paint.
 */
export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("spike: this browser gave no 2D context");
  return ctx;
}

/** Whether the reader has asked for less motion. Read per use, because it can change live. */
export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
