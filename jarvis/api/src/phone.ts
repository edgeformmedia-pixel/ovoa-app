import type { ToolSpec } from "./llm";

/**
 * Tools that use the user's iPhone. The Worker can't reach the phone, so none
 * of these run here:
 * - Actions (add a contact, create an event, start a text…) are parked for
 *   approval, and the app carries them out when the user taps Approve.
 * - Lookups (search contacts, list events…) pause the chat turn; the app runs
 *   them and sends the results back to /chat/resume.
 */

type Args = Record<string, any>;
type Schema = Record<string, unknown>;

const str = (description: string): Schema => ({ type: "string", description });
const bool = (description: string): Schema => ({ type: "boolean", description });
const int = (description: string): Schema => ({ type: "integer", description });
const strList = (description: string): Schema => ({ type: "array", items: { type: "string" }, description });
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object",
  properties,
  required,
});

const LOCAL_TIME = "Local date-time like 2026-09-18T15:00 (no offset), or a date like 2026-09-18 for all-day";

type FieldKind = "text" | "list" | "bool" | "int";

type PhoneTool = ToolSpec & {
  /** Field kinds, used to clean model-supplied args. */
  fields: Record<string, FieldKind>;
  required: string[];
  /** For actions: the first line of the approval card. Lookups have none. */
  title?: (a: Args) => string;
  /** Needs a capability the app has to report (e.g. a development build for Health). */
  capability?: string;
  /** At least one of these must be set (edits with nothing to change are rejected). */
  anyOf?: string[];
  /** Takes an id from a lookup, so it's only offered where lookups work. */
  needsLookup?: boolean;
  /** Created by the server, not offered to the model. */
  internal?: boolean;
};

function tool(t: Omit<PhoneTool, "parameters"> & { props: Record<string, Schema> }): PhoneTool {
  const { props, ...rest } = t;
  return { ...rest, parameters: obj(props, t.required) };
}

// ---------- Actions (need approval) ----------

