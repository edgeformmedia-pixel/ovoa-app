import type { ToolSpec } from "./llm";

// What a spoken turn carries in its prompt.
//
// Every tool definition is text the model reads before it writes its first
// word, and a spoken turn was carrying about seventy of them. On the wrist
// that reading is most of the wait: the user has stopped talking and is
// standing there while a JSON catalogue of Google Sheets parameters is parsed.
//
// So a spoken turn gets the handful of tools people actually use out loud, plus
// one more_tools call that fetches the rest when a turn genuinely needs them.
// The catalogue still exists — it just lives here, on the server, costing
// nothing, instead of in front of every sentence. A request that needs a tool
// outside the core costs one extra round trip; the ordinary "remind me at four"
// costs nothing at all.
//
// The core is chosen by what someone says to a thing on their wrist, not by
// what is useful at a desk. Reading and writing are split on purpose: asking
// what's on the calendar is a walking-around question, editing an event is not.

/** Tools a spoken turn always has. Everything else is a more_tools away. */
export const SPOKEN_CORE = new Set([
  // The shop-floor question, and where the money stands.
  "money_afford",
  "money_status",
  // The three things people ask a wrist for.
  "phone_calendar_events",
  "phone_calendar_create_event",
  "phone_reminder_create",
  "phone_reminders_list",
  "alarm_set",
  "alarm_cancel",
  // Reaching someone.
  "phone_contacts_search",
  "phone_message_compose",
  "phone_call",
  // Catching a thought.
  "note_add",
  "todo_list",
  // Looking something up.
  "web_search",
  "morning_brief",
]);

/**
 * Words people say for things the tools are named something else. Only the ones
 * where the gap is wide enough that a plain word match would miss: "text" and
 * "message", "email" and "gmail". A synonym list that tries to be complete
 * rots; this one only has to cover the words a person actually says out loud.
 */
const SYNONYMS: Record<string, string[]> = {
  email: ["gmail", "mail"],
  mail: ["gmail", "email"],
  text: ["message", "sms"],
  texted: ["message"],
  spreadsheet: ["sheets"],
  sheet: ["sheets"],
  document: ["docs"],
  doc: ["docs"],
  task: ["todo", "tasks", "reminder"],
  tasks: ["todo", "reminder"],
  habit: ["routine"],
  workout: ["exercise", "training"],
  spent: ["money", "spend"],
  paid: ["money", "paycheck"],
  bill: ["money", "bills"],
  owe: ["money", "bill"],
  person: ["people", "contact"],
  someone: ["people", "contact"],
  place: ["location", "places"],
  said: ["transcript", "conversation"],
  say: ["transcript", "conversation"],
  told: ["transcript", "conversation"],
  appointment: ["calendar", "event"],
  meeting: ["calendar", "event"],
  reschedule: ["calendar", "event", "update"],
  move: ["update", "change"],
  cancel: ["delete", "cancel"],
  pills: ["medication", "routine"],
  pill: ["medication", "routine"],
  meds: ["medication", "routine"],
  medicine: ["medication", "routine"],
  remember: ["memory", "context", "remember"],
};

const STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "of", "my", "me", "i", "and", "or", "in", "on", "at", "is", "it", "that", "this",
  "can", "you", "do", "does", "need", "want", "please", "with", "about", "what", "whats", "how", "get", "got",
]);

/**
 * Words that appear in half the tool names and mean nothing on their own. A
 * name hit on one of these counts for little: "send a text" must not load
 * gmail_send just because both contain "send".
 */
const GENERIC = new Set([
  "send", "add", "create", "update", "change", "delete", "remove", "list", "get", "set", "log", "save",
  "read", "write", "run", "start", "stop", "new", "find", "search", "phone", "tool", "tools",
]);

/** How many tools one more_tools call is allowed to bring in. */
export const MAX_LOADED = 6;

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, " ")
    .split(/[\s_]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));

/**
 * The tools most likely to be what a turn is reaching for. A hit in the name is
 * worth more than a hit in the description, because a tool called `gmail_send`
 * is about sending mail while half the catalogue mentions mail in passing.
 */
export function pickTools(catalogue: ToolSpec[], need: string, max = MAX_LOADED) {
  const asked = new Set<string>();
  for (const w of words(need)) {
    asked.add(w);
    for (const s of SYNONYMS[w] ?? []) asked.add(s);
  }
  if (!asked.size) return [];
  return catalogue
    .map((tool) => {
      const name = words(tool.name);
      const description = words(tool.description);
      let score = 0;
      for (const w of asked) {
        const weight = GENERIC.has(w) ? 1 : 3;
        if (name.includes(w)) score += weight;
        else if (name.some((n) => n.length > 3 && (n.startsWith(w) || w.startsWith(n)))) score += weight - 1;
        else if (description.includes(w)) score += 1;
      }
      return { tool, score };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((m) => m.tool);
}

export const MORE_TOOLS = "more_tools";

const moreToolsSpec = (catalogue: ToolSpec[]): ToolSpec => ({
  name: MORE_TOOLS,
  description:
    `You have the everyday tools already. ${catalogue.length} more are available but not loaded — email, editing calendar events, contacts, routines, health, past conversations, money records, background jobs and more. ` +
    "Call this with a few words for what you need ('send an email', 'what did I say yesterday', 'log a workout') and the matching tools arrive for you to call on your next step. Only call it when none of the tools you have will do.",
  parameters: {
    type: "object",
    properties: { need: { type: "string", description: "What you're trying to do, in a few words." } },
    required: ["need"],
  },
});

export type Toolbelt = {
  /** The array handed to the tool loop. It grows in place when more_tools is called. */
  tools: ToolSpec[];
  load: (need: string) => { loaded: string[]; note: string };
  /** Names that were pulled in, for the turn's log line. */
  loaded: string[];
};

/**
 * Splits a turn's tools into the ones it carries and the ones it can send for.
 *
 * `tools` is the live array the tool loop reads each round, so anything `load`
 * pushes into it is in front of the model on its very next step — no restart,
 * no second turn, and the user hears nothing but a slightly longer pause.
 */
export function toolbelt(all: ToolSpec[], core = SPOKEN_CORE): Toolbelt {
  const carried = all.filter((t) => core.has(t.name));
  const catalogue = all.filter((t) => !core.has(t.name));
  const loaded: string[] = [];
  const tools = catalogue.length ? [...carried, moreToolsSpec(catalogue)] : [...carried];

  return {
    tools,
    loaded,
    load(need) {
      const picks = pickTools(catalogue, need).filter((t) => !tools.some((existing) => existing.name === t.name));
      if (!picks.length) {
        return {
          loaded: [],
          note: `Nothing here matches "${need}". Say plainly that this is something you can't do from the band, and don't try again with different words.`,
        };
      }
      tools.push(...picks);
      loaded.push(...picks.map((t) => t.name));
      return {
        loaded: picks.map((t) => t.name),
        note: "Ready to call — use one of these now, in this same turn.",
      };
    },
  };
}
