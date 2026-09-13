# Fixtures

Real slices of the real feeds, captured verbatim. No hand-written rows, because a hand-written
row agrees with whatever the code does and a real one does not.

**Captured 12 September 2026** from the nflverse releases named below. Values are exactly as
they arrived. Some files carry a narrowed column set, noted per file: the rows are untouched,
the columns are a subset, and nothing has been edited or reformatted.

Player statistics, schedules with betting lines, snap counts and injury reports come from
[nflverse](https://github.com/nflverse/nflverse-data), used under CC BY 4.0.

| File | Source | Slice |
|---|---|---|
| `stats-2024-w1.csv` | `stats_player/stats_player_week_2024.csv` | Six games of week 1, all positions. Columns narrowed to the 21 the pipeline reads plus six carried only so the cross-check can account for them. |
| `snaps-2024-w1.csv` | `snap_counts/snap_counts_2024.csv` | The same six games. All columns. |
| `injuries-2024-w1.csv` | `injuries/injuries_2024.csv` | Week 1, the twelve teams in those games. All columns. |
| `games-2024.csv` | `schedules/games.csv` | 2024 regular season weeks 1 to 4 with final scores, plus the season's two most lopsided lines. Columns narrowed to the eight the pipeline reads plus the two scores. |
| `scoring-cases-2024.csv` | `stats_player/stats_player_week_2024.csv` | Twelve player-weeks chosen one per scoring trap. Same columns as `stats-2024-w1.csv`. |
| `stats-2024-post.csv` | `stats_player/stats_player_week_2024.csv` | One wild card game, 68 rows, all `season_type=POST`. The builder must drop every one of them. |
| `collision-2023-stats.csv` | `stats_player/stats_player_week_2023.csv` | Michael Carter, three games. |
| `collision-2023-snaps.csv` | `snap_counts/snap_counts_2023.csv` | The same three games, both Michael Carters. |

## The two named games in `games-2024.csv`

`2024_18_CLE_BAL` is the season's largest `spread_line`, +19.5, and Baltimore, the home team,
won 35 to 10. `2024_15_BAL_NYG` is the most negative, -16.5, and the Giants, the home team,
lost 14 to 35. Between them they pin the sign convention to something a reader can check
against a scoreboard, which is why they are carried alongside the four full weeks.

## The collision files

The 2023 Jets rostered Michael Carter at running back and Michael Carter II at cornerback. The
suffix has to be stripped, because the two feeds disagree about suffixes, and stripping it
makes them the same key. The corner played zero offensive snaps. These six rows are the
smallest real thing that can tell a correct join from one that hands the running back a zero.

## Recapturing

Fetch the release files into `data/raw/` (a `npm run refresh` does this), then re-select the
same slices. Keep the capture date in this file current, and say so in the commit: a fixture
whose provenance nobody can reconstruct is a fixture nobody can trust when it starts failing.
