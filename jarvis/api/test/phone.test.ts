// The phone section of the prompt (phone.ts phonePrompt). A line that sends the
// model the long way round costs a whole round out loud: searching Contacts
// before a text was a round, a phone pause and a resume (one text took 23.0 s,
// 2026-09-23), and a line naming a tool the turn doesn't carry sent the model
// to more_tools first.

import { phonePrompt, phoneToolSpecs, type PhoneCaps } from "../src/phone";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const guarded: PhoneCaps = { lookups: true, capabilities: ["location", "health"], autoSendTexts: true, recipientGuard: true };
const build67: PhoneCaps = { lookups: true, capabilities: ["location", "health"], autoSendTexts: true };
// What a spoken turn carries (toolbelt.ts SPOKEN_CORE): no location.
const spokenCore = (tool: string) => ["phone_message_compose", "phone_call", "phone_contacts_search", "phone_calendar_events", "phone_reminders_list"].includes(tool);

const NAME_STRAIGHT = "straight to phone_message_compose or phone_call";
const SEARCH_FIRST = "Look things up with phone_contacts_search";

// ---------- Texting and calling by name ----------

const spoken = phonePrompt(guarded, { voice: true, carries: spokenCore });
eq("out loud, with the guard: the name goes straight to the text or call", spoken.includes(NAME_STRAIGHT), true);
eq("and contacts aren't searched first", spoken.includes(SEARCH_FIRST), false);
// Build 67 sends to the first contact that sounds like the name: the search is what stops it.
eq("an older build still searches first", phonePrompt(build67, { voice: true, carries: spokenCore }).includes(SEARCH_FIRST), true);
eq("a typed turn still searches first", phonePrompt(guarded).includes(SEARCH_FIRST), true);
eq("with no lookups, names were always passed", phonePrompt({ ...guarded, lookups: false }, { voice: true }).includes("Pass contact names"), true);

// ---------- What it says about a text that may not have gone ----------

// A guarded build opens Messages for a name it isn't sure of, after the reply is
// written: "Sent" would be said over an unsent sheet.
const SAY_SENT = "Say it as sent";
eq("with the guard, never told to say it was sent", spoken.includes(SAY_SENT), false);
eq("but to say it's texting them", spoken.includes("Texting Malachi now"), true);
eq("typed too: a searched contact can be doubted", phonePrompt(guarded).includes(SAY_SENT), false);
eq("build 67 sends outright, so it says so", phonePrompt(build67, { voice: true, carries: spokenCore }).includes(SAY_SENT), true);
eq("with texts not sent automatically, the sheet is said", phonePrompt({ ...guarded, autoSendTexts: false }, { voice: true }).includes("tap Send in; say so"), true);
const saysSentAndByName = [true, false].flatMap((voice) =>
  [guarded, build67, { ...guarded, autoSendTexts: false }].map((caps) => phonePrompt(caps, { voice })),
).some((p) => p.includes(SAY_SENT) && p.includes(NAME_STRAIGHT));
eq("'say it as sent' and 'pass the name straight' never meet", saysSentAndByName, false);

// ---------- Only tools the turn has ----------

eq("out loud, where they are comes with the message", spoken.includes("square brackets") && !spoken.includes("phone_location gives"), true);
eq("typed looks it up", phonePrompt(guarded).includes("phone_location gives their current position"), true);

// ---------- Health is the server's now (2026-09-23) ----------

// With the phone locked HealthKit refused, and the Band's heart rate was never
// in it: health_summary (heart.ts) answers from the server instead.
eq("build 67 reports Health, but isn't offered the phone lookup", phoneToolSpecs(build67).some((t) => t.name === "phone_health_summary"), false);
eq("nor a guarded build", phoneToolSpecs(guarded).some((t) => t.name === "phone_health_summary"), false);
eq("location is still offered where the build has it", phoneToolSpecs(guarded).some((t) => t.name === "phone_location"), true);
const everyPrompt = [true, false].flatMap((voice) =>
  [guarded, build67, { ...guarded, capabilities: [] }, { ...guarded, lookups: false, capabilities: [] }].map((caps) => phonePrompt(caps, { voice })),
);
eq("no prompt names the phone's Health lookup", everyPrompt.some((p) => p.includes("phone_health_summary")), false);
// Web and Expo Go were told Health "needs the installed OVOA app", though the
// server has the Band's readings for them too.
eq("and none says Health needs another build", everyPrompt.some((p) => p.includes("Apple Health") || p.includes("development build")), false);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