const actionTools: PhoneTool[] = [
  tool({
    name: "phone_contact_create",
    description: "Add a new contact to the iPhone's Contacts app.",
    props: {
      firstName: str("Given name"),
      lastName: str("Family name"),
      company: str("Company"),
      jobTitle: str("Job title"),
      phones: strList("Phone numbers"),
      emails: strList("Email addresses"),
    },
    fields: { firstName: "text", lastName: "text", company: "text", jobTitle: "text", phones: "list", emails: "list" },
    required: ["firstName"],
    title: (a) => `Add iPhone contact: ${[a.firstName, a.lastName].filter(Boolean).join(" ")}`,
  }),
  tool({
    name: "phone_contact_update",
    description:
      "Edit a contact in the iPhone's Contacts app, found by name. If several contacts match, the app asks the user which one. Only pass the fields that change.",
    props: {
      contactName: str("The contact's name as the user refers to it, e.g. 'Sarah Lee' or 'Sarah'"),
      firstName: str("New given name"),
      lastName: str("New family name"),
      company: str("New company"),
      jobTitle: str("New job title"),
      addPhones: strList("Phone numbers to add"),
      removePhones: strList("Phone numbers to remove"),
      addEmails: strList("Email addresses to add"),
      removeEmails: strList("Email addresses to remove"),
    },
    fields: {
      contactName: "text",
      firstName: "text",
      lastName: "text",
      company: "text",
      jobTitle: "text",
      addPhones: "list",
      removePhones: "list",
      addEmails: "list",
      removeEmails: "list",
    },
    required: ["contactName"],
    anyOf: ["firstName", "lastName", "company", "jobTitle", "addPhones", "removePhones", "addEmails", "removeEmails"],
    title: (a) => `Edit iPhone contact: ${a.contactName}`,
  }),
  tool({
    name: "phone_calendar_create_event",
    description: "Add an event to the iPhone's Calendar app (the default calendar).",
    props: {
      title: str("Event title"),
      start: str(LOCAL_TIME),
      end: str(`${LOCAL_TIME}. Defaults to one hour after start.`),
      location: str("Location"),
      notes: str("Notes"),
      alertMinutes: int("Minutes before the start to alert, e.g. 15"),
    },
    fields: { title: "text", start: "text", end: "text", location: "text", notes: "text", alertMinutes: "int" },
    required: ["title", "start"],
    title: (a) => `Add to iPhone Calendar: ${a.title}`,
  }),
  tool({
    name: "phone_calendar_update_event",
    description: "Change an event in the iPhone's Calendar app. Get eventId from phone_calendar_events first.",
    props: {
      eventId: str("id from phone_calendar_events"),
      eventTitle: str("The event's current title, shown to the user"),
      title: str("New title"),
      start: str(`New start. ${LOCAL_TIME}`),
      end: str(`New end. ${LOCAL_TIME}`),
      location: str("New location"),
      notes: str("New notes"),
    },
    fields: {
      eventId: "text",
      eventTitle: "text",
      title: "text",
      start: "text",
      end: "text",
      location: "text",
      notes: "text",
    },
    required: ["eventId", "eventTitle"],
    anyOf: ["title", "start", "end", "location", "notes"],
    needsLookup: true,
    title: (a) => `Change iPhone Calendar event: ${a.eventTitle}`,
  }),
  tool({
    name: "phone_calendar_delete_event",
    description: "Delete an event from the iPhone's Calendar app. Get eventId from phone_calendar_events first.",
    props: { eventId: str("id from phone_calendar_events"), eventTitle: str("The event's title, shown to the user") },
    fields: { eventId: "text", eventTitle: "text" },
    required: ["eventId", "eventTitle"],
    needsLookup: true,
    title: (a) => `Delete iPhone Calendar event: ${a.eventTitle}`,
  }),
  tool({
    name: "phone_reminder_create",
    description: "Add a reminder to the iPhone's Reminders app.",
    props: {
      title: str("What to be reminded of"),
      due: str(`When. ${LOCAL_TIME}`),
      notes: str("Notes"),
    },
    fields: { title: "text", due: "text", notes: "text" },
    required: ["title"],
    title: (a) => `Add reminder: ${a.title}`,
  }),
  tool({
    name: "phone_reminder_complete",
    description: "Mark a reminder in the iPhone's Reminders app as done. Get reminderId from phone_reminders_list first.",
    props: {
      reminderId: str("id from phone_reminders_list"),
      reminderTitle: str("The reminder's title, shown to the user"),
    },
    fields: { reminderId: "text", reminderTitle: "text" },
    required: ["reminderId", "reminderTitle"],
    needsLookup: true,
    title: (a) => `Mark reminder done: ${a.reminderTitle}`,
  }),
  tool({
    name: "phone_message_compose",
    description:
      "Send a text message (iMessage/SMS). ALWAYS use this to text someone, never phone_shortcut_run. How it finishes depends on the user's settings; the system prompt says which, and your reply must match it.",
    props: {
      to: strList("Phone numbers, or contact names the app looks up on the phone"),
      body: str("Message text"),
    },
    fields: { to: "list", body: "text" },
    required: ["to", "body"],
    title: (a) => `Text ${a.to.join(", ")}`,
  }),
  tool({
    name: "phone_email_compose",
    description:
      "Open the iPhone Mail app with an email filled in. The user taps Send. Use Gmail tools instead if the user asks to send from Gmail.",
    props: {
      to: strList("Email addresses, or contact names the app looks up on the phone"),
      subject: str("Subject"),
      body: str("Email body"),
    },
    fields: { to: "list", subject: "text", body: "text" },
    required: ["to"],
    title: (a) => `Email ${a.to.join(", ")}`,
  }),
  tool({
    name: "phone_call",
    description: "Start a phone call. iOS shows a Call button to confirm.",
    props: { to: str("Phone number, or a contact name the app looks up on the phone") },
    fields: { to: "text" },
    required: ["to"],
    title: (a) => `Call ${a.to}`,
  }),
  tool({
    name: "phone_shortcut_run",
    description:
      "Run a shortcut from the iPhone's Shortcuts app by its exact name, optionally passing it text. Works for the user's own shortcuts and ones you wrote. Never use it to send a text message or to run a shortcut whose job is sending one: use phone_message_compose, which knows the recipient and the format the shortcut expects.",
    props: { name: str("The shortcut's exact name"), input: str("Text to pass to the shortcut as its input") },
    fields: { name: "text", input: "text" },
    required: ["name"],
    title: (a) => `Run shortcut: ${a.name}`,
  }),
  // Parked by shortcut_create (shortcuts/assistant.ts), never offered to the model directly.
  tool({
    name: "phone_shortcut_install",
    description: "Open the Shortcuts app to add a shortcut the assistant wrote.",
    props: { shortcutId: str(""), name: str(""), url: str("") },
    fields: { shortcutId: "text", name: "text", url: "text" },
    required: ["shortcutId", "name", "url"],
    title: (a) => `Add shortcut: ${a.name}`,
    internal: true,
  }),
];

