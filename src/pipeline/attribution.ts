/**
 * The licence notice, as a value rather than as a comment.
 *
 * nflverse publishes under CC BY 4.0, which is attribution only: credit and a link, no
 * share-alike obligation. Attribution-only is still an obligation, and an obligation that
 * lives in a source comment is not discharged, because nobody who receives the shipped JSON
 * ever reads the source. So the notice is a field of the payload. Strip it and the dataset
 * stops being redistributable, which is the point of putting it where a diff will show it
 * going missing.
 *
 * It is also in the README, for the same reason in the other direction: a human arriving at
 * the repository should not have to open a data file to find out whose work this is.
 */

/** Exactly the wording the README carries. Kept identical so the two cannot drift apart. */
export const NFLVERSE_ATTRIBUTION =
  "Player statistics, schedules with betting lines, snap counts and injury reports come from " +
  "nflverse (https://github.com/nflverse/nflverse-data), used under CC BY 4.0.";

/** Where a reader goes to check the licence text itself. */
export const NFLVERSE_LICENCE_URL = "https://creativecommons.org/licenses/by/4.0/";
