// What a spoken turn carries, and whether asking for more finds the right thing.
//
// The bet is that dropping ~70 tool definitions out of the prompt costs nothing
// on ordinary turns and one round trip on rare ones. That bet only pays if
// more_tools actually finds the tool a person was reaching for — a miss means
// the model either gives up or guesses, and both are worse than the slow prompt
// we started with. So these check the words a person would really say.

import { pickTools, SPOKEN_CORE, toolbelt } from "../src/toolbelt";
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

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
