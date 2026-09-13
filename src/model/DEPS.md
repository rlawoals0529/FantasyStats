# Dependencies of the modelling slice

`package.json` is owned by another slice and is not edited from here, so anything this code
needs is written down instead.

## Runtime: none

`src/model/**` imports nothing outside the repository. No statistics library, no RNG package,
no date library. That is deliberate rather than austere - a simulator has to be reproducible
to be testable, and every dependency is a chance for a transitive bump to change a draw and
silently move every number on the page.

What that means in practice, and where to look if any of it ever needs replacing:

| Needed | Where it lives here | Why not a package |
|---|---|---|
| Seeded uniform RNG | `rng.ts`, mulberry32 | 12 lines, and a package cannot promise the same stream across versions |
| Normal variates | `rng.ts`, Box-Muller | 4 lines |
| Gamma variates | `rng.ts`, Marsaglia-Tsang with the shape < 1 boost | the shape < 1 branch is the part most libraries get right and most hand-rollings forget, so it is tested directly |
| Gamma CDF | `distribution.ts`, series plus continued fraction, with a Lanczos log-gamma | needed as an independent reference for the sampler, so it must not share code with it |
| OLS | `features.ts`, two accumulators | a single-variable fit |

## Toolchain

Not imported by the model, but needed to run what is here. None of these is currently declared
in `package.json`, so a fresh checkout has to install them before `npm test` or `npm run
backtest` will work:

| Package | Version used | What breaks without it |
|---|---|---|
| `typescript` | 5.x | `npm run typecheck` |
| `vitest` | 2.x or later | `npm test` |
| `vite` | 5.x | `tsconfig.json` lists `vite/client` in `types` |
| `@types/node` | any current | `scripts/backtest.ts` reads a file and reads `process.argv`; arrives transitively with vitest |

## Two conventions worth knowing before editing

**Relative imports carry the `.ts` extension.** `scripts/backtest.ts` is run by node directly
(`node --experimental-strip-types`), and node's resolver does not guess extensions. The
extension is what makes the same files work under both node and vitest.

**Nothing here reads the clock, the network or the filesystem.** `PlayerWeek[]` and the
pre-kickoff facts arrive as arguments. The only file read in the whole slice is the optional
`--data` argument of the backtest script, which is outside `src/model` for that reason.
