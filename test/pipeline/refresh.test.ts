/**
 * The gates on the entry point itself.
 *
 * `refresh.ts` runs unattended. Everything it can get wrong, it gets wrong at three in the
 * morning with nobody watching, so the two decisions it makes on its own are tested here: which
 * season it thinks is being played, and whether it is willing to publish a smaller season than
 * the one already on disk.
 *
 * The second is the gate that closes the hole the row floors leave open. A floor catches a
 * file that arrived tiny. It does not catch one that arrived large and a week short.
 */

import { describe, expect, it } from "vitest";

import { assertNotShrinking, type PublishedSummary } from "../../src/pipeline/publish.ts";
import { currentSeason } from "../../scripts/refresh.ts";

describe("which season is being played", () => {
  it("is this year once September has started", () => {
    expect(currentSeason(new Date("2026-09-12T12:00:00Z"))).toBe(2026);
    expect(currentSeason(new Date("2026-12-31T12:00:00Z"))).toBe(2026);
  });

  it("is last year in January, when the season is still running", () => {
    // Getting this wrong in January has the job asking for a season that does not exist and
    // failing on a 404, which is at least loud, but it would also skip every January refresh.
    expect(currentSeason(new Date("2027-01-04T12:00:00Z"))).toBe(2026);
    expect(currentSeason(new Date("2027-02-08T12:00:00Z"))).toBe(2026);
  });

  it("is last year through the summer, when nothing is being played", () => {
    expect(currentSeason(new Date("2027-08-31T12:00:00Z"))).toBe(2026);
  });
});

describe("the shrink guard", () => {
  const published = (rowCount: number): PublishedSummary => ({ hash: "abc123", rowCount });

  it("allows a first run, where there is nothing to compare against", () => {
    expect(() => assertNotShrinking(2026, 47, null, false)).not.toThrow();
  });

  it("allows a season that has grown, which is what a normal week looks like", () => {
    expect(() => assertNotShrinking(2026, 400, published(350), false)).not.toThrow();
  });

  it("allows an unchanged season", () => {
    expect(() => assertNotShrinking(2026, 350, published(350), false)).not.toThrow();
  });

  it("stops a season that has lost rows", () => {
    // The scenario: one of the four feeds came back a week short. Everything parsed, every
    // floor was cleared, and publishing would delete a week of a live dataset.
    expect(() => assertNotShrinking(2026, 300, published(350), false)).toThrow(
      /rebuilt 300 rows against 350 already published/,
    );
  });

  it("stops a season that has lost everything", () => {
    expect(() => assertNotShrinking(2026, 0, published(5864), false)).toThrow(/A season does not lose weeks/);
  });

  it("stops it for one row, because there is no safe size of loss", () => {
    expect(() => assertNotShrinking(2026, 349, published(350), false)).toThrow();
  });

  it("gives way to an explicit --allow-shrink, and only to that", () => {
    // Upstream does occasionally retract rows. The escape hatch is a flag a person typed,
    // not a heuristic about how much loss looks reasonable.
    expect(() => assertNotShrinking(2026, 0, published(5864), true)).not.toThrow();
  });

  it("says what to do about it in the message", () => {
    expect(() => assertNotShrinking(2026, 300, published(350), false)).toThrow(/--allow-shrink/);
    expect(() => assertNotShrinking(2026, 300, published(350), false)).toThrow(/Not writing/);
  });
});
