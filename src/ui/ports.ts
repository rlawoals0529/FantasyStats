/**
 * What this interface needs from the slices it does not own.
 *
 * Nothing under `src/ui/` imports the pipeline or the simulator. It imports this file, and one
 * adapter per producer fills it in. That is the whole integration surface: when the other two
 * slices land, `src/ui/fixtures/` is deleted and `main.ts` is handed a real `DataSource` and a
 * real `SimulatorFactory` instead of the generated ones. No panel changes.
 *
 * Two decisions here are load-bearing and worth stating before somebody softens them.
 *
 * **Every density is sampled on one shared grid.** Not "a curve per player at whatever
 * resolution suited the producer". The page's entire argument is that two shapes can be
 * compared by eye, and two shapes are only comparable if they are drawn against the same
 * ruler. A per-player grid would have to be resampled here, at which point the resampling is
 * the thing that decides whether a pair looks tied, and that decision does not belong in a
 * renderer. `POINTS_GRID` is the ruler and the producer meets it.
 *
 * **The simulator hands back buffers, not events.** A producer that pushes results on its own
 * clock owns the frame rate, and then reduced-motion and a 400px phone are its problem rather
 * than this file's. Instead the UI pulls: it asks for as many draws as this frame can afford,
 * and reads the totals straight out of the arrays the simulator is filling. Zero copies, and
 * the render loop stays where the render budget is measured.
 */

import type { Outlook, Position, Reason, Tie } from "../shared/player.ts";

/* ---- The shared ruler --------------------------------------------------------------- */

/** Lowest points value any density is sampled at. Scores below zero happen and are kept. */
export const GRID_MIN = -4;
/** Highest. 48 PPR is past the 99.9th percentile of any weekly outcome in four seasons. */
export const GRID_MAX = 48;
/** Spacing between samples, in points. */
export const GRID_STEP = 0.25;
/** Number of samples in every `density` array on this port. */
export const GRID_SIZE = Math.round((GRID_MAX - GRID_MIN) / GRID_STEP) + 1;

/** The points value each index of a density array stands for. */
export const gridPoints = (i: number): number => GRID_MIN + i * GRID_STEP;

/** Nearest grid index to a points value, clamped into the grid. */
export const gridIndex = (points: number): number =>
  Math.max(0, Math.min(GRID_SIZE - 1, Math.round((points - GRID_MIN) / GRID_STEP)));

/* ---- What the pipeline produces ------------------------------------------------------ */

/**
 * One player, ready to draw.
 *
 * `outlook` is the contract from `src/shared/player.ts` and is not restated here. `density` is
 * the same distribution those quantiles came out of, which is the part a number cannot carry:
 * p10/p50/p90 describe a shape only if you already assume which shape, and the assumption is
 * exactly what this page refuses to make on the reader's behalf.
 */
export type PlayerEntry = {
  readonly outlook: Outlook;
  readonly name: string;
  readonly position: Position;
  readonly team: string;
  /** Who they play this week, for the header line. `null` on a bye. */
  readonly opponent: string | null;
  /**
   * Probability density over `POINTS_GRID`, length `GRID_SIZE`, integrating to 1 across it.
   * Not counts, and not normalised to a peak of 1: area is what the page compares, so area is
   * what crosses the port.
   */
  readonly density: Float64Array;
  /** Opportunity as measured, for the detail readout. `null` where the feed had nothing. */
  readonly targetShare: number | null;
  readonly wopr: number | null;
  readonly snapShare: number | null;
  /** Vegas implied team total. Predicts spikes rather than means, 3.5% under 17 against 10.1% at 26+. */
  readonly impliedTotal: number | null;
};

/** Production minus what that opportunity usually buys. The buy-low and sell-high list. */
export type RegressionEntry = {
  readonly playerId: string;
  /**
   * Points per game above or below the opportunity's expectation, signed. Positive is
   * over-performing and therefore a sell.
   */
  readonly gap: number;
  /** Touchdown rate against expectation, in ppg, signed. Stickiness 0.453, so this decays. */
  readonly touchdownGap: number;
  /** The measured effect sizes behind the two figures above. */
  readonly because: readonly Reason[];
};

/**
 * One bucket of the model's own scorecard.
 *
 * The page claims a spike probability and then grades it. A bucket where `predicted` is 0.30
 * and `realised` is 0.11 is a miss, and it is shown as one.
 */
export type ScorecardBucket = {
  /** Mid-point of the claimed-probability bucket, 0 to 1. */
  readonly predicted: number;
  /** Share of those player-weeks that actually spiked, 0 to 1. */
  readonly realised: number;
  /** Player-weeks in the bucket. A bucket of nine says nothing and is drawn small. */
  readonly n: number;
};

/** Everything one week needs. One fetch, one object. */
export type WeekBoard = {
  readonly season: number;
  readonly week: number;
  /** ISO timestamp of the run that produced this. Shown, because staleness is a real risk. */
  readonly generatedAt: string;
  readonly players: readonly PlayerEntry[];
  /**
   * Pairs the model refuses to order. Produced upstream rather than re-derived here: the
   * threshold is `SEPARABLE_OVERLAP` and one implementation of it is enough. The renderer
   * checks its own arithmetic against this list in the unit suite and would rather fail than
   * quietly disagree with the pipeline about who is tied.
   */
  readonly ties: readonly Tie[];
  readonly regression: readonly RegressionEntry[];
  readonly scorecard: readonly ScorecardBucket[];
  /** How well the model did last week, in one sentence with its numbers. */
  readonly scorecardNote: string;
};

/** The pipeline seam. One method, because a week is one object. */
export type DataSource = {
  load(): Promise<WeekBoard>;
};

/* ---- What the simulator produces ----------------------------------------------------- */

export type MatchupSpec = {
  /** Player ids in your lineup. Order is irrelevant; the total is a sum. */
  readonly mine: readonly string[];
  readonly theirs: readonly string[];
  /** Matchups to simulate. The page asks for 10,000. */
  readonly runs: number;
  /** Same seed, same clouds. A page whose picture changes on reload cannot be talked about. */
  readonly seed: number;
};

/**
 * A simulation in progress, pulled rather than pushed.
 *
 * `mine` and `theirs` are allocated once at `runs` length and filled in place. Reading index
 * `i < drawn` is defined; past that it is whatever zero the allocation gave. The renderer only
 * ever reads the drawn prefix.
 */
export type MatchupSimulator = {
  readonly runs: number;
  /** How many matchups have been drawn so far. */
  readonly drawn: number;
  /** Your lineup's total in each drawn matchup. */
  readonly mine: Float64Array;
  /** Theirs. */
  readonly theirs: Float64Array;
  /**
   * Draw up to `count` more matchups. Returns how many were actually drawn, which is less than
   * `count` at the end of the run and zero once `drawn === runs`.
   */
  draw(count: number): number;
};

export type SimulatorFactory = (spec: MatchupSpec) => MatchupSimulator;

/** Everything the page is handed at boot. `main.ts` is the only file that builds one. */
export type Wiring = {
  readonly data: DataSource;
  readonly simulate: SimulatorFactory;
};