// ---------- Lookups (run on the phone mid-turn) ----------

const lookupTools: PhoneTool[] = [
  tool({
    name: "phone_contacts_search",
    description: "Search the iPhone's contacts by name. Returns names, phone numbers, emails, company, and birthday.",
    props: { query: str("Name or part of a name") },
    fields: { query: "text" },
    required: ["query"],
  }),
  tool({
    name: "phone_calendar_events",
    description: "List events from all calendars in the iPhone's Calendar app between two times.",
    props: { start: str(LOCAL_TIME), end: str(LOCAL_TIME), query: str("Optional text to filter titles by") },
    fields: { start: "text", end: "text", query: "text" },
    required: ["start", "end"],
  }),
  tool({
    name: "phone_reminders_list",
    description: "List reminders from the iPhone's Reminders app.",
    props: { includeCompleted: bool("Also include completed reminders from the last 7 days") },
    fields: { includeCompleted: "bool" },
    required: [],
  }),
  tool({
    name: "phone_health_summary",
    description:
      "Read Apple Health for the last few days: steps, heart rate (average, resting), sleep, active energy, and workouts.",
    props: { days: int("How many days back, 1 to 14. Default 7.") },
    fields: { days: "int" },
    required: [],
    capability: "health",
  }),
];

const allTools = new Map([...actionTools, ...lookupTools].map((t) => [t.name, t]));

export const isPhoneTool = (name: string) => allTools.has(name);
export const isPhoneLookup = (name: string) => lookupTools.some((t) => t.name === name);

const spec = ({ name, description, parameters }: PhoneTool): ToolSpec => ({ name, description, parameters });

/** What the app on the other end can do, as it reports in the chat request. */
export type PhoneCaps = { lookups: boolean; capabilities: string[]; autoSendTexts?: boolean };

export function phoneToolSpecs(caps: PhoneCaps): ToolSpec[] {
  const lookups = caps.lookups
    ? lookupTools.filter((t) => !t.capability || caps.capabilities.includes(t.capability))
    : [];
  const actions = actionTools.filter((t) => !t.internal && (caps.lookups || !t.needsLookup));
  return [...actions, ...lookups].map(spec);
}

function clean(kind: FieldKind, value: unknown) {
  switch (kind) {
    case "text":
      return typeof value === "string" && value.trim() ? value.trim().slice(0, 2000) : undefined;
    case "list":
      return Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean).slice(0, 20) : [];
    case "bool":
      return typeof value === "boolean" ? value : undefined;
    case "int":
      return Number.isFinite(Number(value)) && value !== null && value !== "" ? Math.round(Number(value)) : undefined;
  }
}

const isSet = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v !== undefined);

