# src/ui dependencies

**Runtime: none.** Nothing in this directory adds a package to `package.json`. The interface is
plain TypeScript against the DOM and the 2D canvas, styled with the vendored yozora tokens.

That is a decision, not an omission. What a framework buys is reconciliation, and what this page
updates is a handful of text nodes plus one attribute per row. What it costs is the thing the
page is: thirty-six canvas lanes and a ten thousand point scatter that already own the frame
budget, sharing a tab with a virtual DOM diff for a list that changes when you press an arrow
key. The shipped bundle is about 41 kB, 15 kB gzipped, including the fixtures.

## Build and test tooling

These are the four packages the existing `package.json` scripts already assume. None of them was
added by this slice, and none is imported by shipped code.

| Package | What for |
| --- | --- |
| `vite` | `npm run dev` and `npm run build`. Zero config: `index.html` at the root is the entry |
| `typescript` | `npm run typecheck` |
| `vitest` | `npm test` |
| `jsdom` | the environment for `test/ui/board.test.ts` and `test/ui/ridge.test.ts` |

`jsdom` is selected per file with a `/** @vitest-environment jsdom */` docblock rather than
through a config file, because a `vite.config.ts` or `vitest.config.ts` at the repository root
is outside this slice's boundary and another slice may want to own it.

**One thing to hand over: `jsdom` is not in `package.json`.** This slice may not edit that file,
and the `devDependencies` block another slice added lists `vite`, `vitest`, `typescript` and
`@types/node` but not `jsdom`. On a fresh `npm ci`, `test/ui/board.test.ts` and
`test/ui/ridge.test.ts` will fail to start with `Cannot find package 'jsdom'` rather than fail
with a diagnosis, so it needs adding by whoever owns that file. Locally it is installed with
`npm install --no-save jsdom`, which is how this slice was verified.

## What it uses that it did not write

| Path | What for |
| --- | --- |
| `src/shared/player.ts` | `Outlook`, `Reason`, `Tie`, `SPIKE_POINTS`, `BUST_POINTS`, `SEPARABLE_OVERLAP` |
| `src/lib/theme.ts` | `DEFAULT_THEME` and `createThemeStore`, for the palette picker |
| `src/theme/palettes.css` | all fifteen palettes, scoped to `[data-theme]` |
| `src/theme/palettes.json` | the manifest the picker renders from |
| `src/theme/base.css`, `type.css`, `layout-flat.css`, `motion.css`, `texture.css` | structure, the Fraunces and Chivo pairing, and the no-cards layer |
| `e2e/contrast-probe.ts` | the browser sweep reads composited computed styles with this |

All of those are vendored or shared and are **never edited here**. `test/ui/guards.test.ts`
fails if anything under `src/ui/` imports outside `src/ui`, `src/shared`, `src/lib` or
`src/theme`.

The palette manifest is imported as JSON, which works because this project's `tsconfig.json`
sets `resolveJsonModule`. A project without it would need vite's `?raw` suffix and a parse.

## The seam to the other two slices

Nothing here imports the pipeline or the simulator. `src/ui/ports.ts` states what this interface
needs from each of them, and `src/ui/fixtures/` is a complete implementation of that contract
built out of the spread ladder measured in `docs/CONCEPT.md`.

Integration is **one file**. `src/ui/main.ts` has three marked lines:

```ts
import { fixtureBoard, fixtureData, fixtureSimulator } from "./fixtures/generate.ts";
const wiring: Wiring = { data: fixtureData(), simulate: fixtureSimulator(fixtureBoard()) };
```

Replace those with the real `DataSource` and `SimulatorFactory`, delete `src/ui/fixtures/`, and
no panel changes. A test enforces that no other module in this directory imports the fixtures,
so the deletion cannot leave a dangling reference.

Two things the port asks for that are worth agreeing on before they are built:

- **Every density on one grid.** `GRID_MIN` to `GRID_MAX` at `GRID_STEP`, 209 samples. Not a
  per-player resolution that this side resamples, because the resampling would then be what
  decides whether a pair looks tied, and that decision does not belong in a renderer. `main.ts`
  refuses to boot on a density of the wrong length rather than drawing a quietly squashed curve.
- **`ties` is every pair past the threshold, not only adjacent ones.** The case the page exists
  to show is the seventh and the eleventh being indistinguishable, and that pair is three rows
  from being adjacent. A producer that reports only neighbours silently narrows every rank range
  on the board.

The simulator is **pulled, not pushed**: `draw(count)` fills buffers the simulator owns and the
UI reads. A producer that emitted on its own clock would own the frame rate, and reduced motion
and a 400px phone would become its problem rather than this file's.

## Dev-only, for the two browser scripts

| Package | Why | Needed by |
| --- | --- | --- |
| `playwright` | drives a real Chromium, so contrast is measured from composited computed styles and the keyboard is exercised through real focus | `e2e/contrast-sweep.mjs`, `e2e/interaction.mjs` |

**Not added to `package.json`,** because `npm test` and `npm run typecheck` must stay green on a
checkout that has never downloaded a browser. The scripts are run on demand and told where an
install lives:

```
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
  node --experimental-strip-types e2e/contrast-sweep.mjs
PLAYWRIGHT_MODULE=... node --experimental-strip-types e2e/contrast-sweep.mjs --self-test
PLAYWRIGHT_MODULE=... node --experimental-strip-types e2e/interaction.mjs
```

`--experimental-strip-types` is needed because `contrast-probe.ts` is vendored TypeScript and is
imported directly rather than built.

Each script stands up its own vite dev server on a port of its own and stops it afterwards.
Nothing in `src/ui/` knows they exist, with one deliberate exception: `window.__spike` is a
frozen, read-only window on the page's own frame meter and lane count. It exposes measurements
and offers no way to inject a player, a draw or a palette, because a test hook that can
fabricate data is a route by which the shipped page could show something the pipeline never
produced, and that is the one thing this project cannot have.

## The two contrast checks, and why both

`test/ui/contrast.test.ts` grades the token pairings this interface claims to use, across all
fifteen palettes, in milliseconds with no browser. `e2e/contrast-sweep.mjs` measures where those
colours actually landed, in six distinct page states, with the full ancestor stack composited.

Neither replaces the other, and the sweep has already earned its place: it found a ruler tick
label sitting inside its own one-pixel `--edge` line at 2.01:1, and the spike gate's label
inside the `--accent-text` rule at 1.00:1. Both are invisible to the eye, because the labels
overflow a one-pixel box, and both are real: an overflowing child is not something a contrast
measurement can see through. Neither is a pairing a token file could have known about.

`--self-test` plants a `color-mix` at about 2:1 in every state and requires the sweep to report
it. It exits 0 when the plant was caught and 1 when it was not, which is the opposite sense to
a normal run and is the point: it grades the check rather than the page. A check nobody has
watched fail is a check nobody knows works, and this one has a specific way of failing open.
The probe walks ancestors for an opaque ground, so a page that changed its layering could have
every reading measured against the wrong surface and still come back clean.
