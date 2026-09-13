/**
 * The real board, fetched, with the fixture kept as the fallback rather than as the default.
 *
 * `board.json` is produced by `scripts/board.ts` from four seasons of nflverse data. It is a
 * static asset, so this is one fetch of about 200 kB and no backend at all.
 *
 * **A failed fetch falls back to the fixture and says so, loudly.** Silently showing generated
 * numbers that look exactly like real ones is the worst outcome available here: every figure on
 * the page would be plausible, wrong, and indistinguishable from the truth. The caller is told
 * which it got, and the page says so where a reader can see it.
 *
 * Densities arrive as plain arrays because JSON has no typed arrays. They are converted once,
 * here, rather than in the renderer: the port says `Float64Array` and the producer meets the
 * port, so no drawing code has to know the wire format.
 */
import type { DataSource, WeekBoard } from "./ports.ts";
import { GRID_SIZE } from "./ports.ts";

export type LoadResult = { board: WeekBoard; live: boolean; note: string };

function hydrate(raw: unknown): WeekBoard {
  const b = raw as WeekBoard & { players: { density: number[] | Float64Array }[] };
  if (!Array.isArray(b.players) || b.players.length === 0) throw new Error("board.json has no players");
  for (const p of b.players) {
    if (p.density.length !== GRID_SIZE) {
      // Loud, because a grid mismatch would draw every curve at the wrong scale and still look
      // like a plausible board.
      throw new Error(`density has ${p.density.length} samples, the grid has ${GRID_SIZE}`);
    }
    p.density = new Float64Array(p.density);
  }
  return b as WeekBoard;
}

export function liveData(url = "data/board.json", fallback?: () => WeekBoard): DataSource & {
  lastResult(): LoadResult | null;
} {
  let last: LoadResult | null = null;
  return {
    lastResult: () => last,
    async load(): Promise<WeekBoard> {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url} returned ${res.status}`);
        const board = hydrate(await res.json());
        last = {
          board,
          live: true,
          note: `${board.season} week ${board.week}, built ${board.generatedAt.slice(0, 10)} from nflverse`,
        };
        return board;
      } catch (error) {
        if (!fallback) throw error;
        const board = fallback();
        last = {
          board,
          live: false,
          note: `could not load ${url}, so these are generated example numbers and not real football`,
        };
        console.warn("spike: falling back to the fixture board", error);
        return board;
      }
    },
  };
}
