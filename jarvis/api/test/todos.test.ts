// What makes tomorrow's list, and when bedtime is. A list that puts an old note
// above something promised to a person for tomorrow is a list nobody reads; a
// bedtime of 00:30 that fires the night after is a nudge at the wrong time.

import { bedtimeFor, pick, score, type Candidate } from "../src/todos";
import { atLocalTime } from "../src/time";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const c = (text: string, p: Partial<Candidate> = {}): Candidate => ({
  text,
  source: "note",
  sourceId: null,
  dueSoon: false,
  fromPerson: false,
  ageDays: 0,
  priority: 0,
  ...p,
});

eq("due tomorrow beats owed to someone", score(c("a", { dueSoon: true })) > score(c("b", { fromPerson: true })), true);
eq("owed to someone beats a week-old note", score(c("a", { fromPerson: true })) > score(c("b", { ageDays: 3 })), true);
eq("age stops counting after a week", score(c("a", { ageDays: 90 })), score(c("b", { ageDays: 7 })));

const top = pick([
  c("Old idea", { ageDays: 30 }),
  c("Send Sarah the deck", { dueSoon: true, fromPerson: true }),
  c("send sarah the deck!", { ageDays: 1 }),
  ...Array.from({ length: 12 }, (_, i) => c(`filler ${i}`)),
]);
eq("ten at most", top.length, 10);
eq("the most pressing is first", top[0].text, "Send Sarah the deck");
eq("the same thing twice is kept once", top.filter((t) => t.text.toLowerCase().startsWith("send sarah")).length, 1);
eq("an old idea still makes it above nothing", top[1].text, "Old idea");

const NY = "America/New_York";
eq("11pm bedtime is that evening", bedtimeFor("2026-09-20", 23 * 60, NY), atLocalTime("2026-09-20", 23 * 60, NY));
eq("00:30 bedtime is after midnight, same evening", bedtimeFor("2026-09-20", 30, NY), atLocalTime("2026-09-21", 30, NY));

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
