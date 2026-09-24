// The AI-led setup (src/setup/, 2026-09-23): the model says what it likes and
// fills in what it learned; these check everything around it. How a streamed
// reply is split into speech and its update block, what each value does to the
// state and what it stores, when setup is over, what the model is shown, and a
// few whole turns with the model faked. The stores run for real, on Node's own
// SQLite with every migration applied, so a dedupe that names a wrong column
// fails here and not on someone's first night.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AI_UNREACHABLE } from "../src/llm";
import { applyEffects, emptyMade, OBJECTIVE_IDS, type Effect } from "../src/setup/objectives";
import { NO_WORDS, SETUP_SYSTEM, stateBlock, transcriptTurns, type StateContext } from "../src/setup/prompt";
import { parseUpdate, replySplitter, type Update } from "../src/setup/protocol";
import {
  APP_STALE_MS,
  finishDecision,
  finishState,
  freshState,
  HARD_TURNS,
  loadSetup,
  mergeUpdate,
  readyToWrap,
  replayIfSame,
  sweepStaleSetup,
  updateSetup,
  viewOf,
  type SetupState,
} from "../src/setup/state";
import { finishSetup, restartSetup, setupTurn, setupTurnSchema, setupViewFor } from "../src/setup/turn";
import type { Env } from "../src/types";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${g}${ok ? "" : `  (wanted ${w})`}`);
}

// ---------- The reply, split ----------

const UPDATE = '<update>{"fill":{"day":{"wake":"07:00","bed":"23:00"}},"unsure":[],"decline":[],"asking":["goals"],"end":null}</update>';

/** Feeds a reply in the pieces given, the way a model streams it. */
function split(pieces: string[]) {
  const said: string[] = [];
  const marks: string[] = [];
  const pushes: boolean[] = [];
  const s = replySplitter(
    (x) => said.push(x),
    (spoken) => marks.push(spoken),
  );
  for (const p of pieces) pushes.push(s.push(p));
  s.end();
  return { said, marks, pushes, spoken: s.spoken(), update: parseUpdate(s.trailer()) };
}

{
  const r = split(["Seven and eleven, a proper routine. ", "What would you most like a hand with?\n", UPDATE]);
  eq("(a) the words are spoken", r.spoken, "Seven and eleven, a proper routine. What would you most like a hand with?");
  eq("(a) and the update is read", [r.update?.fill.day, r.update?.asking], [{ wake: "07:00", bed: "23:00" }, ["goals"]]);
  eq("(a) the marker is reached once, with everything spoken", r.marks, [r.spoken]);
}
{
  const r = split(["That's great. <up", 'date>{"fill":{}', ',"asking":[]}</update>']);
  eq("(b) a marker split across pieces is never spoken", r.said.join(" "), "That's great.");
  eq("(b) and the model is never stopped after it", r.pushes, [true, true, true]);
}
eq("(c) a missing closing tag still reads", split(["Nice. ", '<update>{"fill":{"name":{"call":"Tom"}},"asking":[]}']).update?.fill.name, { call: "Tom" });
{
  const r = split(["Got you.\n```json\n", '{"fill":{"goals":{"none":true}}}', "\n```"]);
  eq("(d) JSON in a code fence isn't spoken", r.spoken, "Got you.");
  eq("(d) and is read", r.update?.fill.goals, { none: true });
}
{
  const r = split(['{"fill":{"day":{"wake":"06:30"}},', '"asking":["day"]}']);
  eq("(e) a reply that starts with its JSON says nothing", r.said, []);
  eq("(e) and its update still reads", r.update?.fill.day, { wake: "06:30" });
}
eq("(f) reasoning before the reply is skipped", split(["<think>they said seven", "</think>Up at seven, then. ", UPDATE]).spoken, "Up at seven, then.");
{
  const r = split(["Okay. ", UPDATE, " And one more thing."]);
  eq("(g) text after the update isn't spoken", r.spoken, "Okay.");
  eq("(g) and the update still reads", r.update?.asking, ["goals"]);
}
eq(
  "(h) trailing commas are mended",
  split(["Right. ", '<update>{"fill":{"day":{"wake":"07:00",},},"asking":["goals",],}</update>']).update?.fill.day,
  { wake: "07:00" },
);
{
  const r = split(["Sure thing. ", "<update>{fill: day wake 7}</update>"]);
  eq("(i) garbage in the block reads as no update", r.update, null);
  eq("(i) and the words stand", r.spoken, "Sure thing.");
}
{
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is about something else again.`).join(" ");
  const pushes: boolean[] = [];
  const s = replySplitter(() => {}, () => {});
  for (let i = 0; i < long.length; i += 20) pushes.push(s.push(long.slice(i, i + 20)));
  eq("(j) 800 characters with no update stops the model", pushes.at(-1), false);
  eq("(j) somewhere past 700 spoken", s.spoken().length >= 700 && s.spoken().length < 800, true);
}
{
  const said: string[] = [];
  let marks = 0;
  const s = replySplitter(
    (x) => said.push(x),
    () => marks++,
  );
  s.push("When do you usually get up");
  s.push("?<update>");
  eq("the last sentence goes out at the marker, before the model is done", said.at(-1), "When do you usually get up?");
  s.push('{"fill":{},"asking":["day"]}</update>');
  s.end();
  eq("and the marker is reached once", marks, 1);
  eq("nothing is said twice", said.length, 1);
}
eq("'?<update>' with no space flushes too", split(["Morning person?<update>", '{"fill":{}}</update>']).said, ["Morning person?"]);
eq("a '<' that isn't a tag is spoken", split(["I love you <3 too. ", UPDATE]).spoken, "I love you <3 too.");

// ---------- Reading the update ----------

eq("unknown ids are dropped", parseUpdate('<update>{"fill":{"favourite_colour":"blue","name":{"call":"Sam"}},"asking":["mood","day"]}</update>'), {
  fill: { name: { call: "Sam" } },
  unsure: [],
  decline: [],
  asking: ["day"],
  end: null,
});
eq(
  "the longer shape reads too, low confidence as unsure",
  parseUpdate('{"fill":[{"id":"day","value":{"wake":"08:00"},"confidence":"low"}],"asking":"day","end":"stop"}'),
  { fill: { day: { wake: "08:00" } }, unsure: ["day"], decline: [], asking: ["day"], end: "stop" },
);
eq("at most three asked about", parseUpdate('{"asking":["name","day","goals","work"]}')?.asking, ["name", "day", "goals"]);
eq("no block, no update", parseUpdate(""), null);

