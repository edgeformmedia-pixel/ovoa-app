// Spreading per-person sweeps across ticks (sweep.ts). The promise is that each
// person is looked at on exactly one tick in five — never skipped, never twice —
// and that the ticks share the work evenly.

import { inSlice, sliceFor, SWEEP_EVERY } from "../src/sweep";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

const people = Array.from({ length: 5000 }, () => crypto.randomUUID());
const perSlice = Array(SWEEP_EVERY).fill(0);
let exactlyOnce = 0;
for (const id of people) {
  let hits = 0;
  for (let index = 0; index < SWEEP_EVERY; index++) {
    if (inSlice(id, { index, of: SWEEP_EVERY })) {
      hits++;
      perSlice[index]++;
    }
  }
  if (hits === 1) exactlyOnce++;
}
eq("everyone is in exactly one slice", exactlyOnce, people.length);
const even = perSlice.every((n) => Math.abs(n - people.length / SWEEP_EVERY) < people.length * 0.03);
eq("the slices are within 3% of even", even, true);
eq("no slice means everyone (a tick run by hand)", inSlice(people[0]), true);

// Five consecutive ticks cover all five slices once.
const start = Date.UTC(2026, 8, 22, 12, 0);
const indexes = Array.from({ length: SWEEP_EVERY }, (_, i) => sliceFor(start + i * 120_000).index).sort();
eq("five ticks in a row visit every slice", indexes, [0, 1, 2, 3, 4]);
eq("a tick's slice doesn't depend on seconds within it", sliceFor(start + 59_000).index, sliceFor(start).index);

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
console.log("\nall passed");
