# spike

Fantasy football, told as odds rather than as a number.

## Why this is not a projections site

Projections do not work, and that is measured rather than assumed. Four seasons of nflverse
data, 24,616 player-weeks, every feature computed strictly as-of the prior week:

| | RMSE | MAE | r |
|---|---|---|---|
| Baseline, the player's season average to date | 6.208 | 4.373 | 0.597 |
| A model on past points, target share, WOPR and the Vegas line | 6.119 | **4.426** | 0.602 |

The model does not beat the baseline. RMSE improves 1.4 per cent and MAE gets **worse**. And
the typical error is **6.2 points against a mean of about 7**, which is the real state of this
entire category: everybody's error is roughly the size of the thing they are predicting.

So there is no edge to be had in the number, and a site that sells one is selling a number it
cannot back. What there is, is everything the number throws away.

## The one rule

**No figure appears without its uncertainty, and nothing is ranked that cannot be told apart.**

A page that prints `12.4` has made a claim it cannot support. A page that prints a
distribution, and says plainly when two of them overlap too much to separate, has not.

## What the probing established

Real, and the product is built on these:

| | |
|---|---|
| Weekly volatility | CV 0.82 for RB/WR/TE |
| Concentration | about 40 per cent of a season comes from a player's best 3 weeks |
| Opportunity is stickier than production | WOPR 0.878, target share 0.860, points 0.780 |
| The opportunity gap predicts regression | RB -0.317, WR -0.285, TE -0.345, monotonic, 2.3 to 2.8 ppg between quartiles |
| Touchdowns regress | stickiness 0.453; hot shooters lose 1.26 ppg |
| Vegas predicts spikes, not means | spike rate 3.5 per cent at an implied total under 17, 10.1 per cent at 26 or more |
| Snap share | r = 0.619 with the same week's points, the best single-week signal found |
| Injury designation, once controlled | Questionable costs -0.99 against the player's own baseline |

False, and each one would have shipped as a feature if nobody had checked:

| Tempting | Measured |
|---|---|
| Opportunity beats production as a predictor | **No.** 0.634 against 0.780 |
| Boom-bust is a durable player trait | **No.** Residual volatility r = 0.152 once the mean is removed |
| Next Gen Stats adds an edge | **Barely.** Separation r = 0.072, and it is not even sticky |
| Questionable players underperform | **Backwards** until you control for quality. Raw, they outscore unlisted players |

## The consequence that shapes the code

**A player's volatility is not a property of the player.** Residual spread, with the mean's
effect removed, correlates at 0.152 between halves of a season. It is about 85 per cent noise.

So the simulator must not draw a player's spread from their own history, which is the obvious
implementation and is wrong. It draws from a position-and-mean model, for which the ladder is
measured:

| Season mean, ppg | sd of weekly points | sd / mean |
|---|---|---|
| under 5 | 2.93 | 1.16 |
| 5 to 8 | 5.10 | 0.80 |
| 8 to 11 | 6.21 | 0.66 |
| 11 to 14 | 7.13 | 0.57 |
| 14 or more | 8.42 | 0.49 |

Better players are absolutely more variable and relatively more consistent.

## What the page does

1. **Odds, not scores.** Every player is a distribution drawn from the model above. The
   headline number is the chance of a spike, not a projected total.
2. **Refuses to rank what it cannot separate.** Two players whose distributions overlap past a
   threshold are shown as tied, with the overlap stated.
3. **A regression list.** Production minus what that player's opportunity usually buys, plus
   touchdown rate against expectation. This is the buy-low and sell-high list, and it carries
   its measured effect size rather than an adjective.
4. **A week simulator.** Ten thousand runs of your lineup against theirs, rendered as the two
   outcome clouds and the margin between them. Not "121.4 to 118.2" but "you win 63 times in
   100, and here is what the other 37 look like."
5. **Its own scorecard.** Every claim the model makes is graded afterwards, publicly,
   including the ones it got wrong. Nobody in this category does this.

## Data

All free, no key, no scraping, and no terms of service to fall foul of.

| Source | Licence | What for |
|---|---|---|
| nflverse `stats_player`, `pbp`, `stats_team` | CC-BY-4.0 | weekly production and opportunity |
| nflverse `schedules` | CC-BY-4.0 | Vegas spread and total, for implied team totals |
| nflverse `snap_counts` | CC-BY-4.0 | playing time |
| nflverse `injuries` | CC-BY-4.0 | practice and game status |
| Sleeper API | free, no key | player ids, season state, league sync |

One season of the columns this needs is 472 kB gzipped, so it ships as static assets and
needs no database.

## What this is not

Not a projections site, not a rankings site, not a lineup optimiser that pretends its numbers
are exact. It reports odds and it reports how well its odds have held up.
