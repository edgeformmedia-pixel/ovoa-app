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

/**
 * Tools a typed turn always has (2026-09-22). A typed turn used to carry the
 * whole catalogue, some 24,000 characters of JSON read before every reply and
 * used by a handful of them. This is the handful, wider than the spoken core
 * because a screen invites editing and looking back: the rest is a more_tools
 * away, and a request that plainly names one (see preload) gets it at once.
 */
export const TYPED_CORE = new Set([
  // The phone's own apps.
  "phone_calendar_events",
  "phone_calendar_create_event",
  "phone_calendar_update_event",
  "phone_reminder_create",
  "phone_reminders_list",
  "phone_reminder_complete",
  "phone_contacts_search",
  "phone_message_compose",
  "phone_email_compose",
  "phone_call",
  "phone_location",
  "phone_health_summary",
  // Alarms and the server's own reminders.
  "alarm_set",
  "alarm_cancel",
  "alarm_list",
  "reminder_set",
  "reminder_done",
  // Notes and the list.
  "note_add",
  "note_search",
  "todo_add",
  "todo_list",
  "todo_done",
  // Food, which is mentioned in passing and never by a tool's name.
  "food_log",
  "food_amend",
  // Money, routines, people.
  "money_afford",
  "money_status",
  "money_update",
  "routine_add",
  "routine_confirm",
  "person_lookup",
  // Standing work and the day.
  "agent_schedule",
  "web_search",
  "morning_brief",
  // Google, when connected: the two things asked for daily.
  "calendar_list_events",
  "calendar_create_event",
  "gmail_search",
  "gmail_read",
]);

/**
 * Tools a spoken turn always has. Everything else is a more_tools away, or
 * rides along when the request names it (namedTools): "cancel my alarm",
 * "brief me" and "put it on my calendar" bring alarm_cancel, morning_brief and
 * phone_calendar_create_event with them, so those left the core (2026-09-22).
 * What stays is what people ask for without saying the tool's name: "remind
 * me", "what's on tomorrow", "wake me at seven", "what's the weather".
 */
export const SPOKEN_CORE = new Set([
  // The shop-floor question, and where the money stands.
  "money_afford",
  "money_status",
  // The three things people ask a wrist for.
  "phone_calendar_events",
  "phone_reminder_create",
  "phone_reminders_list",
  "alarm_set",
  // Reaching someone.
  "phone_contacts_search",
  "phone_message_compose",
  "phone_call",
  // Catching a thought.
  "note_add",
  "todo_list",
  // "I had a burrito" names no tool, so food rides along (food.ts).
  "food_log",
  "food_amend",
  // Looking something up.
  "web_search",
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
  ate: ["food"],
  eat: ["food"],
  eaten: ["food"],
  meal: ["food"],
  calories: ["food"],
  calorie: ["food"],
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

/**
 * The tools a request names outright, before the model has read anything: a
 * non-generic word of the request in a tool's name. "Cancel my seven o'clock
 * alarm" names the alarm tools; "what time is it" names nothing. Stricter
 * than pickTools, which is answering the model's own description of what it
 * needs: a wrong guess here is a few hundred characters of prompt, a right one
 * is a whole round trip the user never waits through.
 */
export function namedTools(catalogue: ToolSpec[], request: string, max = 2) {
  const asked = new Set<string>();
  const generic = new Set<string>();
  for (const w of words(request)) {
    if (GENERIC.has(w)) {
      generic.add(w);
      continue;
    }
    asked.add(w);
    for (const s of SYNONYMS[w] ?? []) (GENERIC.has(s) ? generic : asked).add(s);
  }
  if (!asked.size) return [];
  // "notes" names note_add and "remind" names phone_reminder_create: a word of
  // five letters or more that begins the name's word, or that it begins. Five,
  // not four: "time" must not name location_timeline.
  const names = (n: string) => asked.has(n) || (n.length > 3 && [...asked].some((w) => w.length > 4 && (n.startsWith(w) || w.startsWith(n))));
  return (
    catalogue
      .map((tool) => {
        const parts = words(tool.name);
        // A generic word only breaks ties: "cancel my alarm" puts alarm_cancel
        // ahead of alarm_list, and "send" alone names nothing.
        return { tool, score: parts.filter(names).length + 0.5 * parts.filter((n) => generic.has(n)).length, named: parts.some(names) };
      })
      .filter((m) => m.named)
      .sort((a, b) => b.score - a.score)
      .slice(0, max)
      .map((m) => m.tool)
  );
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

/**
 * A family of tools and the instructions that go with them. When none of a
 * family's tools are carried, its instructions leave the prompt too and arrive
 * with the tools when more_tools brings them in: instructions for tools the
 * model cannot call are prefill the user pays for on every turn.
 */
export type ToolGuide = { tools: ToolSpec[]; prompt: string };

export type Toolbelt = {
  /** The array handed to the tool loop. It grows in place when more_tools is called. */
  tools: ToolSpec[];
  load: (need: string) => { loaded: string[]; note: string };
  /** Names that were pulled in, for the turn's log line. */
  loaded: string[];
  /** The guides whose tools are carried: their instructions belong in the prompt. */
  carriedGuides: ToolGuide[];
  /** Tools the request itself named, loaded before the first round. */
  preload: (request: string) => string[];
};

/**
 * Splits a turn's tools into the ones it carries and the ones it can send for.
 *
 * `tools` is the live array the tool loop reads each round, so anything `load`
 * pushes into it is in front of the model on its very next step — no restart,
 * no second turn, and the user hears nothing but a slightly longer pause.
 */
export function toolbelt(all: ToolSpec[], core = SPOKEN_CORE, guides: ToolGuide[] = []): Toolbelt {
  const carried = all.filter((t) => core.has(t.name));
  const catalogue = all.filter((t) => !core.has(t.name));
  const loaded: string[] = [];
  const tools = catalogue.length ? [...carried, moreToolsSpec(catalogue)] : [...carried];
  const carriedGuides = guides.filter((g) => g.tools.some((t) => tools.some((c) => c.name === t.name)));
  // Instructions that leave with their tools, handed over when the tools are.
  const shelved = guides.filter((g) => !carriedGuides.includes(g));

  const bring = (picks: ToolSpec[]) => {
    const fresh = picks.filter((t) => !tools.some((existing) => existing.name === t.name));
    tools.push(...fresh);
    loaded.push(...fresh.map((t) => t.name));
    return fresh;
  };
  const guidesFor = (picks: ToolSpec[]) =>
    shelved
      .filter((g) => g.prompt && g.tools.some((t) => picks.some((p) => p.name === t.name)))
      .map((g) => g.prompt);

  return {
    tools,
    loaded,
    carriedGuides,
    preload(request) {
      return bring(namedTools(catalogue, request)).map((t) => t.name);
    },
    load(need) {
      const picks = bring(pickTools(catalogue, need));
      if (!picks.length) {
        return {
          loaded: [],
          note: `Nothing here matches "${need}". Say plainly that this is something you can't do from here, and don't try again with different words.`,
        };
      }
      const how = guidesFor(picks);
      return {
        loaded: picks.map((t) => t.name),
        note: ["Ready to call — use one of these now, in this same turn.", ...how].join("\n"),
      };
    },
  };
}
