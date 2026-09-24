// The setup screen's side of the AI-led setup (app/src/lib/setupScreen.ts),
// checked without a phone. The conversation is the model's; what the phone
// works out is what's shown and what's sent, and it goes wrong quietly: a
// reply's sentences split over bubbles, Try again doubling a reply, the
// account's own first name listed as "understood" before it came up, an unsure
// bedtime stored at the end without ever being listed, a picked
// contact sent with its landline, a device_logs line carrying what was said.

import type { SetupTurnResult, SetupView } from "../../app/src/lib/api";
import {
  appsMade,
  appsMaking,
  contactAnswer,
  latestLine,
  newTurnId,
  setupAgain,
  soFar,
  turnLog,
  wantsContact,
  withoutReply,
  withSentence,
  type Line,
} from "../../app/src/lib/setupScreen";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(got)}${ok ? "" : `  (wanted ${JSON.stringify(want)})`}`);
}

// ---------- Turn ids ----------

// api/src/setup/turn.ts setupTurnSchema takes 8 to 64 characters.
const now = Date.UTC(2026, 8, 23, 20, 27);
const plain = newTurnId(now, () => 0.123456789);
eq("a turn id is 8-64 characters", plain.length >= 8 && plain.length <= 64, true);
eq("even when the random part is empty", newTurnId(now, () => 0).length >= 8, true);
eq("two in the same millisecond differ", newTurnId(now, () => 0.1) !== newTurnId(now, () => 0.2), true);
eq("only letters and digits", /^[a-z0-9]+$/.test(newTurnId()), true);

// ---------- The conversation on screen ----------

let lines: Line[] = [{ from: "you", text: "I get up at seven" }];
lines = withSentence(lines, "t1", "Seven, nice and early.");
lines = withSentence(lines, "t1", "When do you usually get to bed?");
eq("a reply's sentences share one bubble", lines, [
  { from: "you", text: "I get up at seven" },
  { from: "ovoa", text: "Seven, nice and early. When do you usually get to bed?", turn: "t1" },
]);
const next = withSentence([...lines, { from: "you", text: "Eleven" }], "t2", "Got it.");
eq("the next turn's reply is a new bubble", next.length, 4);
eq("a reply straight after another turn's is its own bubble too", withSentence(lines, "t2", "Hi.").length, 3);
eq("the big line is OVOA's latest", latestLine(next), "Got it.");
eq("nothing said yet: no big line", latestLine([{ from: "you", text: "hello?" }]), "");
eq("Try again drops what the failed turn got as far as saying", withoutReply(lines, "t1"), [{ from: "you", text: "I get up at seven" }]);
eq("and keeps every other turn", withoutReply(next, "t1").map((l) => l.text), ["I get up at seven", "Eleven", "Got it."]);

// ---------- What it understood ----------

const objective = (id: string, status: string, shown?: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: id === "day" ? "Your day" : id === "emergency_contact" ? "Emergency contact" : id[0].toUpperCase() + id.slice(1),
  priority: "required",
  status,
  resolved: status === "filled" || status === "declined" || status === "low",
  ...(shown && { shown }),
  ...extra,
});
const view = (patch: Partial<SetupView> = {}): SetupView =>
  ({
    done: false,
    fresh: false,
    mode: "first",
    turns: 3,
    asking: ["goals"],
    objectives: [
      objective("name", "low", "Thomas"),
      objective("day", "filled", "up 7:00, bed 23:00"),
      objective("goals", "open"),
      objective("emergency_contact", "partial", "Danya"),
      objective("work", "declined"),
      objective("workouts", "filled", "gym, mornings", { fromBefore: true }),
    ],
    addons: [],
    apps: [],
    ...patch,
  }) as SetupView;

eq("So far: what's filled, with its value", soFar(view()), [
  { id: "day", label: "Your day", shown: "up 7:00, bed 23:00", checking: false },
  { id: "workouts", label: "Workouts", shown: "gym, mornings", checking: false },
]);
eq("not the account's own first name before it has come up ('low')", soFar(view()).some((o) => o.id === "name"), false);
eq("not a contact with no number yet", soFar(view()).some((o) => o.id === "emergency_contact"), false);
eq("not what they declined", soFar(view()).some((o) => o.id === "work"), false);
eq("nothing before the state is read", soFar(null), []);
// A bedtime heard as 23:00 but marked unsure counts as covered and is stored at
// the end (objectives.ts day: lowResolves, applyLow), so it's listed, marked.
const unsure = view({
  objectives: [
    objective("name", "filled", "Tom"),
    objective("day", "low", "up 7:00, bed 23:00"),
    objective("emergency_contact", "low", "Danya, 555 010 4477", { resolved: false }),
  ],
});
eq("an unsure value that counts as covered is listed, being checked", soFar(unsure).find((o) => o.id === "day"), {
  id: "day",
  label: "Your day",
  shown: "up 7:00, bed 23:00",
  checking: true,
});
eq("a confirmed name is listed", soFar(unsure).find((o) => o.id === "name")?.checking, false);
eq("not an unsure one that isn't covered (a contact is confirmed first)", soFar(unsure).some((o) => o.id === "emergency_contact"), false);
eq(
  "a stored name being checked again is listed",
  soFar(view({ mode: "restart", objectives: [objective("name", "low", "Thomas", { fromBefore: true })] })).map((o) => o.checking),
  [true],
);

eq("no Contacts button while it asks about goals", wantsContact(view()), false);
eq("the Contacts button while it asks who to call", wantsContact(view({ asking: ["emergency_contact"] })), true);
eq("or asks that along with something else", wantsContact(view({ asking: ["daily", "emergency_contact"] })), true);

// ---------- A contact picked ----------

eq("the mobile, not the first number", contactAnswer("Danya Lancheros", [{ label: "home", number: "555 010 1111" }, { label: "mobile", number: "+1 (555) 010-4477" }]), "Danya Lancheros, +1 (555) 010-4477");
eq("an iPhone counts as a mobile", contactAnswer("Sam", [{ label: "work", number: "1" }, { label: "iPhone", number: "555 222 3333" }]), "Sam, 555 222 3333");
eq("no mobile: the first number", contactAnswer("Sam", [{ label: "home", number: " 555 010 1111 " }]), "Sam, 555 010 1111");
eq("an empty number is no number", contactAnswer("Sam", [{ label: "mobile", number: "  " }, { label: "home", number: "555 010 1111" }]), "Sam, 555 010 1111");
eq("no name: the number alone", contactAnswer(null, [{ number: "555 010 1111" }]), "555 010 1111");
eq("no number: nothing to send", contactAnswer("Sam", []), null);
eq("no phones at all", contactAnswer("Sam", undefined), null);

// ---------- Apps for goals ----------

const apps = view({
  apps: [
    { goal: "drink a gallon of water", status: "made", name: "Water", id: "a1" },
    { goal: "read more", status: "making" },
    { goal: "sleep by 11", status: "failed" },
  ],
});
eq("made apps are counted", appsMade(apps), 1);
eq("one still being made", appsMaking(apps), true);
eq("none being made", appsMaking(view()), false);

// ---------- device_logs ----------

const result = (meta: Partial<SetupTurnResult["meta"]>, patch: Partial<SetupView> = {}): SetupTurnResult => ({
  reply: "Danya, got it. What's her number?",
  setup: view({ turns: 4, asking: ["emergency_contact"], ...patch }),
  meta: { ms: 2100, turn: 4, parsed: true, ...meta },
});
eq(
  "a turn's line: timing, engine, what it asks next",
  turnLog(result({ engine: "workers", firstSentenceMs: 1180 })),
  "setup: turn 4 · first sentence 1180 ms · workers · asking emergency_contact",
);
eq("a lost update is said", turnLog(result({ engine: "glm", firstSentenceMs: 4200, parsed: false })).endsWith("its update didn't come through"), true);
eq("a replay says so", turnLog(result({ replayed: true, parsed: false })), "setup: turn 4 · replayed · no engine · asking emergency_contact");
eq("no AI reachable says so", turnLog(result({ unreachable: true, parsed: false })).includes("no AI reachable"), true);
eq("never what was said, nor what it understood", /Danya|number|7:00/.test(turnLog(result({ engine: "workers" }))), false);
eq("nothing asked", turnLog(result({ engine: "workers" }, { asking: [] })).endsWith("asking nothing"), true);

// ---------- Settings ----------

eq("never finished: talk it through again", setupAgain(null).label, "Talk through setup again");
eq("finished: talk it through again", setupAgain(view({ done: true, finished: { at: now, how: "complete", open: [] } })).label, "Talk through setup again");
eq("the hard stop is finished too", setupAgain(view({ done: true, finished: { at: now, how: "budget", open: ["goals"] } })).label, "Talk through setup again");
const later = setupAgain(view({ done: true, finished: { at: now, how: "later", open: ["goals", "emergency_contact"] } }));
eq("put off: finish setting up", later.label, "Finish setting up");
eq("with what's still to talk about", later.about.startsWith("Setup stopped before the end, with goals and emergency contact still to talk about."), true);
eq(
  "stopped with nothing open",
  setupAgain(view({ done: true, finished: { at: now, how: "stopped", open: [] } })).about.startsWith("Setup stopped before the end. "),
  true,
);
eq(
  "three open, listed",
  setupAgain(view({ done: true, finished: { at: now, how: "stopped", open: ["name", "day", "goals"] } })).about.includes("name, your day and goals"),
  true,
);

if (fails) {
  console.log(`\n${fails} failed`);
  process.exit(1);
}
