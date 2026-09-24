// Whether a request asked for something to be done, and whether a reply says
// it was. The rows marked "bench" are real production turns from engine-bench
// on 2026-09-23 (scripts/engine-bench.mjs): the claims are the ones that ran no
// tool, and the rest are replies that must never set off a repair round.

import { asksForAction, changesSomething, claimsDone, doesSomething, onlyReads, requestOf } from "../src/claims";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

// ---------- Requests ----------

const ACTIONS = [
  "Add milk and eggs to my notes.", // bench
  "Remind me to submit the report on Friday at 9am.", // bench
  "Set an alarm for 6:30 tomorrow.", // bench
  "Note: the wifi password is on the fridge.", // bench
  "Add a to-do to buy a gift for Jake.", // bench
  "Remind me to call Mom at four this afternoon.", // bench
  "Cancel my seven o'clock alarm.", // bench
  "Call Mom.", // bench
  "Can you put eggs on my list?",
  "Could you please set a timer for ten minutes",
  "hey ovoa add bread to my notes",
  "OVOA, remind me to stretch at 3",
  "Thanks. Now add eggs too.",
  "Text Danya I'm on my way",
  "Make a note that the car is on level 3",
  "Don't let me forget the dry cleaning",
  "Remember that my locker is 42",
  "Write this down: gate code 1234",
  "Wake me up at 6",
  "Remind me again tomorrow to call the bank.",
  "Remind me to ask Sarah what she wants for dinner.",
];
for (const request of ACTIONS) eq(`asks for action: ${request}`, asksForAction(request), true);

const NOT_ACTIONS = [
  "What time is it?", // bench
  "What's today's date?", // bench
  "Write two sentences about why sleep matters.", // bench
  "Tell me something interesting in one sentence.", // bench
  "Who was I supposed to call?", // bench
  "Do I have any alarms set?", // bench
  "Can I afford a sixty dollar dinner this week?", // bench
  "What's on my calendar this week?", // bench
  "Show me Mom's contact details.", // bench
  "What do I have on my list?", // bench
  "I set my alarm for six already.",
  "Did you add the milk?",
  "Is my alarm set?",
  "I added eggs to the list myself.",
  // Asking to be told, not reminded later: memories ride in the prompt, so these are answered with no tool.
  "Remind me what my wifi password is.",
  "Remind me who Sarah is married to",
  "Remind me of the gate code.",
  "Remind me again when the dentist is.",
  "Ovoa, remind me about my schedule tomorrow.",
  "",
];
for (const request of NOT_ACTIONS) eq(`asks for nothing: ${request || "(empty)"}`, asksForAction(request), false);

// As the model gets it: the clock and the rest of the moment in front (index.ts runTurn).
const moment = "[It is now Wednesday, September 23, 2026 at 7:37 PM.\nRecent activity (steps per day, daily goal 8000):\n2026-09-23: 4,210]\n\n";
eq("the moment in front is dropped", requestOf(`${moment}Add milk to my notes.`), "Add milk to my notes.");
eq("a message with no moment is kept whole", requestOf("Add milk to my notes."), "Add milk to my notes.");
eq("with the moment: an action", asksForAction(`${moment}Add milk and eggs to my notes.`), true);
eq("with the moment: a question", asksForAction(`${moment}What time is it?`), false);
// An open app's instructions ride in the moment, and they are instructions: never the person's.
const app = `[It is now Wednesday, September 23, 2026 at 7:37 PM.\nThey are using their own app "Water", which they made in OVOA. Follow its instructions for this message:\nLog each glass they mention. Add a check when they hit eight.\n\nKeep replies short.]\n\n`;
eq("an app's own instructions aren't the request", asksForAction(`${app}How many today?`), false);
eq("but the person's own words under them are", asksForAction(`${app}Log two glasses.`), true);

// ---------- Replies ----------

const CLAIMS = [
  "Noted — milk and eggs.", // bench, workers, spoken
  "Reminder set for Friday at 9:00 am — submit the report.", // bench, typed
  "Done — 6:30 alarm set for tomorrow morning.", // bench, typed
  "Done — I'll buzz you Friday at 9:00 AM to submit the report.", // bench, typed
  "Done — I'll remind you Friday at 9:00 a.m. to submit the report.", // bench, typed
  "Noted and kept — the wifi password's on the fridge.", // bench, typed
  "On today's list: buy a gift for Jake.", // bench, typed
  "Kept — “the wifi password is on the fridge.”",
  "Got it — milk and eggs saved.",
  "Your alarm’s set for 7.",
  "I've added bread to your notes.",
  "Milk and eggs are on your list now.",
  "Calling Mom.",
  "All set! Anything else?",
  "Done — alarm set for 6:30. You don't have anything else tomorrow.",
  "You asked for eggs — added.",
  "Saved for you.",
];
for (const reply of CLAIMS) eq(`claims done: ${reply}`, claimsDone(reply), true);

