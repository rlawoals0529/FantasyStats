/**
 * The scorecard. Run it with `npm run backtest`.
 *
 * This is the part of the project that makes the rest of it worth believing. A model that
 * reports odds has exactly one obligation - that when it says 20 per cent, it happens about 20
 * per cent of the time - and this is where that gets checked, on weeks the model had not seen,
 * with every feature cut at the week before.
 *
 * It also reports the thing a projections site would bury: RMSE and MAE against the player's
 * season average to date. The measured expectation is that the model does NOT beat it. That is
 * not a bug to be fixed before shipping, it is the finding, and printing it is the point.
 *
 * DATA. Pass `--data <file.json>` with `{ weeks, touchdowns, kickoffs }` and it grades those.
 * With no file it builds a seeded synthetic league and says so, loudly, on every run. The
 * synthetic league is not a stand-in for a result: it exercises the machinery end to end and
 * nothing it prints is a measurement of this model against football.
 */

import { readFileSync } from "node:fs";
import {
  calibrationError,
  errorMetrics,
  reliability,
  spikeLiftByDecile,
  walkForward,
  type Graded,
} from "../src/model/backtest.ts";
import {
  BASELINE_MAE,
  BASELINE_RMSE,
  IMPLIED_TOTAL_HIGH,
  IMPLIED_TOTAL_LOW,
  SPIKE_POINTS,
  type InjuryDesignation,
  type KickoffFacts,
  type PlayerWeek,
  type Position,
  type TouchdownWeek,
} from "../src/model/index.ts";
import { mulberry32, standardNormal, type Rng } from "../src/model/rng.ts";

export type League = {
  weeks: PlayerWeek[];
  touchdowns: TouchdownWeek[];
  kickoffs: KickoffFacts[];
};

// ---------------------------------------------------------------------------------------------
// The synthetic league, used only when no real data is passed.
// ---------------------------------------------------------------------------------------------

const SYNTHETIC_SEASON = 2024;
const SYNTHETIC_WEEKS = 17;
const SYNTHETIC_PLAYERS = 220;
const POSITIONS: readonly Position[] = ["QB", "RB", "WR", "TE"];

/**
 * A league whose truth is deliberately NOT the model's own family.
 *
 * Weekly points here are zero-inflated lognormal with a mean that drifts through the season.
 * The model draws gamma from a flat within-season mean. That mismatch is the entire value of
 * this generator: a synthetic league drawn from the model's own assumptions would report perfect
 * calibration and would be testing nothing but the arithmetic.
 *
 * What it does keep is the measured relationship between a player's mean and their spread,
 * because that is an established measurement about football rather than an assumption of this
 * model, and a harness that threw it away would be grading against a different sport.
 *
 * The Vegas line is given real signal - a high implied total genuinely widens that week - so the
 * decile table has something to find. The injury designation is given a real cost of about a
 * point, and is applied to good players more often than to bad ones, which reproduces the
 * selection effect that makes the raw injury number come out backwards.
 */
/** Size overrides, so a test can exercise the same generator without a 30-second walk. */
export type SyntheticOptions = { players?: number; weeks?: number };

