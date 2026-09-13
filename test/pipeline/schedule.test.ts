/**
 * The implied-total sign convention.
 *
 * Getting this backwards is silent. Nothing throws, the numbers stay in the right range, and
 * every favourite is quietly modelled as an underdog. So the test is not "does it compute a
 * number", it is "is the number on the correct side", asked three ways against real games with
 * real final scores.
 *
 * The third of those is the one a mutation cannot survive: compare the implied total to points
 * actually scored, and the correct convention beats the flipped one by more than a point of
 * RMSE on 132 team-games. There is no way to flip the sign and keep that.
 */

import { describe, expect, it } from "vitest";

import { num, str } from "../../src/pipeline/csv.ts";
import { impliedTotal, ScheduleIndex, type GameLine } from "../../src/pipeline/schedule.ts";
import { fixture } from "./helpers.ts";

const schedule = fixture("games-2024.csv");
const index = new ScheduleIndex(schedule);

/** The season's largest home spread: Baltimore at home, favoured by 19.5, won 35 to 10. */
const CLE_AT_BAL = "2024_18_CLE_BAL";
/** The most negative: the Giants at home as a 16.5 point underdog, lost 14 to 35. */
const BAL_AT_NYG = "2024_15_BAL_NYG";

describe("the arithmetic", () => {
  const game: GameLine = {
    gameId: "test",
    season: 2024,
    week: 1,
    homeTeam: "HOME",
    awayTeam: "AWAY",
    spreadLine: 7,
    totalLine: 45,
  };

  it("splits the total and moves half the spread onto the home team", () => {
    expect(impliedTotal(game, "HOME")).toBe(26);
    expect(impliedTotal(game, "AWAY")).toBe(19);
  });

  it("has the two sides add back up to the total", () => {
    const home = impliedTotal(game, "HOME");
    const away = impliedTotal(game, "AWAY");
    expect((home as number) + (away as number)).toBeCloseTo(45, 10);
  });

  it("gives both sides the same number on a pick-em", () => {
    expect(impliedTotal({ ...game, spreadLine: 0 }, "HOME")).toBe(22.5);
    expect(impliedTotal({ ...game, spreadLine: 0 }, "AWAY")).toBe(22.5);
  });

  it("returns null, not half the total, when the game has not been lined", () => {
    // A missing line is "we do not know what Vegas thinks". Defaulting to the total halved
    // would assert a coin flip, which is a different and unsupported claim.
    expect(impliedTotal({ ...game, spreadLine: null }, "HOME")).toBeNull();
    expect(impliedTotal({ ...game, totalLine: null }, "AWAY")).toBeNull();
  });

  it("returns null for a team that is not in the game", () => {
    expect(impliedTotal(game, "SOMEONE_ELSE")).toBeNull();
  });
});

describe("the sign, against real games", () => {
  it("gives the heavy home favourite the higher implied total", () => {
    // Baltimore at home, laying 19.5 on a 42.5 total. They won 35 to 10.
    const home = index.impliedFor(CLE_AT_BAL, "BAL");
    const away = index.impliedFor(CLE_AT_BAL, "CLE");
    expect(home).toBe(31);
    expect(away).toBe(11.5);
    expect(home as number).toBeGreaterThan(away as number);
  });

  it("gives the heavy home underdog the lower implied total", () => {
    // The Giants at home, taking 16.5 on a 43.5 total. They lost 14 to 35.
    const home = index.impliedFor(BAL_AT_NYG, "NYG");
    const away = index.impliedFor(BAL_AT_NYG, "BAL");
    expect(home).toBe(13.5);
    expect(away).toBe(30);
    expect(home as number).toBeLessThan(away as number);
  });

  it("puts the winning side ahead on implied total in both of those games", () => {
    // Stated separately because it is the property a reader can check against a scoreboard,
    // and because it holds whichever team happens to be at home.
    expect(index.impliedFor(CLE_AT_BAL, "BAL") as number).toBeGreaterThan(
      index.impliedFor(CLE_AT_BAL, "CLE") as number,
    );
    expect(index.impliedFor(BAL_AT_NYG, "BAL") as number).toBeGreaterThan(
      index.impliedFor(BAL_AT_NYG, "NYG") as number,
    );
  });
});

describe("the sign, against every final score in the fixture", () => {
  type TeamGame = { readonly implied: number; readonly flipped: number; readonly scored: number };

  const teamGames: TeamGame[] = [];
  for (const row of schedule.rows) {
    const gameId = str(row, "game_id");
    const home = str(row, "home_team");
    const away = str(row, "away_team");
    const spread = num(row, "spread_line");
    const total = num(row, "total_line");
    const homeScore = num(row, "home_score");
    const awayScore = num(row, "away_score");
    if (gameId === null || home === null || away === null) continue;
    if (spread === null || total === null || homeScore === null || awayScore === null) continue;

    const homeImplied = index.impliedFor(gameId, home) as number;
    const awayImplied = index.impliedFor(gameId, away) as number;
    // The flipped convention is what you get by writing the minus on the wrong side.
    teamGames.push({ implied: homeImplied, flipped: total / 2 - spread / 2, scored: homeScore });
    teamGames.push({ implied: awayImplied, flipped: total / 2 + spread / 2, scored: awayScore });
  }

  const rmse = (pick: (t: TeamGame) => number): number =>
    Math.sqrt(teamGames.reduce((sum, t) => sum + (pick(t) - t.scored) ** 2, 0) / teamGames.length);

  it("has enough real games to say anything", () => {
    expect(teamGames.length).toBeGreaterThanOrEqual(120);
  });

  it("predicts points scored better than the flipped convention does", () => {
    // Measured on the fixture: 8.99 against 10.08. Across 2021 to 2025 it is 9.09 against
    // 11.20 on 2,718 team-games. A full point of RMSE is not a tie-break, it is the answer.
    const correct = rmse((t) => t.implied);
    const flipped = rmse((t) => t.flipped);
    expect(correct).toBeLessThan(flipped - 0.5);
  });

  it("is not systematically high or low", () => {
    // Guards the other way a sign error can hide: an implied total that is right on average
    // and wrong per game would pass an accuracy test built only on means.
    const bias = teamGames.reduce((sum, t) => sum + (t.implied - t.scored), 0) / teamGames.length;
    expect(Math.abs(bias)).toBeLessThan(1.5);
  });

  it("has teams with a higher implied total score more, monotonically", () => {
    // The ladder that a flipped sign runs backwards down.
    const low = teamGames.filter((t) => t.implied < 20);
    const high = teamGames.filter((t) => t.implied >= 24);
    expect(low.length).toBeGreaterThan(10);
    expect(high.length).toBeGreaterThan(10);
    const mean = (xs: TeamGame[]) => xs.reduce((s, t) => s + t.scored, 0) / xs.length;
    expect(mean(high)).toBeGreaterThan(mean(low) + 3);
  });
});

describe("the index", () => {
  it("holds every game in the fixture", () => {
    expect(index.size).toBe(schedule.rows.length);
  });

  it("returns null for a game it has never heard of", () => {
    expect(index.get("2024_01_NOT_AGAME")).toBeNull();
    expect(index.impliedFor("2024_01_NOT_AGAME", "BAL")).toBeNull();
  });
});
