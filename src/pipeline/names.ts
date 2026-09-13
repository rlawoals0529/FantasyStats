/**
 * Name normalisation, for the one join that has no identifier to use.
 *
 * `snap_counts` is derived from Pro Football Reference and carries `pfr_player_id`, which is
 * not a gsis id and maps to nothing else in the feed set. So the only way to attach snap share
 * to a player-week is by name, and names are the worst join key there is: they get spelled
 * differently by different sources, they carry suffixes inconsistently, and they collide.
 *
 * This file does the part that is safe to automate: casing, accents, punctuation, generational
 * suffixes. It deliberately stops short of a nickname table. "Kenny Gainwell" against PFR's
 * "Kenneth Gainwell" is a real mismatch and a hand-maintained alias list would fix it this
 * season and rot by the next, so `snaps.ts` handles those structurally instead, by matching on
 * surname within a single game and team. What is left after that is reported as a number, not
 * papered over.
 */

/** Suffixes that one source prints and the other does not. Stripped from the end only. */
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

/**
 * Lowercase, unaccented, unpunctuated, suffix-free.
 *
 * Punctuation is removed rather than replaced with a space, and that is the whole difference
 * between 1.03 per cent and 0.18 per cent of 2024 skill-position rows failing to join.
 * PFR writes "D.J. Moore"; replacing the dots with spaces gives "d j moore", which does not
 * match nflverse's "dj moore" and also does not match on surname, because the Bears had a
 * Tarvarius Moore and the surname is therefore ambiguous. Removing the dots gives "dj moore"
 * and the row joins on the first try.
 */
export function normaliseName(name: string): string {
  const stripped = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Written as escapes rather than as the characters themselves: a curly apostrophe is
    // invisible in a diff and indistinguishable from a straight one in most editors.
    .replace(/[.'\u2019\u2018-]/g, "")
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const parts = stripped.split(" ");
  const last = parts[parts.length - 1];
  if (parts.length > 2 && last !== undefined && SUFFIXES.has(last)) parts.pop();
  return parts.join(" ");
}

/** Surname, after normalisation. Used only as a fallback and only within one game and team. */
export function surname(name: string): string {
  const parts = normaliseName(name).split(" ");
  return parts[parts.length - 1] ?? "";
}

/** First initial, after normalisation. Guards the surname fallback against Kyle vs Zach. */
export function firstInitial(name: string): string {
  return normaliseName(name).charAt(0);
}