export function syntheticLeague(seed = 20240901, options: SyntheticOptions = {}): League {
  const playerCount = options.players ?? SYNTHETIC_PLAYERS;
  const weekCount = options.weeks ?? SYNTHETIC_WEEKS;
  const rng = mulberry32(seed);
  const weeks: PlayerWeek[] = [];
  const touchdowns: TouchdownWeek[] = [];
  const kickoffs: KickoffFacts[] = [];

  const teams = Array.from({ length: 32 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`);
  const players = Array.from({ length: playerCount }, (_, i) => {
    // Exponential-ish talent, so most of the league is replacement level and a few are not.
    const trueMean = 1.5 + 18 * Math.pow(rng(), 2.1);
    return {
      playerId: `P${String(i + 1).padStart(3, "0")}`,
      name: `Player ${i + 1}`,
      position: POSITIONS[i % POSITIONS.length] ?? "WR",
      team: teams[i % teams.length] ?? "T01",
      trueMean,
      // Within-season drift: roles change, and a flat season mean is one of the model's lies.
      drift: (rng() - 0.5) * 0.12,
      opportunity: clamp(trueMean / 26 + (rng() - 0.5) * 0.1, 0.02, 0.98),
      touchdownTalent: 0.6 + rng() * 0.8,
    };
  });

  for (let week = 1; week <= weekCount; week++) {
    const totalByTeam = new Map<string, number>();
    for (const team of teams) totalByTeam.set(team, 16 + rng() * 12);

    for (const player of players) {
      const implied = totalByTeam.get(player.team) ?? 21.5;
      const status = injuryFor(rng, player.trueMean);
      if (status === "Out") continue;

      const drifted =
        player.trueMean * (1 + player.drift * (week - weekCount / 2)) +
        (status === "Questionable" ? -1 : 0);
      const centre = Math.max(0.3, drifted);
      // The measured ladder, used as truth about football rather than as the model's assumption.
      const sd = centre * ladderCv(centre) * (0.85 + 0.3 * ((implied - 16) / 12));
      const points = Math.max(0, zeroInflatedLognormal(rng, centre, sd));

      weeks.push({
        playerId: player.playerId,
        name: player.name,
        position: player.position,
        team: player.team,
        season: SYNTHETIC_SEASON,
        week,
        points: round1(points),
        targetShare: round3(clamp(player.opportunity * 0.6 + (rng() - 0.5) * 0.06, 0, 1)),
        wopr: round3(clamp(player.opportunity + (rng() - 0.5) * 0.08, 0, 1.4)),
        snapShare: round3(clamp(player.opportunity * 1.4 + (rng() - 0.5) * 0.1, 0, 1)),
      });
      touchdowns.push({
        playerId: player.playerId,
        season: SYNTHETIC_SEASON,
        week,
        touchdowns: poisson(rng, (player.trueMean / 13) * player.touchdownTalent),
      });
      kickoffs.push({
        playerId: player.playerId,
        season: SYNTHETIC_SEASON,
        week,
        impliedTeamTotal: round1(implied),
        injuryStatus: status,
      });
    }
  }

  return { weeks, touchdowns, kickoffs };
}

/** The measured sd/mean ladder, as a property of football rather than of this model. */
function ladderCv(mean: number): number {
  if (mean < 5) return 1.16;
  if (mean < 8) return 0.8;
  if (mean < 11) return 0.66;
  if (mean < 14) return 0.57;
  return 0.49;
}

/** A week that is either a blank or a right-skewed score. Not the family the model assumes. */
function zeroInflatedLognormal(rng: Rng, mean: number, sd: number): number {
  const blank = clamp(0.26 - mean / 55, 0.02, 0.3);
  if (rng() < blank) return 0;
  const bodyMean = mean / (1 - blank);
  const bodySd = sd * 0.9;
  const variance = Math.log(1 + (bodySd / bodyMean) ** 2);
  const mu = Math.log(bodyMean) - variance / 2;
  return Math.exp(mu + Math.sqrt(variance) * standardNormal(rng));
}

/**
 * Who gets listed, and why the raw injury effect comes out backwards.
 *
 * Good players are listed more often, because a team bothers to report on a starter. So the
 * Questionable pool outscores the unlisted pool even though being Questionable costs a point.
 */
function injuryFor(rng: Rng, trueMean: number): InjuryDesignation | null {
  const roll = rng();
  const listedRate = clamp(0.04 + trueMean / 120, 0.04, 0.22);
  if (roll < listedRate * 0.15) return "Out";
  if (roll < listedRate * 0.3) return "Doubtful";
  if (roll < listedRate) return "Questionable";
  return null;
}

function poisson(rng: Rng, lambda: number): number {
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------------------------

function loadLeague(path: string): League {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("weeks" in parsed)) {
    throw new Error(`${path} does not look like a league: expected { weeks, touchdowns, kickoffs }`);
  }
  const league = parsed as Partial<League>;
  if (!Array.isArray(league.weeks) || league.weeks.length === 0) {
    throw new Error(`${path} has no weeks in it`);
  }
  return {
    weeks: league.weeks,
    touchdowns: league.touchdowns ?? [],
    kickoffs: league.kickoffs ?? [],
  };
}

const pct = (value: number, places = 1): string => `${(value * 100).toFixed(places)}%`;
const pad = (value: string, width: number): string =>
  value.length >= width ? value : " ".repeat(width - value.length) + value;
const padRight = (value: string, width: number): string =>
  value.length >= width ? value : value + " ".repeat(width - value.length);

export function report(graded: readonly Graded[], lines: (s: string) => void): void {
  const rows = reliability(graded);
  lines("");
  lines(`CALIBRATION  does a ${SPIKE_POINTS}-point week happen as often as it was promised`);
  lines("");
  lines(
    `  ${padRight("predicted band", 16)}${pad("n", 7)}${pad("said", 9)}${pad("happened", 10)}${pad("gap", 8)}`,
  );
  for (const row of rows) {
    const gap = row.count ? row.observed - row.predicted : 0;
    lines(
      `  ${padRight(row.label, 16)}${pad(String(row.count), 7)}` +
        `${pad(row.count ? pct(row.predicted) : "-", 9)}` +
        `${pad(row.count ? pct(row.observed) : "-", 10)}` +
        `${pad(row.count ? `${gap >= 0 ? "+" : ""}${pct(gap)}` : "-", 8)}`,
    );
  }
  lines(`  weighted mean gap: ${pct(calibrationError(rows), 2)}`);

  lines("");
  lines("SPIKE RATE BY PREDICTED DECILE  does the ordering carry anything");
  lines("");
  lines(
    `  ${padRight("decile", 8)}${pad("n", 7)}${pad("said", 9)}${pad("happened", 10)}${pad("lift", 8)}`,
  );
  for (const row of spikeLiftByDecile(graded)) {
    lines(
      `  ${padRight(String(row.decile), 8)}${pad(String(row.count), 7)}${pad(pct(row.predicted), 9)}` +
        `${pad(pct(row.observed), 10)}${pad(`${row.lift.toFixed(2)}x`, 8)}`,
    );
  }

  const baseline = errorMetrics(graded, (g) => g.baseline);
  const modelMean = errorMetrics(graded, (g) => g.mean);
  const modelMedian = errorMetrics(graded, (g) => g.p50);
  lines("");
  lines("POINT ESTIMATE  against the season average to date, which is expected to win");
  lines("");
  lines(`  ${padRight("estimator", 26)}${pad("RMSE", 9)}${pad("MAE", 9)}${pad("n", 9)}`);
  lines(
    `  ${padRight("baseline, season average", 26)}${pad(baseline.rmse.toFixed(3), 9)}${pad(baseline.mae.toFixed(3), 9)}${pad(String(baseline.n), 9)}`,
  );
  lines(
    `  ${padRight("model, distribution mean", 26)}${pad(modelMean.rmse.toFixed(3), 9)}${pad(modelMean.mae.toFixed(3), 9)}${pad(String(modelMean.n), 9)}`,
  );
  lines(
    `  ${padRight("model, distribution median", 26)}${pad(modelMedian.rmse.toFixed(3), 9)}${pad(modelMedian.mae.toFixed(3), 9)}${pad(String(modelMedian.n), 9)}`,
  );
  lines("");
  lines(`  RMSE change against baseline: ${signedPct(modelMean.rmse, baseline.rmse)}`);
  lines(`  MAE change against baseline:  ${signedPct(modelMean.mae, baseline.mae)}`);
  lines(
    `  for reference, the measured four-season figures are RMSE ${BASELINE_RMSE} and MAE ${BASELINE_MAE} for the baseline`,
  );
  lines("");
  lines(
    modelMean.rmse < baseline.rmse
      ? "  VERDICT: the model's centre edges the baseline here. Treat a small win as noise until it survives a real season: the adjustments total about a point against a typical error of six."
      : "  VERDICT: the model does not beat the baseline on point error. That is the expected result and it is not a failure - the baseline is close to the ceiling of this category. What the model adds is the spread around that centre and the odds that come out of it, and the calibration table above is what grades those.",
  );
}

function signedPct(model: number, baseline: number): string {
  if (baseline === 0) return "n/a";
  const change = (model - baseline) / baseline;
  return `${change >= 0 ? "+" : ""}${(change * 100).toFixed(2)}% (${change >= 0 ? "worse" : "better"})`;
}

function main(argv: readonly string[]): void {
  const dataFlag = argv.indexOf("--data");
  const path = dataFlag >= 0 ? argv[dataFlag + 1] : undefined;
  const lines = (s: string) => console.log(s);

  const league = path ? loadLeague(path) : syntheticLeague();
  lines("");
  if (path) {
    lines(`BACKTEST  ${league.weeks.length} player-weeks from ${path}`);
  } else {
    lines("BACKTEST  SYNTHETIC LEAGUE, NOT A MEASUREMENT");
    lines("");
    lines("  No data file was passed, so this ran against a seeded synthetic league whose weekly");
    lines("  points are zero-inflated lognormal with a drifting mean - deliberately not the family");
    lines("  the model assumes. It exercises the walk-forward machinery end to end and proves the");
    lines("  tables are computed correctly. It says NOTHING about how this model does on football.");
    lines("  Pass --data <file.json> with { weeks, touchdowns, kickoffs } for that.");
    lines("");
    lines(`  ${league.weeks.length} player-weeks, implied totals spanning the measured Vegas range`);
    lines(`  of ${IMPLIED_TOTAL_LOW.total} to ${IMPLIED_TOTAL_HIGH.total} points.`);
  }

  const graded = walkForward(league);
  lines(`  graded ${graded.length} predictions, every one cut at the week before`);
  report(graded, lines);
  lines("");
}

// Run only when invoked directly, so the tests can import the generator and the report without
// setting a backtest going. Under vitest, argv[1] is the test runner, not this file.
const invokedAs = process.argv[1] ?? "";
if (invokedAs.endsWith("backtest.ts")) main(process.argv.slice(2));