const NOT_CLAIMS = [
  "It's 7:37.",
  "It's 7:46 PM.", // bench
  "Four this afternoon has already passed — did you mean 4 PM tomorrow?", // bench
  "It's already 7:37, so you've missed four today — want that reminder for four tomorrow instead?", // bench
  "Octopuses have three hearts, and two of them stop beating whenever they swim — which is why they'd rather crawl.", // bench
  "Sleep matters because it's when your brain clears out waste, consolidates memories, and resets focus for the day ahead.", // bench
  "I don't have anything on record about a call — no notes, reminders, or recent mentions of who you were supposed to ring.", // bench
  "I can't check that right now — the money connection isn't set up.", // bench
  "Odd — the alarm list shows nothing right now, so the 6:30 one for tomorrow doesn't seem to have stuck. Want me to set it again?", // bench
  "It's Wednesday, September 23, 2026.", // bench
  "Here's Mom: +1 555 010 0100.", // bench
  "Which alarm — the 6:30 or the 7:00?",
  "What should the note say?",
  "Want me to add it to your notes?",
  "If you tell me the time, I'll set it.",
  "I can't set timers yet, but I can set an alarm for then.",
  "That one's already on your list.",
  // What the person did, told back to them: how a question about what's stored is answered.
  "You saved it last week: the wifi password is BlueFox42.",
  "You have the dentist scheduled for 3 PM.",
  "Sarah is married to Tom — you added him to your contacts in June.",
  "You've booked the 6:15 train.",
  "",
];
for (const reply of NOT_CLAIMS) eq(`claims nothing: ${reply || "(empty)"}`, claimsDone(reply), false);

// ---------- Both together, as chatWithTools asks ----------

const repairs = (request: string, reply: string) => asksForAction(`${moment}${request}`) && claimsDone(reply);
eq("bench: notes claimed, no tool", repairs("Add milk and eggs to my notes.", "Noted — milk and eggs."), true);
eq("bench: reminder claimed, no tool", repairs("Remind me to submit the report on Friday at 9am.", "Reminder set for Friday at 9:00 am — submit the report."), true);
eq("bench: alarm claimed, no tool", repairs("Set an alarm for 6:30 tomorrow.", "Done — 6:30 alarm set for tomorrow morning."), true);
eq("a question answered: no repair", repairs("What time is it?", "It's 7:37."), false);
eq("a question back: no repair", repairs("Remind me to call Mom at four this afternoon.", "Four this afternoon has already passed — did you mean 4 PM tomorrow?"), false);
eq("words asked for: no repair", repairs("Write two sentences about why sleep matters.", "Sleep is when your body repairs itself. Skimp on it and everything suffers."), false);
eq("a stored thing asked about: no repair", repairs("Remind me what my wifi password is.", "You saved it last week: the wifi password is BlueFox42."), false);
eq("the same answer to an action is still no claim", repairs("Add the wifi password to my notes.", "You saved it last week: the wifi password is BlueFox42."), false);

// ---------- Which calls count ----------

eq("more_tools does nothing by itself", doesSomething("more_tools"), false);
eq("note_add does something", doesSomething("note_add"), true);
eq("a lookup counts as a tool run", doesSomething("alarm_list"), true);
// What a repair round has to have run to make a claim true.
for (const tool of ["alarm_list", "todo_list", "note_search", "contacts_search", "phone_contacts_search", "phone_calendar_events", "phone_reminders_list", "phone_location", "gmail_read", "sheets_get_info", "person_lookup", "object_find", "money_status"]) {
  eq(`${tool} only reads`, `${onlyReads(tool)} ${changesSomething(tool)}`, "true false");
}
for (const tool of ["note_add", "alarm_set", "alarm_cancel", "todo_done", "reminder_set", "phone_message_compose", "phone_reminder_complete", "gmail_send", "gmail_mark_read", "calendar_update_event"]) {
  eq(`${tool} changes something`, `${onlyReads(tool)} ${changesSomething(tool)}`, "false true");
}
eq("more_tools neither reads nor changes", `${onlyReads("more_tools")} ${changesSomething("more_tools")}`, "false false");

console.log(fails ? `\n${fails} failed` : "\nall passed");
process.exit(fails ? 1 : 0);
