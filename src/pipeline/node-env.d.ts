/**
 * Pulls Node's own type declarations into the program for this slice.
 *
 * `tsconfig.json` sets `"types": ["vite/client"]`, which switches off automatic inclusion of
 * every other `@types` package. That is correct for the browser bundle, where `node:fs` has no
 * business resolving, and wrong for this directory and for `scripts/refresh.ts`, which are the
 * two places that run under Node.
 *
 * A triple-slash reference is the way to say so without editing the shared tsconfig: it scopes
 * the declarations to a program that includes this file, which `include: ["src"]` already does.
 * The alternative is `"types": ["vite/client", "node"]`, which would hand `process` and
 * `Buffer` to the UI as globals as well, and the UI should not compile against them.
 *
 * `@types/node` is a dev dependency this slice needs. See `DEPS.md`.
 */

/// <reference types="node" />
