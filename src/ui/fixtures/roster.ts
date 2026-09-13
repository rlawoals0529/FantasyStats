/**
 * Fixture roster. Real names, real positions, real teams, invented outlooks.
 *
 * Lifted once from `data/raw/stats_player_week_2024.csv` and frozen here as a literal, not read
 * at runtime: parsing that file is the pipeline slice's job and this directory is deleted the
 * day it lands. What it buys is a board that behaves like the real one - clustered means, a
 * long tail, positions in the proportions a flex board actually has - which a roster of
 * Player A through Player Z does not, and the difference shows up immediately in how the tie
 * bands fall.
 *
 * `ppg` is that player's points per game across weeks 1 to 6 of 2024, PPR. Everything else the
 * interface shows is derived from it by `generate.ts` through the measured spread ladder.
 */

export type RosterRow = {
  readonly id: string;
  readonly name: string;
  readonly position: "QB" | "RB" | "WR" | "TE";
  readonly team: string;
  readonly opponent: string;
  readonly ppg: number;
  /** Season-to-date share of team targets, where the position has one. */
  readonly targetShare: number | null;
};

export const ROSTER: readonly RosterRow[] = [
  { id: "p-nabers", name: "Malik Nabers", position: "WR", team: "NYG", opponent: "DAL", ppg: 22.9, targetShare: 0.402 },
  { id: "p-kamara", name: "Alvin Kamara", position: "RB", team: "NO", opponent: "TB", ppg: 22.77, targetShare: 0.208 },
  { id: "p-henry", name: "Derrick Henry", position: "RB", team: "BAL", opponent: "WAS", ppg: 22.55, targetShare: 0.057 },
  { id: "p-walker", name: "Kenneth Walker III", position: "RB", team: "SEA", opponent: "SF", ppg: 22.0, targetShare: 0.147 },
  { id: "p-collins", name: "Nico Collins", position: "WR", team: "HOU", opponent: "BUF", ppg: 21.34, targetShare: 0.245 },
  { id: "p-barkley", name: "Saquon Barkley", position: "RB", team: "PHI", opponent: "CLE", ppg: 21.08, targetShare: 0.115 },
  { id: "p-godwin", name: "Chris Godwin Jr.", position: "WR", team: "TB", opponent: "NO", ppg: 20.72, targetShare: 0.295 },
  { id: "p-chase", name: "Ja'Marr Chase", position: "WR", team: "CIN", opponent: "NYG", ppg: 20.08, targetShare: 0.218 },
  { id: "p-kyren", name: "Kyren Williams", position: "RB", team: "LA", opponent: "GB", ppg: 19.42, targetShare: 0.099 },
  { id: "p-jefferson", name: "Justin Jefferson", position: "WR", team: "MIN", opponent: "NYJ", ppg: 19.0, targetShare: 0.334 },
  { id: "p-taylor", name: "Jonathan Taylor", position: "RB", team: "IND", opponent: "PIT", ppg: 18.15, targetShare: 0.096 },
  { id: "p-montgomery", name: "David Montgomery", position: "RB", team: "DET", opponent: "DAL", ppg: 18.1, targetShare: 0.067 },
  { id: "p-reed", name: "Jayden Reed", position: "WR", team: "GB", opponent: "ARI", ppg: 17.7, targetShare: 0.206 },
  { id: "p-london", name: "Drake London", position: "WR", team: "ATL", opponent: "CAR", ppg: 17.47, targetShare: 0.274 },
  { id: "p-kittle", name: "George Kittle", position: "TE", team: "SF", opponent: "SEA", ppg: 17.26, targetShare: 0.229 },
  { id: "p-diggs", name: "Stefon Diggs", position: "WR", team: "HOU", opponent: "NE", ppg: 16.99, targetShare: 0.222 },
  { id: "p-cook", name: "James Cook", position: "RB", team: "BUF", opponent: "HOU", ppg: 16.84, targetShare: 0.099 },
  { id: "p-gibbs", name: "Jahmyr Gibbs", position: "RB", team: "DET", opponent: "DAL", ppg: 16.64, targetShare: 0.106 },
  { id: "p-devonta", name: "DeVonta Smith", position: "WR", team: "PHI", opponent: "CLE", ppg: 16.57, targetShare: 0.266 },
  { id: "p-stbrown", name: "Amon-Ra St. Brown", position: "WR", team: "DET", opponent: "DAL", ppg: 16.44, targetShare: 0.276 },
  { id: "p-lamar", name: "Lamar Jackson", position: "QB", team: "BAL", opponent: "WAS", ppg: 23.91, targetShare: null },
  { id: "p-daniels", name: "Jayden Daniels", position: "QB", team: "WAS", opponent: "BAL", ppg: 22.39, targetShare: null },
  { id: "p-allen", name: "Josh Allen", position: "QB", team: "BUF", opponent: "NYJ", ppg: 19.7, targetShare: null },
  { id: "p-hurts", name: "Jalen Hurts", position: "QB", team: "PHI", opponent: "CLE", ppg: 17.87, targetShare: null },
  { id: "p-stroud", name: "C.J. Stroud", position: "QB", team: "HOU", opponent: "NE", ppg: 16.76, targetShare: null },
  { id: "p-andrews", name: "Mark Andrews", position: "TE", team: "BAL", opponent: "WAS", ppg: 11.4, targetShare: 0.168 },
  { id: "p-laporta", name: "Sam LaPorta", position: "TE", team: "DET", opponent: "DAL", ppg: 10.8, targetShare: 0.155 },
  { id: "p-njoku", name: "David Njoku", position: "TE", team: "CLE", opponent: "PHI", ppg: 9.2, targetShare: 0.191 },
  { id: "p-mooney", name: "Darnell Mooney", position: "WR", team: "ATL", opponent: "CAR", ppg: 13.6, targetShare: 0.197 },
  { id: "p-pickens", name: "George Pickens", position: "WR", team: "PIT", opponent: "IND", ppg: 13.1, targetShare: 0.243 },
  { id: "p-swift", name: "D'Andre Swift", position: "RB", team: "CHI", opponent: "JAX", ppg: 12.4, targetShare: 0.091 },
  { id: "p-conner", name: "James Conner", position: "RB", team: "ARI", opponent: "GB", ppg: 12.1, targetShare: 0.098 },
  { id: "p-shakir", name: "Khalil Shakir", position: "WR", team: "BUF", opponent: "HOU", ppg: 10.3, targetShare: 0.182 },
  { id: "p-dowdle", name: "Rico Dowdle", position: "RB", team: "DAL", opponent: "DET", ppg: 7.6, targetShare: 0.062 },
  { id: "p-mclaurin", name: "Terry McLaurin", position: "WR", team: "WAS", opponent: "BAL", ppg: 14.2, targetShare: 0.229 },
  { id: "p-hockenson", name: "T.J. Hockenson", position: "TE", team: "MIN", opponent: "NYJ", ppg: 6.9, targetShare: 0.141 },
];
