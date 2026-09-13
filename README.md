# spike

Fantasy football, told as odds rather than as a number.

## Why there are no projections here

Four seasons of play, 24,616 player-weeks, every feature computed strictly as-of the prior
week. A model using past points, target share, weighted opportunity and the Vegas line,
trained on 2022 to 2024 and tested on 2025:

| | RMSE | MAE | r |
|---|---|---|---|
| The player's own season average to date | 6.208 | 4.373 | 0.597 |
| The model | 6.119 | **4.426** | 0.602 |

It does not beat the baseline. RMSE improves by 1.4 per cent and MAE gets worse. The typical
weekly error is **6.2 points against a mean of about 7**, which is the honest state of this
whole category: everyone's error is roughly the size of the thing they are predicting.

So this does not sell you a number. It tells you the odds, and it shows you how its odds have
held up.

## What it does instead

- **Distributions, notpoint estimates.** A player is a shape. The width is the information.
- **It refuses to rank what it cannot separate.** At a weekly coefficient of variation of 0.82,
  the seventh and eleventh ranked players are routinely the same player, and saying so is more
  useful than sorting them.
- **A regression list**, from production measured against what that player's opportunity
  usually buys. Quartile effects run from +0.95 to -1.53 points per game.
- **Spike probability**, because about 40 per cent of a player's season arrives in their best
  three weeks. The question worth answering is not how many points, it is what are the odds
  this is one of the big ones.
- **Its own scorecard.** Every claim is graded afterwards, publicly, including the wrong ones.

## Things that sound true and are not

Each of these would have shipped as a feature if nobody had checked.

| Tempting | Measured |
|---|---|
| Draft on opportunity, not production | Opportunity predicts worse. 0.634 against 0.780 |
| Some players are boom-bust by nature | Residual volatility r = **0.152** once the mean is removed. It is about 85 per cent noise |
| Next Gen Stats gives an edge | Separation r = 0.072 with the week's points, and it is not even a stable trait |
| Questionable players underperform | Raw, they **outscore** unlisted players. The designation only costs points once you control for who gets listed |

## Data

Player statistics, schedules with betting lines, snap counts and injury reports come from
**[nflverse](https://github.com/nflverse/nflverse-data)**, used under **CC BY 4.0**.
Player identifiers and league data come from the Sleeper API. No key, no scraping, and nothing
here costs anyone money to serve.
