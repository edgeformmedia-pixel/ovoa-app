// Spreading the per-person sweeps across ticks.
//
// Four parts of the two-minute tick (rhythm, extras, evening, money) walk every
// person with the app, doing a few queries and sometimes a Google call each.
// Fine for one person; with many, one tick is thousands of queries, and a
// Worker invocation has a hard cap on how many it may make — past it, the rest
// of the tick fails. None of those sweeps needs two-minute precision (the
// windows they check are ten minutes or more), so each person is looked at on
// one tick in SWEEP_EVERY: a fifth of the work per tick, everyone every ten
// minutes.

/** Ticks per round: each person is swept once every SWEEP_EVERY × 2 minutes. */
export const SWEEP_EVERY = 5;
const TICK_MS = 2 * 60_000;

/** This tick's share of the people. Undefined means everyone (a tick run by hand). */
export type Slice = { index: number; of: number };

export function sliceFor(at: number, of = SWEEP_EVERY): Slice {
  return { index: Math.floor(at / TICK_MS) % of, of };
}

/** Whether this person is swept on this tick. Stable per person, spread evenly. */
export function inSlice(userId: string, slice?: Slice) {
  if (!slice) return true;
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % slice.of === slice.index;
}
