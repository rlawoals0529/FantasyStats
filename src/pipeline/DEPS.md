# Dependencies this slice needs

`package.json` is outside this slice's remit, so anything that has to be added to it is listed
here instead.

## Runtime: none

Nothing in `src/pipeline/` or `scripts/refresh.ts` imports a third-party package. The whole
thing runs on the Node standard library and the global `fetch`: `node:fs`, `node:fs/promises`,
`node:path`, `node:url`, `node:crypto`, `node:zlib`, `node:process`.

That is a deliberate choice rather than an accident, and the CSV parser is where it was
decided. `papaparse` or `csv-parse` would do the job, and the job is 90 lines, of which the
part that matters is the strictness: a row whose width does not match the header is a parse
failure here, where a general-purpose parser will happily pad it or drop it. Padding a
truncated download is exactly the failure this slice exists to prevent, so the parser is ours.

The one thing worth revisiting: a season file is 8 MB and is read into memory as a string. At
four seasons in one run that is fine on any machine this will run on. If it ever needs to
process a decade at once, a streaming parser is the reason to take a dependency, and
`csv-parse/sync` is the one to take.

## Development: one addition

### `@types/node`

**Needed.** Without it `npx tsc --noEmit` cannot resolve `node:fs` and friends, and the whole
slice fails to typecheck. Add it as a dev dependency:

```
npm install --save-dev @types/node
```

It is already present in `node_modules` because it was installed to verify this slice, but it
is not recorded in `package.json`, so a fresh clone will not have it.

**No tsconfig change is needed.** `tsconfig.json` sets `"types": ["vite/client"]`, which
switches off automatic inclusion of every other `@types` package. Rather than widen that to
`["vite/client", "node"]`, which would hand `process` and `Buffer` to the browser bundle as
globals, `src/pipeline/node-env.d.ts` carries a `/// <reference types="node" />`. That scopes
the declarations to programs that include this directory, which `include: ["src"]` already
does. If somebody later adds `"node"` to the `types` array for another reason, that file
becomes redundant and can go.

## Two things already true of the repository, noted because they bit

Neither is this slice's doing and neither is fixed here, but both affect whether the commands
in the brief work on a fresh checkout.

- **`package.json` declares no dependencies at all.** `vite`, `vitest` and `typescript` are in
  `node_modules` and in the `scripts` block, but nothing records them. Any `npm install` with
  no lockfile present reconciles `node_modules` against `package.json` and prunes them, which
  takes `npm test` and `npm run typecheck` out with it. They need declaring.
- **There is no `package-lock.json`,** and `.github/workflows/ci.yml` runs `npm ci`, which
  requires one. CI cannot currently install.