// ---------- The state ----------

const T0 = Date.UTC(2026, 8, 23, 20, 0);
const upd = (u: Partial<Update>): Update => ({ fill: {}, unsure: [], decline: [], asking: [], end: null, ...u });
const kinds = (effects: Effect[]) => effects.map((e) => e.kind);

const start = freshState("Thomas Lancheros", T0);
eq("the account's first name is there to confirm, marked unsure", [start.slots.name.status, start.slots.name.value], ["low", { call: "Thomas" }]);
eq("no account name, nothing to confirm", freshState("", T0).slots.name.status, "open");

{
  const one = mergeUpdate(start, upd({ fill: { day: { wake: "10:30" } } }), T0);
  eq("day: a wake time alone is half", one.state.slots.day.status, "partial");
  const two = mergeUpdate(one.state, upd({ fill: { day: { bed: "01:30" } } }), T0);
  eq("day: then bed makes it whole", [two.state.slots.day.status, two.state.slots.day.value], ["filled", { wake: "10:30", bed: "01:30" }]);
  eq("day: with one store", two.effects, [{ kind: "day", wake: 630, bed: 90 }]);
  const bad = mergeUpdate(start, upd({ fill: { day: { wake: "25:00" } } }), T0);
  eq("day: 25:00 is a problem", [bad.problems.length, bad.effects.length, bad.state.slots.day.status], [1, 0, "open"]);
  eq("day: up and to bed at the same time is a problem", mergeUpdate(start, upd({ fill: { day: { wake: "07:00", bed: "7:00" } } }), T0).problems.length, 1);
  eq("day: 7:00 is read as 07:00", mergeUpdate(start, upd({ fill: { day: { wake: "7:00" } } }), T0).state.slots.day.value, { wake: "07:00" });
  eq("a null is the same as leaving it out", mergeUpdate(start, upd({ fill: { day: { wake: "07:00", bed: null } } }), T0).problems, []);
}
{
  const name = mergeUpdate(start, upd({ fill: { emergency_contact: { name: "Danya" } } }), T0);
  eq("contact: a name alone is half an answer, not a problem", [name.state.slots.emergency_contact.status, name.problems, name.effects], ["partial", [], []]);
  const short = mergeUpdate(name.state, upd({ fill: { emergency_contact: { phone: "555" } } }), T0);
  eq("contact: '555' is a problem", short.problems, ['emergency_contact: "555" isn\'t a whole phone number']);
  const unsure = mergeUpdate(name.state, upd({ fill: { emergency_contact: { name: "Danya", phone: "555 010 4477" } }, unsure: ["emergency_contact"] }), T0);
  eq("contact: unsure is kept as low, and nothing is stored", [unsure.state.slots.emergency_contact.status, unsure.effects], ["low", []]);
  const sure = mergeUpdate(unsure.state, upd({ fill: { emergency_contact: { name: "Danya", phone: "555 010 4477" } } }), T0);
  eq("contact: confirmed, it's stored", sure.effects, [{ kind: "contact", name: "Danya", phone: "5550104477" }]);
  const moved = mergeUpdate(sure.state, upd({ fill: { emergency_contact: { phone: "+1 555 010 9999" } } }), T0);
  eq("contact: a new number keeps the name", moved.effects, [{ kind: "contact", name: "Danya", phone: "+15550109999" }]);
  const someone = mergeUpdate(sure.state, upd({ fill: { emergency_contact: { name: "Maria" } } }), T0);
  eq("contact: someone else with no number drops the old number", [someone.state.slots.emergency_contact.status, someone.effects], ["partial", []]);
}
{
  // "Danya, ending 4477?" "Yes, but it's Tanya with a T."
  const heard = mergeUpdate(start, upd({ fill: { emergency_contact: { name: "Danya", phone: "555 010 4477", relation: "sister" } }, unsure: ["emergency_contact"] }), T0);
  const tanya = mergeUpdate(heard.state, upd({ fill: { emergency_contact: { name: "Tanya" } } }), T0);
  eq("contact: a respelled name keeps the number, held to be checked", [tanya.state.slots.emergency_contact, tanya.effects], [
    { status: "low", value: { name: "Tanya", phone: "5550104477", relation: "sister" }, asked: 0, updatedAt: T0 },
    [],
  ]);
  eq("contact: and the model is asked to check it", tanya.problems, ["emergency_contact: kept 5550104477 for Tanya: check it's still their number before it's saved"]);
  const whole = mergeUpdate(heard.state, upd({ fill: { emergency_contact: { name: "Tanya", phone: "555 010 4477" } } }), T0);
  eq("contact: the whole contact sent again is stored as it is", whole.effects, [{ kind: "contact", name: "Tanya", phone: "5550104477" }]);
  const dan = mergeUpdate(heard.state, upd({ fill: { emergency_contact: { name: "Dan", relation: "brother" } } }), T0);
  eq("contact: a close name with another relation is someone else", dan.state.slots.emergency_contact.value, { name: "Dan", relation: "brother" });
}
{
  const med = mergeUpdate(start, upd({ fill: { daily: { items: [{ title: "Vitamin D", kind: "med" }] } } }), T0);
  eq("daily: no time is half, and says so", [med.state.slots.daily.status, med.problems], ["partial", ["daily: needs a time: Vitamin D"]]);
  const timed = mergeUpdate(med.state, upd({ fill: { daily: { items: [{ title: "vitamin d", kind: "med", times: ["8:00"] }] } } }), T0);
  eq("daily: the same item again is one item", (timed.state.slots.daily.value as { items: unknown[] }).items.length, 1);
  eq("daily: with its time, a routine", timed.effects, [{ kind: "routine", key: "med:vitamin-d", routine: "med", title: "vitamin d", times: [480], days: [] }]);
  const gone = mergeUpdate(timed.state, upd({ fill: { daily: { items: [{ title: "Vitamin D", kind: "med", remove: true }] } } }), T0);
  eq("daily: remove turns it off", [gone.state.slots.daily.status, kinds(gone.effects)], ["open", ["unroutine"]]);
  const walk = mergeUpdate(timed.state, upd({ fill: { daily: { items: [{ title: "Walk Max", kind: "pet", times: ["07:00"] }] } } }), T0);
  eq("daily: a new item stores only itself", walk.effects.map((e) => e.kind === "routine" && e.title), ["Walk Max"]);
}
{
  // A misheard medication, then the right one.
  const b = mergeUpdate(start, upd({ fill: { daily: { items: [{ title: "Vitamin B", kind: "med", times: ["08:00"] }] } }, unsure: ["daily"] }), T0);
  eq("daily: an unsure medication is kept, and nothing is stored", [b.state.slots.daily.status, b.effects, b.state.slots.daily.unsure], ["low", [], ["med:vitamin-b"]]);
  const d = mergeUpdate(b.state, upd({ fill: { daily: { items: [{ title: "Vitamin D", kind: "med", times: ["08:00"] }] } } }), T0);
  eq("daily: corrected, only the right one is stored", d.effects.map((e) => e.kind === "routine" && e.title), ["Vitamin D"]);
  eq("daily: and the one never confirmed is taken out, and the model told", [(d.state.slots.daily.value as { items: { title: string }[] }).items.map((i) => i.title), d.problems], [
    ["Vitamin D"],
    ["daily: left out, as it was never confirmed: Vitamin B"],
  ]);
  const yes = mergeUpdate(b.state, upd({ fill: { daily: { items: [{ title: "Vitamin B", kind: "med", times: ["08:00"] }] } } }), T0);
  eq("daily: sent again without the mark, it's stored", [yes.state.slots.daily.status, kinds(yes.effects), yes.state.slots.daily.unsure], ["filled", ["routine"], undefined]);
  const walk = mergeUpdate(start, upd({ fill: { daily: { items: [{ title: "Walk Max", kind: "pet", times: ["07:00"] }] } } }), T0);
  const both = mergeUpdate(walk.state, upd({ fill: { daily: { items: [{ title: "Vitamin B", kind: "med", times: ["08:00"] }] } }, unsure: ["daily"] }), T0);
  const done = finishState(both.state, "complete", T0);
  eq("at finish an item still unsure is taken out, and the rest counts", [done.state.slots.daily, done.effects], [
    { status: "filled", asked: 0, updatedAt: T0, value: { items: [{ title: "Walk Max", kind: "pet", times: ["07:00"] }] } },
    [],
  ]);
}
{
  const water = mergeUpdate(
    start,
    upd({ fill: { goals: { goals: [{ goal: "Drink a gallon of water a day", kind: "habit", detail: "16 oz bottle" }] } }, asking: ["goals"] }),
    T0,
  );
  eq("goals: water is no Calorie and no routine", water.effects, []);
  eq("goals: no app while they're still talking about goals", water.state.made.goals, []);
  const moved = mergeUpdate(water.state, upd({ asking: ["emergency_contact"] }), T0);
  eq("goals: an app once the talk has moved on", moved.effects, [
    { kind: "app", key: "drink-a-gallon-of-water-a-day", goal: "Drink a gallon of water a day", detail: "16 oz bottle" },
  ]);
  eq("goals: and only once", mergeUpdate(moved.state, upd({ fill: { goals: { goals: [{ goal: "drink a gallon of water a day!", kind: "habit" }] } } }), T0).effects, []);
  const five = mergeUpdate(
    start,
    upd({ fill: { goals: { goals: ["Run a 5k", "Sleep by eleven", "Quit vaping", "Stretch daily", "Read more"].map((goal) => ({ goal, kind: "other" })) } } }),
    T0,
  );
  eq("goals: five goals make three apps", kinds(five.effects), ["app", "app", "app"]);
  const eat = mergeUpdate(start, upd({ fill: { goals: { goals: [{ goal: "Eat better", kind: "eating", kcal: 1800 }] } } }), T0);
  eq("goals: eating turns on Calorie with its target, and no app", eat.effects, [{ kind: "food", level: null, kcal: 1800 }]);
  const steps = mergeUpdate(start, upd({ fill: { goals: { goals: [{ goal: "Walk more", kind: "move", steps: 8000 }] } }, asking: ["goals"] }), T0);
  eq("goals: a step target", steps.effects, [{ kind: "steps", steps: 8000 }]);
}
{
  const goalsOf = (s: SetupState) => (s.slots.goals.value as { goals: { goal: string }[] }).goals.map((g) => g.goal);
  const water = mergeUpdate(start, upd({ fill: { goals: { goals: [{ goal: "Drink more water", kind: "habit" }] } }, asking: ["goals"] }), T0);
  const gallon = mergeUpdate(
    water.state,
    upd({ fill: { goals: { goals: [{ goal: "Drink a gallon of water a day", kind: "habit", detail: "a gallon a day" }] } }, asking: ["emergency_contact"] }),
    T0,
  );
  eq("goals: said again in other words, it's one goal and one app", [goalsOf(gallon.state), gallon.effects], [
    ["Drink a gallon of water a day"],
    [{ kind: "app", key: "drink-more-water", goal: "Drink a gallon of water a day", detail: "a gallon a day" }],
  ]);
  const litres = mergeUpdate(gallon.state, upd({ fill: { goals: { goals: [{ goal: "Two litres of water a day", kind: "habit" }] } } }), T0);
  eq("goals: reworded after its app was queued, no second app", [goalsOf(litres.state), litres.effects], [["Two litres of water a day"], []]);
  const soda = mergeUpdate(water.state, upd({ fill: { goals: { goals: [{ goal: "Drink less soda", kind: "habit" }] } }, asking: ["goals"] }), T0);
  eq("goals: another drink is a goal of its own", goalsOf(soda.state), ["Drink more water", "Drink less soda"]);
  const swapped = mergeUpdate(
    water.state,
    upd({ fill: { goals: { goals: [{ goal: "Drink more water", kind: "habit", remove: true }, { goal: "Drink two litres a day", kind: "habit" }] } }, asking: ["goals"] }),
    T0,
  );
  eq("goals: the old one removed and a new one sent is the new one", goalsOf(swapped.state), ["Drink two litres a day"]);
  const unsure = mergeUpdate(start, upd({ fill: { goals: { goals: [{ goal: "Run a 5k", kind: "move" }] } }, unsure: ["goals"], asking: ["goals"] }), T0);
  const vape = mergeUpdate(unsure.state, upd({ fill: { goals: { goals: [{ goal: "Quit vaping", kind: "habit" }] } }, asking: ["day"] }), T0);
  eq("goals: one never confirmed gets no app when another is heard", [goalsOf(vape.state), vape.effects], [
    ["Quit vaping"],
    [{ kind: "app", key: "quit-vaping", goal: "Quit vaping", detail: "" }],
  ]);
}
{
  const allDay = mergeUpdate(start, upd({ fill: { work: { set: true, start: "00:00", end: "23:59" } } }), T0);
  eq("work: all day is 'works all hours', not set hours", [allDay.state.slots.work.value, allDay.effects], [{ set: false, note: "works all hours" }, [{ kind: "work", hours: null }]]);
  eq("work: and the model is told", allDay.problems.length, 1);
  const nine = mergeUpdate(start, upd({ fill: { work: { set: true, start: "09:00", end: "17:00" } } }), T0);
  eq("work: set hours default to weekdays", nine.effects, [{ kind: "work", hours: { days: [1, 2, 3, 4, 5], start: 540, end: 1020 } }]);
  const random = mergeUpdate(start, upd({ fill: { workouts: { does: true, irregular: true } } }), T0);
  eq("workouts: every day at random times is text and no reminder", kinds(random.effects), ["gym", "unroutine"]);
  eq("decline marks it declined", mergeUpdate(start, upd({ decline: ["work"] }), T0).state.slots.work.status, "declined");
  const wrong = mergeUpdate(start, upd({ fill: { day: "seven" } }), T0);
  eq("a value of the wrong shape is a problem", [wrong.problems.length, wrong.state.slots.day.status], [1, "open"]);
  eq("about: health details aren't kept", mergeUpdate(start, upd({ fill: { about: { facts: ["Has type 2 diabetes", "Has a dog named Max"] } } }), T0).state.slots.about.value, {
    facts: ["Has a dog named Max"],
  });
}

