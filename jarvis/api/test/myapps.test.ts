// Made apps' screens (myapps.ts): what survives sanitizing, and every change a
// tap or the assistant can make to what's in them. Pure; no Worker.

import { applyOp, counterValue, pruneState, sanitizeBlocks, type AppState } from "../src/myapps";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

// ---------- Sanitizing ----------

const blocks = sanitizeBlocks([
  { id: "b", kind: "buttons", title: "Quick", buttons: [{ label: "Plan dinner", prompt: "Plan tonight's dinner" }, { label: "" }, { label: "Just a label" }] },
  { id: "l", kind: "list", title: "Groceries", unit: "ignored" },
  { id: "c", kind: "counter", title: "Water", unit: "glasses", goal: "8", step: 0, daily: undefined },
  { id: "g", kind: "log", title: "Workouts" },
  { kind: "note", title: "Empty note", text: "  " },
  { kind: "spaceship", title: "No" },
  { id: "l", kind: "timer", title: "Plank", minutes: 9999 },
  { kind: "buttons", title: "No buttons", buttons: [] },
]);
eq("unknown kinds, empty notes and empty button rows are dropped", blocks.map((b) => b.kind), ["buttons", "list", "counter", "log", "timer"]);
eq("a button with no prompt sends its label", blocks[0].buttons?.[1], { label: "Just a label", prompt: "Just a label" });
eq("fields from other kinds are dropped", "unit" in blocks[1], false);
eq("a list gets a placeholder", blocks[1].placeholder, "Add an item");
eq("goal read from a string, step at least 1, daily by default", [blocks[2].goal, blocks[2].step, blocks[2].daily], [8, 1, true]);
eq("a repeated id is replaced", blocks[4].id !== "l" && blocks[4].id.length > 0, true);
eq("a timer is capped", blocks[4].minutes, 240);
eq("not an array: nothing", sanitizeBlocks("nope"), []);
eq("at most eight parts", sanitizeBlocks(Array.from({ length: 12 }, (_, i) => ({ kind: "list", title: `L${i}` }))).length, 8);

// ---------- Changes ----------

const today = "2026-09-23";
let state: AppState = {};
const apply = (op: Parameters<typeof applyOp>[2], day = today) => {
  const r = applyOp(blocks, state, op, day, 1000);
  if ("state" in r) state = r.state;
  return r;
};

apply({ block: "l", op: "add", text: "  milk  " });
apply({ block: "l", op: "add", text: "eggs" });
eq("added to the list, trimmed", state.l.items?.map((x) => x.text), ["milk", "eggs"]);
const milk = state.l.items![0].id;
apply({ block: "l", op: "toggle", item: milk });
eq("ticked", state.l.items![0].done, true);
apply({ block: "l", op: "toggle", item: milk, done: true });
eq("ticking something ticked leaves it ticked", state.l.items![0].done, true);
apply({ block: "l", op: "clear_done" });
eq("clear done", state.l.items?.map((x) => x.text), ["eggs"]);
eq("an empty add is refused", "error" in apply({ block: "l", op: "add", text: " " }), true);
eq("a list can't count", "error" in apply({ block: "l", op: "count", amount: 1 }), true);
eq("a part that's gone", "error" in apply({ block: "zzz", op: "add", text: "x" }), true);

apply({ block: "c", op: "count" });
apply({ block: "c", op: "count", amount: 2 });
eq("counted by step then by amount", counterValue(blocks[2], state.c, today), 3);
eq("a daily counter reads 0 tomorrow", counterValue(blocks[2], state.c, "2026-09-24"), 0);
apply({ block: "c", op: "count" }, "2026-09-24");
eq("and counts from 0 on the new day", state.c.value, 1);
apply({ block: "c", op: "set", value: 7.456 });
eq("set, to two places", state.c.value, 7.46);

apply({ block: "g", op: "add", text: "Ran 5k" });
apply({ block: "g", op: "add", text: "Swam" });
eq("newest log entry first", state.g.entries?.map((e) => e.text), ["Swam", "Ran 5k"]);
apply({ block: "g", op: "remove", item: state.g.entries![1].id });
eq("an entry removed", state.g.entries?.map((e) => e.text), ["Swam"]);

eq("a part taken away takes its contents", Object.keys(pruneState(blocks.filter((b) => b.id !== "g"), state)).sort(), ["c", "l"]);

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