/** Normalizes model-supplied args, or returns an error for the model. */
export function phoneArgs(name: string, args: Args): { args: Args } | { error: string } {
  const t = allTools.get(name);
  if (!t) return { error: `Unknown tool ${name}` };
  const out: Args = {};
  for (const [key, kind] of Object.entries(t.fields)) out[key] = clean(kind, args[key]);
  const missing = t.required.filter((k) => !isSet(out[k]));
  if (missing.length) return { error: `Missing ${missing.join(", ")}` };
  if (t.anyOf && !t.anyOf.some((k) => isSet(out[k]))) return { error: "No changes given" };
  return { args: out };
}

const LABELS: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  company: "Company",
  jobTitle: "Job title",
  phones: "Phone",
  emails: "Email",
  addPhones: "Add phone",
  removePhones: "Remove phone",
  addEmails: "Add email",
  removeEmails: "Remove email",
  title: "New title",
  start: "Starts",
  end: "Ends",
  due: "Due",
  location: "Location",
  notes: "Notes",
  alertMinutes: "Alert (minutes before)",
  subject: "Subject",
  body: "Message",
  input: "Input",
};

const TIME_FIELDS = new Set(["start", "end", "due"]);

/** The approval card text: a title line, then one line per field. */
export function phoneSummary(name: string, a: Args) {
  const t = allTools.get(name)!;
  const lines = [t.title!(a)];
  for (const [key, label] of Object.entries(LABELS)) {
    if (!(key in t.fields) || !isSet(a[key])) continue;
    // Already in the title line.
    if (name === "phone_contact_create" && (key === "firstName" || key === "lastName")) continue;
    if (key === "title" && name !== "phone_calendar_update_event") continue;
    const value = Array.isArray(a[key]) ? a[key].join(", ") : String(a[key]);
    // 2026-09-18T15:00:00 → 2026-09-18 15:00
    const shown = TIME_FIELDS.has(key) ? value.replace(/T(\d\d:\d\d).*/, " $1") : value;
    lines.push(`${label}: ${shown}`);
  }
  return lines.join("\n");
}

export function phonePrompt(caps: PhoneCaps) {
  return [
    "You can use the user's iPhone with the phone_ tools: Contacts, Calendar, Reminders, Messages, Mail, calls, and running shortcuts.",
    "'Add a contact', 'my calendar', 'remind me' mean the iPhone apps unless the user mentions Google.",
    "Changes and composing messages or calls wait for the user to tap Approve in the app. Never say one is done until approved.",
    caps.autoSendTexts
      ? "The user has \"Send texts automatically\" on: phone_message_compose sends the text outright, with no Messages sheet and nothing for them to tap. Say it as sent (\"Sent Malachi that text\"). Never say you opened Messages, that it's ready to send, or that they need to tap Send — that is wrong here and makes them repeat themselves. Emails still need a tap; say so for those only."
      : "Texts and emails open a compose sheet the user still has to tap Send in; say so.",
    caps.lookups
      ? "Look things up with phone_contacts_search, phone_calendar_events, and phone_reminders_list before changing them or when you need a number or email. Pass phone numbers to phone_message_compose and phone_call when you have them."
      : "You can't read the phone's contacts, calendar, or reminders from here. Pass contact names to phone_message_compose, phone_email_compose, and phone_call and the app looks them up. To change or delete an existing event or reminder, tell the user to ask in the OVOA app.",
    caps.capabilities.includes("health")
      ? "Use phone_health_summary for questions about heart rate, sleep, workouts, or other Apple Health data. You are not a medical professional."
      : "Apple Health isn't available in this version of the app. If asked about heart rate, sleep, or workouts, say it needs the installed OVOA app (a development build), not Expo Go.",
    caps.lookups
      ? "Names the user says out loud are transcribed by sound, so they may be misspelled (\"Ty Eckard\" for \"Tigh Eckart\"). phone_contacts_search also returns contacts whose names sound alike, marked with a note; if one fits, treat it as the person they meant and use the contact's real spelling. If a search finds nobody, try again with just the first name or just the last name before saying you couldn't find them."
      : "",
    "If you're not sure which person, event, or reminder the user means, ask.",
  ]
    .filter(Boolean)
    .join("\n");
}
