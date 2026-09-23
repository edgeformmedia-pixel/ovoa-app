// What a spoken turn carries, and whether asking for more finds the right thing.
//
// The bet is that dropping ~70 tool definitions out of the prompt costs nothing
// on ordinary turns and one round trip on rare ones. That bet only pays if
// more_tools actually finds the tool a person was reaching for — a miss means
// the model either gives up or guesses, and both are worse than the slow prompt
// we started with. So these check the words a person would really say.

import { namedTools, pickTools, SPOKEN_CORE, toolbelt, TYPED_CORE } from "../src/toolbelt";
import type { ToolSpec } from "../src/llm";

let fails = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${got}${ok ? "" : `  (wanted ${want})`}`);
}

const t = (name: string, description: string): ToolSpec => ({ name, description, parameters: {} });

// A slice of the real catalogue, with the real descriptions' flavour.
const CATALOGUE: ToolSpec[] = [
  t("gmail_search", "Searches the user's Gmail for messages matching a query."),
  t("gmail_send", "Sends an email from the user's Gmail account."),
  t("gmail_create_draft", "Writes a draft email in Gmail without sending it."),
  t("calendar_update_event", "Changes an existing event in Google Calendar: time, title, guests."),
  t("phone_contact_create", "Creates a new contact in the phone's address book."),
  t("routine_add", "Adds a recurring routine, like medication or a habit, at set times."),
  t("workout_log", "Logs a workout the user did: kind, how long, how hard."),
  t("transcript_search", "Searches everything that was said and captured, by words in it."),
  t("money_update", "Records a money fact: balance, a paycheck that landed, money spent."),
  t("money_bill", "A recurring bill: add one, mark it paid, or stop tracking it."),
  t("agent_schedule", "Schedules a background job for the agent to run on its own later."),
  t("place_rename", "Renames a place the user visits often."),
  t("context_search", "Searches the timeline of what the user did and where they were."),
  t("phone_message_compose", "Opens a text message to someone, ready to send."),
];

const has = (tools: ToolSpec[], name: string) => tools.some((x) => x.name === name);

eq("'send an email to Sarah' finds the mail tools", has(pickTools(CATALOGUE, "send an email to Sarah"), "gmail_send"), true);
// What matters is which one comes first. A couple of near misses riding along
// costs a few hundred characters; the wrong tool at the top costs a wrong action.
eq("'send a text' puts the message tool first", pickTools(CATALOGUE, "send a text")[0]?.name, "phone_message_compose");
eq("'send an email' still puts mail first", pickTools(CATALOGUE, "send an email")[0]?.name, "gmail_send");
eq("'move my dentist appointment' finds the calendar", has(pickTools(CATALOGUE, "move my dentist appointment"), "calendar_update_event"), true);
eq("'log that I ran' finds the workout log", has(pickTools(CATALOGUE, "log that I ran three miles"), "workout_log"), true);
eq("'I got paid' finds the money record", has(pickTools(CATALOGUE, "I got paid today"), "money_update"), true);
eq("'my electric bill is due' finds bills", has(pickTools(CATALOGUE, "my electric bill is due on the third"), "money_bill"), true);
eq("'what did I say yesterday' finds transcripts", has(pickTools(CATALOGUE, "what did I say yesterday"), "transcript_search"), true);
eq("'add a new contact' finds contacts", has(pickTools(CATALOGUE, "add a new contact"), "phone_contact_create"), true);
eq("'take my pills every morning' finds routines", has(pickTools(CATALOGUE, "remind me to take my pills every morning"), "routine_add"), true);

eq("at most six arrive at once", pickTools(CATALOGUE, "email mail message calendar event money bill workout routine contact").length <= 6, true);
eq("nothing matching brings back nothing", pickTools(CATALOGUE, "xylophone repair").length, 0);
// Stopwords are all a question like this has; matching on "my" would load six random tools.
eq("a question with no content words loads nothing", pickTools(CATALOGUE, "can you do that for me").length, 0);

// ---------- The belt itself ----------

const all = [...CATALOGUE, t("money_afford", "Whether they can afford something."), t("note_add", "Saves a note.")];
const belt = toolbelt(all, SPOKEN_CORE);

eq("a spoken turn starts with the core plus one way to ask", belt.tools.length, 4);
eq("the core is there", has(belt.tools, "money_afford"), true);
eq("the catalogue is not", has(belt.tools, "gmail_send"), false);
eq("and there's a way to ask for it", has(belt.tools, "more_tools"), true);

const got = belt.load("send an email");
eq("asking brings mail in", got.loaded.includes("gmail_send"), true);
eq("and the live list grew", has(belt.tools, "gmail_send"), true);
eq("the turn remembers what it loaded", belt.loaded.includes("gmail_send"), true);
const again = belt.load("send an email");
eq("asking twice doesn't add it twice", belt.tools.filter((x) => x.name === "gmail_send").length, 1);
eq("and says so rather than silently doing nothing", again.loaded.length === 0 || again.loaded.every((n) => n !== "gmail_send"), true);

const miss = belt.load("order a pizza");
eq("a miss says so plainly", miss.loaded.length, 0);
eq("and tells the model to stop trying", miss.note.includes("don't try again"), true);

// ---------- What the request itself names ----------

// Before the model has read a word: a tool whose name is in the request rides
// along from the start, so "cancel my alarm" never pays a round trip for
// alarm_list. A request that names nothing gets nothing.
const named = [
  ...CATALOGUE,
  t("alarm_list", "Lists the alarms that are set."),
  t("alarm_stop", "Stops an alarm that is ringing."),
  t("alarm_cancel", "Cancels an alarm."),
  t("workout_summary", "How training has gone lately."),
  t("location_timeline", "Where they have been."),
];
eq("'cancel my seven o'clock alarm' names the alarm tools", has(namedTools(named, "cancel my seven o'clock alarm"), "alarm_cancel"), true);
eq("and the one that says cancel comes first", namedTools(named, "cancel my seven o'clock alarm")[0]?.name, "alarm_cancel");
eq("'what time is it' names nothing ('time' is not 'timeline')", namedTools(named, "what time is it").length, 0);
eq("a generic word alone ('send it') names nothing", namedTools(named, "send it").length, 0);
eq("'log my workout' names the workout tools", has(namedTools(named, "log my workout"), "workout_log"), true);
eq("at most two", namedTools(named, "alarm workout email").length <= 2, true);
const stems = [...named, t("note_add", "Saves a note."), t("phone_reminder_create", "A reminder on the phone.")];
eq("'add milk to my notes' names the note tool", has(namedTools(stems, "add milk and eggs to my notes"), "note_add"), true);
eq("'remind me to call Mom' names the reminder", has(namedTools(stems, "remind me to call Mom at four"), "phone_reminder_create"), true);

// ---------- The typed belt and the instructions that travel with tools ----------

const typedAll = [
  ...named,
  t("todo_add", "Adds to the list."),
  t("phone_calendar_events", "What's on the phone's calendar."),
];
const guides = [
  { tools: typedAll.filter((x) => x.name.startsWith("workout_")), prompt: "WORKOUT GUIDE" },
  { tools: typedAll.filter((x) => x.name.startsWith("todo_")), prompt: "TODO GUIDE" },
  { tools: typedAll.filter((x) => x.name.startsWith("transcript_")), prompt: "TRANSCRIPT GUIDE" },
];
const typed = toolbelt(typedAll, TYPED_CORE, guides);
eq("a typed turn carries its core", has(typed.tools, "todo_add") && has(typed.tools, "phone_calendar_events"), true);
eq("and not the rest", has(typed.tools, "workout_log"), false);
eq("with a way to ask", has(typed.tools, "more_tools"), true);
eq("a guide whose tools are carried stays in the prompt", typed.carriedGuides.some((g) => g.prompt === "TODO GUIDE"), true);
eq("a guide whose tools are not carried leaves it", typed.carriedGuides.some((g) => g.prompt === "WORKOUT GUIDE"), false);
const brought = typed.load("log a workout");
eq("asking brings the tools", brought.loaded.includes("workout_log"), true);
eq("and their instructions with them", brought.note.includes("WORKOUT GUIDE"), true);
eq("not the instructions for something else", brought.note.includes("TRANSCRIPT GUIDE"), false);
const pre = toolbelt(typedAll, TYPED_CORE, guides);
// alarm_cancel and alarm_list are in the typed core already; alarm_stop is the one the request brings in.
eq("a request that names a tool has it from the start", pre.preload("cancel my alarm").includes("alarm_stop"), true);
eq("counted as loaded", pre.loaded.includes("alarm_stop"), true);
eq("the carried one was there all along", has(pre.tools, "alarm_cancel"), true);
eq("a request that names nothing preloads nothing", toolbelt(typedAll, TYPED_CORE, guides).preload("what time is it").length, 0);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
