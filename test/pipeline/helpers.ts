/**
 * Fixture loading, shared by the suite.
 *
 * Fixtures are read through the same `parseCsv` the pipeline uses rather than through a test
 * only reader. A parser bug that hid behind a second implementation here would be a parser bug
 * the suite could not see.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCsv, type Table } from "../../src/pipeline/csv.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

export function fixture(name: string): Table {
  return parseCsv(fixtureText(name));
}