// ---------- When it's over ----------

/** A state with every required objective covered. */
function covered(from: SetupState) {
  return mergeUpdate(
    from,
    upd({
      fill: {
        name: { call: "Tom" },
        day: { wake: "07:00", bed: "23:00" },
        goals: { none: true },
        emergency_contact: { name: "Danya", phone: "555 010 4477", relation: "sister" },
      },
    }),
    T0,
  ).state;
}

eq("not ready: day, goals and a contact still open", readyToWrap(start), { ready: false, open: ["day", "goals", "emergency_contact"] });
eq("ready once they're covered", readyToWrap(covered(start)).ready, true);
eq("carrying on when ready and nobody wrapped up", finishDecision(covered(start), upd({})), null);
eq("an early wrap-up is honoured", finishDecision(start, upd({ end: "complete" })), "complete");
eq("with what was still open written down", finishState(start, "complete", T0).state.finished, { at: T0, how: "complete", open: ["day", "goals", "emergency_contact"] });
eq("stop", finishDecision(start, upd({ end: "stop" })), "stopped");
eq("the budget", finishDecision({ ...start, turns: HARD_TURNS }, upd({})), "budget");
eq("the budget with no update at all", finishDecision({ ...start, turns: HARD_TURNS }, null), "budget");
{
  const low = mergeUpdate(start, upd({ fill: { day: { wake: "07:00", bed: "23:00" }, emergency_contact: { name: "Danya", phone: "5550104477" } }, unsure: ["day", "emergency_contact"] }), T0).state;
  const done = finishState({ ...low, transcript: [{ role: "user", text: "hi", at: T0 }] }, "later", T0);
  eq("at finish an unsure wake time is stored, never an unsure contact", kinds(done.effects), ["day"]);
  eq("and the conversation is cleared", done.state.transcript, []);
}

