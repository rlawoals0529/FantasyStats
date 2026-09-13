# FantasyStats

Fantasy football as odds, graded against what actually happened.

## Why there are no projections here

Before building anything I checked whether a model could beat the simplest possible guess: a
player's own season average so far. Over four seasons of play, with every feature computed
strictly from the weeks before the one being predicted, it could not. The typical weekly error
is close to the size of a typical week's score, which is the honest state of this whole
category.

So this does not sell you a number. There is no edge in the number.

## What it does instead

**Every player is a distribution, not a point.** The width is the information, and the page
draws it. Two shapes side by side tell you more than two rankings ever could.

**It refuses to rank what it cannot separate.** Week to week scoring is volatile enough that
players a few places apart on any ranking list are routinely indistinguishable. Saying so is
more useful than sorting them and pretending the order means something.

**The headline is the chance of a big week**, not a projected total, because a fantasy season is
decided by a handful of outlier weeks rather than by averages.

**A buy-low and sell-high list**, from what a player is producing measured against what their
opportunity usually buys. Outperforming your opportunity tends not to last.

**A scorecard.** The page grades its own claims against what happened, including the band where
it is least accurate. Nobody else in this category publishes that.

## Things that sound true and are not

Each of these is worth knowing because they are repeated constantly and the data does not
support them:

- **Draft on opportunity rather than production.** Opportunity is the stickier signal, but past
  production is still the better predictor of future production.
- **Some players are boom-or-bust by nature.** Week-to-week volatility is overwhelmingly a
  function of how good a player is, not a separate personal trait, and what looks like a
  boom-bust profile regresses hard.
- **Advanced tracking data gives you an edge.** Separation and cushion barely move with scoring
  and are not stable from one half of a season to the next.

The measurements behind all of this are in [docs/CONCEPT.md](docs/CONCEPT.md).

## Running it

```
npm install
npm run refresh     # fetch and normalise the feeds
npm run board       # run the model, write the week the page renders
npm run dev
npm test
```

## Data

Player statistics, schedules with betting lines, snap counts and injury reports come from
**[nflverse](https://github.com/nflverse/nflverse-data)**, used under **CC BY 4.0**. Player
identifiers come from the Sleeper API. No key, no scraping, and nothing here costs anyone money
to serve.