// ---------- What the model is shown ----------

const ctx: StateContext = {
  assistantName: "OVOA",
  now: T0,
  timeZone: "America/New_York",
  typed: false,
  accountName: "Thomas Lancheros",
  googleAccounts: ["a@example.com"],
  apps: [],
  answering: true,
};

{
  const block = stateBlock(start, ctx);
  const listed = [...block.matchAll(/^- (\w+) \((required|ask|optional)\)/gm)].map((m) => m[1]);
  eq("every objective once, in order", listed, [...OBJECTIVE_IDS]);
  eq("not ready yet, and what's open", block.includes("Ready to wrap up: no (still open: day, goals, emergency_contact)"), true);
  eq("one Google account isn't listed", block.includes("a@example.com"), false);
  eq("two are", stateBlock(start, { ...ctx, googleAccounts: ["a@example.com", "b@example.com"] }).includes("a@example.com, b@example.com"), true);
  eq("talking out loud", block.includes("They're talking out loud."), true);
  eq("their local time", block.includes("Wednesday 4:00 PM (America/New_York)"), true);
  eq("ready says so", stateBlock(covered(start), ctx).includes("Ready to wrap up: yes"), true);
  eq("a lost update is healed next turn", stateBlock({ ...start, lostUpdate: true }, ctx).includes("Your last update didn't come through"), true);
  const dodged = { ...start, slots: { ...start.slots, goals: { status: "open" as const, asked: 2 } } };
  eq("asked twice says what to do", stateBlock(dodged, ctx).includes("goals (required): open; asked twice: if they dodge again, mark it declined"), true);
  eq("the last allowed answer", stateBlock({ ...start, turns: HARD_TURNS - 1 }, ctx).includes("This must be your last reply"), true);
  eq("problems are passed on", stateBlock({ ...start, problems: ["daily: needs a time: Vitamin D"] }, ctx).includes("Problems saving last turn: daily: needs a time: Vitamin D"), true);
}
{
  let full = covered(start);
  full = mergeUpdate(
    full,
    upd({
      fill: {
        daily: { items: [{ title: "Vitamin D", kind: "med", times: ["08:00"] }, { title: "Walk Max", kind: "pet", times: ["11:00", "15:00", "20:00"] }] },
        work: { set: true, days: ["monday", "tuesday", "wednesday", "thursday", "friday"], start: "09:00", end: "17:30", account: "tom@work.example.com" },
        workouts: { does: true, what: "gym", days: ["monday", "wednesday", "friday"], time: "18:00" },
        nicknames: { names: ["T", "Tommy"] },
        leaving: { items: ["keys", "wallet", "headphones"] },
        focus: { areas: ["sleep", "bills"], note: "I keep forgetting things in the afternoon" },
        about: { facts: ["Has a dog named Max", "Works in marketing", "Loves hiking on weekends"] },
      },
    }),
    T0,
  ).state;
  const block = stateBlock(full, { ...ctx, googleAccounts: ["tom@home.example.com", "tom@work.example.com"], apps: [{ goal: "Drink more water", status: "making" }] });
  eq("under 1,500 characters with everything filled", block.length < 1500 ? "under" : block.length, "under");
}
eq("the system text is the same for everyone", SETUP_SYSTEM.includes("Thomas") || SETUP_SYSTEM.includes("[Setup state, from"), false);
eq("and no example line to parrot", /Half one\?|thanks for sharing/i.test(SETUP_SYSTEM), false);
{
  const lines = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? ("ovoa" as const) : ("user" as const), text: `line ${i} ${"x".repeat(i === 29 ? 0 : 10)}`, at: T0 }));
  const turns = transcriptTurns({ ...start, transcript: lines });
  eq("at most 16 lines, starting with theirs", [turns.length <= 16, turns[0].role], [true, "user"]);
  const long = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? ("ovoa" as const) : ("user" as const), text: "y".repeat(600), at: T0 }));
  eq("at most 3,500 characters", transcriptTurns({ ...start, transcript: long }).reduce((n, t) => n + t.text.length, 0) <= 3500, true);
}

// ---------- The view ----------

{
  const apps = {
    water: { goal: "Drink more water", detail: "", status: "queued" as const, at: T0, tries: 1 },
    sleep: { goal: "Sleep by eleven", detail: "", status: "queued" as const, at: T0 - APP_STALE_MS - 1, tries: 1 },
    vape: { goal: "Quit vaping", detail: "", status: "made" as const, appId: "app1", name: "Vape Free", at: T0, tries: 1 },
  };
  const view = viewOf(covered(start), apps, T0);
  eq("apps: being made, gone stale, made", view.apps, [
    { goal: "Drink more water", status: "making" },
    { goal: "Sleep by eleven", status: "failed" },
    { goal: "Quit vaping", status: "made", name: "Vape Free", id: "app1" },
  ]);
  eq("four required", view.objectives.filter((o) => o.priority === "required").length, 4);
  eq("what's covered is shown, for a misheard value to be seen", view.objectives.find((o) => o.id === "emergency_contact")?.shown, "Danya (sister), 5550104477");
  eq("fresh until something is said", [viewOf(start, {}, T0).fresh, viewOf({ ...start, turns: 1 }, {}, T0).fresh], [true, false]);
}
eq("a turn sent twice replays", replayIfSame({ ...start, lastTurn: { id: "turn-0001", reply: "Hello." } }, "turn-0001"), "Hello.");
eq("a turn cut off after its words replays too", replayIfSame({ ...start, transcript: [{ role: "ovoa", text: "Hi.", at: T0, turn: "turn-0002" }] }, "turn-0002"), "Hi.");
eq("a new one doesn't", replayIfSame(start, "turn-0003"), null);
eq("an answer needs its words", setupTurnSchema.safeParse({ turnId: "turn-0004", action: "answer" }).success, false);

// ---------- Against the database ----------

function d1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (list: ReturnType<typeof statement>[]) => {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of list) out.push(await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
  sqlite.exec(readFileSync(`migrations/${file}`, "utf8"));
}
sqlite.exec("PRAGMA foreign_keys = ON");
const DB = d1(sqlite);
const q = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined;
const count = (sql: string, ...args: unknown[]) => Number(Object.values(q(sql, ...args) ?? { n: 0 })[0]);

function newUser(name = "Thomas Lancheros") {
  const id = crypto.randomUUID();
  sqlite.prepare("INSERT INTO users (id, email, password_hash, password_salt, name, created_at) VALUES (?, ?, '', '', ?, 0)").run(id, `${id}@example.com`, name);
  sqlite.prepare("INSERT INTO settings (user_id, assistant_name, updated_at) VALUES (?, 'OVOA', 0)").run(id);
  return id;
}

/** waitUntil, kept, so a test can wait for what a turn left running. */
function context() {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, settle: () => Promise.allSettled(pending) };
}

const encoder = new TextEncoder();
/** Text as the stream's events, in small pieces. */
const events = (text: string) =>
  Array.from({ length: Math.ceil(text.length / 12) }, (_, i) =>
    encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i * 12, i * 12 + 12) } }] })}\n\n`),
  );
const DONE = encoder.encode("data: [DONE]\n\n");

/** A Workers AI binding that streams the replies it's handed, and keeps what it was asked. */
function fakeAi(replies: (string | ReadableStream<Uint8Array>)[]) {
  const asked: any[] = [];
  const ai = {
    run: async (_model: string, inputs: any) => {
      asked.push(inputs);
      const reply = replies.shift();
      if (reply === undefined) throw new Error("no more replies");
      if (typeof reply !== "string") return reply;
      return new ReadableStream<Uint8Array>({
        start(c) {
          for (const e of events(reply)) c.enqueue(e);
          c.enqueue(DONE);
          c.close();
        },
      });
    },
  };
  return { ai: ai as unknown as Ai, asked };
}

/** A reply that sends `head`, then waits for go() before sending `tail`, or failing with it. */
function heldReply(head: string, tail: string | Error) {
  let go!: () => void;
  const released = new Promise<void>((resolve) => (go = resolve));
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      for (const e of events(head)) c.enqueue(e);
      await released;
      if (tail instanceof Error) return c.error(tail);
      for (const e of events(tail)) c.enqueue(e);
      c.enqueue(DONE);
      c.close();
    },
  });
  return { stream, go };
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200 && !(await check()); i++) await new Promise((r) => setTimeout(r, 5));
}

const envWith = (ai?: Ai) => ({ DB, CHAT_MODEL: "test", MEMORY_MODEL: "test", ...(ai && { AI: ai }) }) as unknown as Env;
const env = envWith();
const made = () => emptyMade();

await (async () => {
  // The name is only replaced by a genuinely different one.
  {
    const u = newUser();
    await applyEffects(env, u, [{ kind: "name", call: "Thomas" }], { accountName: "Thomas Lancheros", made: made() });
    eq("'Thomas' for 'Thomas Lancheros' keeps the full name", q("SELECT name FROM users WHERE id = ?", u)?.name, "Thomas Lancheros");
    await applyEffects(env, u, [{ kind: "name", call: "Tom" }], { accountName: "Thomas Lancheros", made: made() });
    eq("'Tom' is theirs", q("SELECT name FROM users WHERE id = ?", u)?.name, "Tom");
  }

  // Contacts: one per number, a corrected number updated in place.
  {
    const u = newUser();
    const first = await applyEffects(env, u, [{ kind: "contact", name: "Danya", phone: "5550104477" }], { accountName: "", made: made() });
    const again = await applyEffects(env, u, [{ kind: "contact", name: "Danya", phone: "+5550104477" }], { accountName: "", made: made() });
    eq("the same digits twice is one contact", [count("SELECT COUNT(*) FROM emergency_contacts WHERE user_id = ?", u), again.made.contactId], [1, first.made.contactId]);
    await applyEffects(env, u, [{ kind: "contact", name: "Danya", phone: "5550109999" }], { accountName: "", made: first.made });
    eq(
      "a corrected number updates the contact setup added",
      [count("SELECT COUNT(*) FROM emergency_contacts WHERE user_id = ?", u), q("SELECT phone FROM emergency_contacts WHERE user_id = ?", u)?.phone],
      [1, "5550109999"],
    );
    await applyEffects(env, u, [{ kind: "contact", name: "Tanya", phone: "555 010 9999" }], { accountName: "", made: first.made });
    eq(
      "the same number under a corrected name takes the name",
      [count("SELECT COUNT(*) FROM emergency_contacts WHERE user_id = ?", u), q("SELECT name FROM emergency_contacts WHERE user_id = ?", u)?.name],
      [1, "Tanya"],
    );
  }

  // Routines: medication into Apple Reminders, the same title updated, remove turns it off, the cap a problem.
  {
    const u = newUser();
    const vitamin = (times: number[]): Effect => ({ kind: "routine", key: "med:vitamin-d", routine: "med", title: "Vitamin D", times, days: [] });
    const one = await applyEffects(env, u, [vitamin([480])], { accountName: "", made: made() });
    eq("a medication goes to Apple Reminders, urgent", q("SELECT external_source, urgent FROM routines WHERE user_id = ?", u), { external_source: "apple_reminders", urgent: 1 });
    eq("and the phone is told", one.routinesChanged, true);
    await applyEffects(env, u, [{ ...vitamin([540]), title: "vitamin d" }], { accountName: "", made: made() });
    eq(
      "the same title from another turn updates the row",
      [count("SELECT COUNT(*) FROM routines WHERE user_id = ? AND active = 1", u), q("SELECT times FROM routines WHERE user_id = ?", u)?.times],
      [1, "[540]"],
    );
    await applyEffects(env, u, [{ kind: "unroutine", key: "med:vitamin-d", routine: "med", title: "Vitamin D" }], { accountName: "", made: made() });
    eq("remove turns it off", count("SELECT COUNT(*) FROM routines WHERE user_id = ? AND active = 1", u), 0);
    const full = newUser();
    for (let i = 0; i < 60; i++) {
      sqlite
        .prepare("INSERT INTO routines (id, user_id, kind, title, times, days, buzz_pattern, window_minutes, created_at, updated_at) VALUES (?, ?, 'habit', ?, '[480]', '[]', 'reminder', 120, 0, 0)")
        .run(crypto.randomUUID(), full, `Thing ${i}`);
    }
    const capped = await applyEffects(env, full, [vitamin([480])], { accountName: "", made: made() });
    eq("at the routine cap it's a problem, not a failed turn", capped.problems.length === 1 && capped.problems[0].startsWith("daily: couldn't add Vitamin D"), true);
  }

  // Going through setup again leaves reminders made elsewhere as they are.
  {
    const u = newUser();
    const habit = (title: string, times: number[]) =>
      sqlite
        .prepare("INSERT INTO routines (id, user_id, kind, title, times, days, buzz_pattern, window_minutes, created_at, updated_at) VALUES (?, ?, 'habit', ?, ?, '[]', 'reminder', 120, 0, 0)")
        .run(crypto.randomUUID(), u, title, JSON.stringify(times));
    habit("Water", [480, 600, 720, 840, 960, 1080, 1200, 1320]);
    habit("Stand up", Array.from({ length: 14 }, (_, i) => 420 + i * 60));
    const view = await restartSetup(env, u);
    eq(
      "every time of a reminder is shown, and one with more than setup keeps isn't",
      view.objectives.find((o) => o.id === "daily")?.shown,
      "Water 08:00, 10:00, 12:00, 14:00, 16:00, 18:00, 20:00, 22:00",
    );
    const { state } = await loadSetup(DB, u);
    const walk = mergeUpdate(state!, upd({ fill: { daily: { items: [{ title: "Walk the dog", kind: "pet", times: ["07:00"] }] } } }), T0);
    await applyEffects(env, u, walk.effects, { accountName: "", made: state!.made });
    eq(
      "a new reminder leaves the others untouched",
      [kinds(walk.effects), q("SELECT times, updated_at FROM routines WHERE user_id = ? AND title = 'Water'", u), count("SELECT COUNT(*) FROM routines WHERE user_id = ?", u)],
      [["routine"], { times: "[480,600,720,840,960,1080,1200,1320]", updated_at: 0 }, 3],
    );
  }

  // Goals: eating turns on Calorie, a step target is the step goal, an app goal is a job.
  {
    const u = newUser();
    const done = await applyEffects(
      env,
      u,
      [
        { kind: "food", level: null, kcal: 1800 },
        { kind: "steps", steps: 8000 },
        { kind: "app", key: "drink-water", goal: "Drink water", detail: "" },
      ],
      { accountName: "", made: made() },
    );
    eq("Calorie on, with its target", [q("SELECT food_detail, kcal_target FROM profile WHERE user_id = ?", u), done.made.addons], [{ food_detail: "normal", kcal_target: 1800 }, ["calorie"]]);
    eq("the step goal", q("SELECT step_goal FROM settings WHERE user_id = ?", u)?.step_goal, 8000);
    eq("the app is a job for the background", [done.jobs.length, count("SELECT COUNT(*) FROM routines WHERE user_id = ?", u)], [1, 0]);
  }

  // Two turns from the same rev: both fills end up saved, and one contact.
  {
    const u = newUser();
    const fresh = () => freshState("Thomas Lancheros", T0);
    let changes = 0;
    const merge = (update: Update) => (current: SetupState) => {
      changes++;
      const m = mergeUpdate(current, update, T0);
      return { state: m.state, out: m.effects };
    };
    const contact = { name: "Danya", phone: "555 010 4477" };
    const [a, b] = await Promise.all([
      updateSetup(DB, u, merge(upd({ fill: { day: { wake: "07:00", bed: "23:00" }, emergency_contact: contact } })), fresh),
      updateSetup(DB, u, merge(upd({ fill: { goals: { none: true }, emergency_contact: contact } })), fresh),
    ]);
    eq("the second turn found the first's save and merged again", changes, 3);
    await Promise.all([a, b].map((r) => applyEffects(env, u, r.out, { accountName: "", made: made() })));
    const { state } = await loadSetup(DB, u);
    eq("both turns' fills are there", [state?.slots.day.status, state?.slots.goals.status], ["filled", "filled"]);
    eq("and one contact", count("SELECT COUNT(*) FROM emergency_contacts WHERE user_id = ?", u), 1);
  }

  // The 14-day sweep.
  {
    const old = newUser();
    const recent = newUser();
    for (const [u, at] of [[old, T0 - 20 * 86_400_000], [recent, T0]] as const) {
      sqlite.prepare("INSERT INTO profile (user_id, updated_at, setup_state, setup_apps) VALUES (?, 0, ?, '{}')").run(u, JSON.stringify({ ...start, updatedAt: at }));
    }
    const cleared = await sweepStaleSetup(DB, T0 - 14 * 86_400_000);
    eq("a setup untouched for 14 days goes", [cleared, q("SELECT setup_state FROM profile WHERE user_id = ?", old)?.setup_state], [1, null]);
    eq("a recent one stays", q("SELECT setup_state FROM profile WHERE user_id = ?", recent)?.setup_state !== null, true);
  }

  // Whole turns, with the model faked.
  {
    const u = newUser();
    const { ai, asked } = fakeAi([
      'Hi, I\'m OVOA. Should I call you Thomas, or something else?\n<update>{"fill":{},"asking":["name"],"end":null}</update>',
      'Tom it is. Seven and eleven sounds steady. What would you most like a hand with?<update>{"fill":{"name":{"call":"Tom"},"day":{"wake":"07:00","bed":"23:00"}},"asking":["goals"],"end":null}</update>',
    ]);
    const e = envWith(ai);
    const { ctx: c1, settle } = context();
    const heard: string[] = [];
    const first = await setupTurn(e, c1, u, { turnId: "turn-start-1", action: "start", timeZone: "America/Chicago" }, (s) => heard.push(s));
    await settle();
    eq("the time zone is written on the first turn", q("SELECT time_zone FROM settings WHERE user_id = ?", u)?.time_zone, "America/Chicago");
    eq("the opener is streamed sentence by sentence", heard, ["Hi, I'm OVOA.", "Should I call you Thomas, or something else?"]);
    eq("the model got the fixed system text", asked[0].messages[0].content === SETUP_SYSTEM, true);
    eq("and the state and the event as the message", /\[Setup state[\s\S]*\(The call just started/.test(asked[0].messages.at(-1).content), true);
    eq("the call starting isn't an answer", [first.view.fresh, first.view.turns, first.view.asking], [false, 0, ["name"]]);

    const second = await setupTurn(e, c1, u, { turnId: "turn-answer-1", action: "answer", text: "Tom's fine. Up at seven, bed at eleven." });
    await settle();
    eq("the earlier lines are sent as the conversation", asked[1].messages.slice(1, -1).map((m: any) => m.role), ["user", "assistant"]);
    eq("their words are quoted after the state", asked[1].messages.at(-1).content.endsWith('They said: "Tom\'s fine. Up at seven, bed at eleven."'), true);
    eq("the name is theirs now", q("SELECT name FROM users WHERE id = ?", u)?.name, "Tom");
    eq("and their day is stored", q("SELECT wake_time, sleep_time FROM profile WHERE user_id = ?", u), { wake_time: 420, sleep_time: 1380 });
    eq("the view says what was covered", second.view.objectives.filter((o) => o.resolved).map((o) => o.id), ["name", "day"]);
    eq("one answer so far", second.view.turns, 1);

    const again = await setupTurn(e, c1, u, { turnId: "turn-answer-1", action: "answer", text: "Tom's fine. Up at seven, bed at eleven." });
    eq("the same turn again replays, with no model call", [again.reply, again.meta.replayed, asked.length], [second.reply, true, 2]);

    const later = await finishSetup(e, c1, u, "later");
    await settle();
    eq("Later finishes it", [later.done, later.finished?.how, q("SELECT onboarded_at IS NOT NULL AS done FROM profile WHERE user_id = ?", u)?.done], [true, "later", 1]);
    const after = await setupTurn(e, c1, u, { turnId: "turn-answer-2", action: "answer", text: "hello?" });
    eq("a finished setup asks nothing", [after.reply, after.view.done, asked.length], ["", true, 2]);

    const again2 = await restartSetup(e, u);
    const day = again2.objectives.find((o) => o.id === "day");
    eq("going through it again starts from what's stored", [again2.done, day?.status, day?.fromBefore, day?.shown], [false, "filled", true, "up 07:00, bed 23:00"]);
    eq("and it's no longer done", (await setupViewFor(e, u)).done, false);
  }
  {
    const u = newUser();
    const { ai } = fakeAi([
      'All set, Tom. Talk to me any time.<update>{"fill":{},"asking":[],"end":"complete"}</update>',
    ]);
    const { ctx: c2, settle } = context();
    const done = await setupTurn(envWith(ai), c2, u, { turnId: "turn-early-1", action: "answer", text: "that's all, thanks" });
    await settle();
    const { state } = await loadSetup(DB, u);
    eq("a wrap-up finishes setup", [done.view.done, done.view.finished?.how, done.view.finished?.open], [true, "complete", ["day", "goals", "emergency_contact"]]);
    eq("clears the conversation", state?.transcript, []);
    eq("and marks them set up", q("SELECT onboarded_at IS NOT NULL AS done, step FROM profile WHERE user_id = ?", u), { done: 1, step: null });
  }
  {
    // The reply is saved the moment its words are out, while the update is still being written.
    const u = newUser();
    const held = heldReply(
      'Seven and eleven, got it. What are you hoping I can help with?<update>{"fill":{"day":',
      '{"wake":"07:00","bed":"23:00"}},"asking":["goals"],"end":null}</update>',
    );
    const { ai } = fakeAi([held.stream]);
    const heard: string[] = [];
    const { ctx: c4, settle } = context();
    const turn = setupTurn(envWith(ai), c4, u, { turnId: "turn-held-1", action: "answer", text: "seven and eleven" }, (s) => heard.push(s));
    const saved = async () => (await loadSetup(DB, u)).state?.transcript.map((l) => l.role) ?? [];
    await waitFor(async () => (await saved()).length === 2);
    eq("at the marker the last sentence is out", heard.at(-1), "What are you hoping I can help with?");
    eq("and the lines are saved before the update is written", await saved(), ["user", "ovoa"]);
    held.go();
    const out = await turn;
    await settle();
    eq("then the update lands", [out.view.objectives.find((o) => o.id === "day")?.status, out.view.turns], ["filled", 1]);
    eq("with the lines saved once", await saved(), ["user", "ovoa"]);
  }
  {
    // Skip, a lost update, and a reply with no words.
    const u = newUser();
    const { ai, asked } = fakeAi([
      'Do you work set hours?<update>{"fill":{},"asking":["work"],"end":null}</update>',
      'No problem, we can leave that. When do you usually get up?<update>{"fill":{},"asking":["day"]',
      '<update>{"fill":{},"asking":[]}</update>',
      'Up at six, early bird. Any goals you want help with?<update>{"fill":{"day":{"wake":"06:00","bed":"22:00"}},"asking":["goals"]}</update>',
    ]);
    const e = envWith(ai);
    const { ctx: c5, settle } = context();
    await setupTurn(e, c5, u, { turnId: "turn-work-1", action: "answer", text: "hi" });
    const skipped = await setupTurn(e, c5, u, { turnId: "turn-skip-1", action: "skip" });
    await settle();
    eq("Skip declines what was asked", skipped.view.objectives.find((o) => o.id === "work")?.status, "declined");
    eq("and the model is told", asked[1].messages.at(-1).content.includes("(They pressed Skip while you were asking about: work."), true);
    eq("a reply whose update was lost still stands", skipped.reply, "No problem, we can leave that. When do you usually get up?");
    eq("and it's marked lost", (await loadSetup(DB, u)).state?.lostUpdate, true);
    const healed = await setupTurn(e, c5, u, { turnId: "turn-day-1", action: "answer", text: "six, and ten at night" });
    await settle();
    eq("a reply with no words is asked for again, told why", [asked.length, asked[3].messages.at(-1).content.endsWith(NO_WORDS)], [4, true]);
    eq("the lost update is asked for on the next turn", asked[2].messages.at(-1).content.includes("Your last update didn't come through"), true);
    eq("and the words of the second try are the reply", [healed.reply, healed.view.objectives.find((o) => o.id === "day")?.status], [
      "Up at six, early bird. Any goals you want help with?",
      "filled",
    ]);
  }
  {
    // A lost update after a turn that asked for the contact: Skip mustn't decline the contact.
    const u = newUser();
    const { ai, asked } = fakeAi([
      'Who should I text if you ever press SOS?<update>{"fill":{},"asking":["emergency_contact"],"end":null}</update>',
      'Do you work set hours?<update>{"fill":{},"asking":["work"]',
      'Sure, moving on. When do you usually get up?<update>{"fill":{},"asking":["day"],"end":null}</update>',
    ]);
    const e = envWith(ai);
    const { ctx: c7, settle } = context();
    await setupTurn(e, c7, u, { turnId: "turn-sos-1", action: "answer", text: "hi" });
    const lost = await setupTurn(e, c7, u, { turnId: "turn-lost-2", action: "answer", text: "my sister" });
    eq("a lost update asks about nothing, so the Contacts picker goes", [lost.meta.parsed, lost.view.asking], [false, []]);
    const skip = await setupTurn(e, c7, u, { turnId: "turn-skip-2", action: "skip" });
    await settle();
    eq("and Skip after it declines nothing", [
      skip.view.objectives.find((o) => o.id === "emergency_contact")?.status,
      asked[2].messages.at(-1).content.endsWith("(They pressed Skip. Move on to something else.)"),
    ], ["open", true]);
  }
  {
    // Cut off in the update: the words were all said, so the turn stands. (Cools the engine down a moment.)
    const u = newUser();
    const cut = heldReply('Lovely. Anything you want a nudge for?<update>{"fill":', new Error("the stream was reset"));
    const { ai } = fakeAi([cut.stream]);
    const { ctx: c6, settle } = context();
    const heard: string[] = [];
    const turn = setupTurn(envWith(ai), c6, u, { turnId: "turn-cut-1", action: "answer", text: "nope" }, (s) => heard.push(s));
    // Only once the words are read: an errored stream drops what's still queued.
    await waitFor(() => heard.length === 2);
    cut.go();
    const out = await turn;
    await settle();
    eq("a reply cut off in its update stands", [out.reply, out.meta.parsed, (await loadSetup(DB, u)).state?.lostUpdate], ["Lovely. Anything you want a nudge for?", false, true]);
  }
  {
    // Last: an engine that fails is cooled down for the rest of this process.
    const u = newUser();
    const { ai } = fakeAi([]);
    const heard: string[] = [];
    const { ctx: c3, settle } = context();
    const out = await setupTurn(envWith(ai), c3, u, { turnId: "turn-down-1", action: "start" }, (s) => heard.push(s));
    await settle();
    eq("no AI: one plain sentence", [heard, out.reply, out.meta.unreachable], [[AI_UNREACHABLE], AI_UNREACHABLE, true]);
    eq("and nothing saved", (await loadSetup(DB, u)).state, null);
  }
})();

if (fails) {
  console.log(`\n${fails} check(s) failed`);
  process.exit(1);
}
