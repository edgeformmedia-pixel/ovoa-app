import { Hono } from "hono";
import { z } from "zod";
import type { CallTool, ToolSpec } from "./llm";
import { AI_UNREACHABLE, generateText, isAiUnreachable, isModelRefused } from "./llm";
import { refusedResponse } from "./plans";
import { buckets } from "./time";
import type { Env, Vars } from "./types";

// Apps people make themselves (the app's Apps → Create).
//
// Someone says or types what they want — "a grocery helper that asks what I'm
// out of and adds it to my list" — and the model turns that into an app: a
// name, one line saying what it does, an icon, the instructions OVOA follows
// while it's open, and a screen of its own. Designing and saving are two
// calls, so the person sees what they'd get before it's theirs, and every part
// of it can be changed afterwards, by hand or by saying what to change.
//
// The screen is built from a small kit the phone knows how to draw (Block):
// quick buttons that ask OVOA something, a checklist, a counter, a log, a note
// and a timer. What's in them (the list's items, today's count) is the app's
// `state`, changed by taps on the phone and, while the app is open, by the
// assistant's app_update tool, so "add milk" said to a grocery app lands on its
// list.
//
// A made app is still not new code. Everything it asks of OVOA runs on the
// assistant (chatTurn in index.ts, through `app` on /chat), so it can do what
// OVOA can already do, asks for approval the same way, and each thing asked of
// it is an ordinary reply against the day's allowance. Taps on its list or
// counter cost nothing: no model is involved.

/** Icons the app can draw (Ionicons names, all in @expo/vector-icons). Kept in step with the phone's lib/appKit.ts. */
export const APP_ICONS = [
  "sparkles-outline",
  "cart-outline",
  "restaurant-outline",
  "fitness-outline",
  "barbell-outline",
  "medkit-outline",
  "book-outline",
  "school-outline",
  "briefcase-outline",
  "cash-outline",
  "home-outline",
  "car-outline",
  "airplane-outline",
  "paw-outline",
  "leaf-outline",
  "musical-notes-outline",
  "chatbubbles-outline",
  "people-outline",
  "heart-outline",
  "moon-outline",
  "sunny-outline",
  "calendar-outline",
  "checkbox-outline",
  "bulb-outline",
  "gift-outline",
  "language-outline",
  "water-outline",
  "cafe-outline",
] as const;
export const APP_TONES = ["teal", "violet", "green", "amber", "coral", "blue", "pink"] as const;

/** The parts a screen is built from. The phone draws each one (components/AppBlocks.tsx). */
export const BLOCK_KINDS = ["buttons", "list", "counter", "log", "note", "timer"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** At most this many made apps each. */
export const MAX_APPS = 30;
export const MAX_BLOCKS = 8;
const MAX_BUTTONS = 6;
const MAX_LIST = 100;
const MAX_LOG = 200;

export type AppButton = { label: string; prompt: string };

/**
 * One part of an app's screen. Flat rather than a union so the model's JSON
 * and the phone's editor can both carry it without a schema per kind; only the
 * fields for its kind survive sanitizeBlocks.
 */
export type Block = {
  id: string;
  kind: BlockKind;
  title: string;
  /** buttons */
  buttons?: AppButton[];
  /** list, log */
  placeholder?: string;
  /** counter */
  unit?: string;
  goal?: number | null;
  step?: number;
  /** counter: starts again from nothing each day */
  daily?: boolean;
  /** note */
  text?: string;
  /** timer */
  minutes?: number;
};

export type ListItem = { id: string; text: string; done: boolean };
export type LogEntry = { id: string; text: string; at: number };
export type BlockState = { items?: ListItem[]; entries?: LogEntry[]; value?: number; day?: string };
export type AppState = Record<string, BlockState>;

const DEFAULT_TITLES: Record<BlockKind, string> = {
  buttons: "Quick actions",
  list: "List",
  counter: "Count",
  log: "Log",
  note: "Note",
  timer: "Timer",
};

const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const shortId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const number = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN);
const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * Whatever came in (the model, the phone's editor), as parts the phone can
 * draw: unknown kinds dropped, fields for other kinds dropped, lengths capped,
 * ids kept when they're usable (the state is keyed by them) and made up when not.
 */
export function sanitizeBlocks(raw: unknown): Block[] {
  const out: Block[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_BLOCKS) break;
    const b = (r ?? {}) as Record<string, unknown>;
    const kind = BLOCK_KINDS.find((k) => k === b.kind);
    if (!kind) continue;
    let id = clean(b.id, 40).replace(/[^\w-]/g, "");
    if (!id || seen.has(id)) id = shortId();
    seen.add(id);
    const title = clean(b.title, 40) || DEFAULT_TITLES[kind];
    switch (kind) {
      case "buttons": {
        const buttons = (Array.isArray(b.buttons) ? b.buttons : [])
          .map((x) => {
            const o = (x ?? {}) as Record<string, unknown>;
            const label = clean(o.label, 28);
            return { label, prompt: clean(o.prompt, 300) || label };
          })
          .filter((x) => x.label)
          .slice(0, MAX_BUTTONS);
        if (buttons.length) out.push({ id, kind, title, buttons });
        break;
      }
      case "list":
      case "log":
        out.push({ id, kind, title, placeholder: clean(b.placeholder, 60) || (kind === "list" ? "Add an item" : "Write an entry") });
        break;
      case "counter": {
        const goal = clampInt(b.goal, 0, 100_000, 0);
        out.push({
          id,
          kind,
          title,
          unit: clean(b.unit, 20),
          goal: goal > 0 ? goal : null,
          step: clampInt(b.step, 1, 1000, 1),
          daily: b.daily !== false,
        });
        break;
      }
      case "note": {
        const text = String(b.text ?? "").trim().slice(0, 1000);
        if (text) out.push({ id, kind, title, text });
        break;
      }
      case "timer":
        out.push({ id, kind, title, minutes: clampInt(b.minutes, 1, 240, 10) });
        break;
    }
  }
  return out;
}

/** Only what the screen still has: a part taken away takes what was in it. */
export function pruneState(blocks: Block[], state: AppState): AppState {
  const out: AppState = {};
  for (const b of blocks) if (state[b.id]) out[b.id] = state[b.id];
  return out;
}

/** A counter's value today: a daily one reads nothing on a new day. */
export const counterValue = (block: Block, s: BlockState | undefined, today: string) =>
  block.daily && s?.day !== today ? 0 : (s?.value ?? 0);

export type AppOp = {
  block: string;
  op: "add" | "toggle" | "remove" | "clear_done" | "count" | "set";
  text?: string;
  /** toggle, remove: the item's or entry's id */
  item?: string;
  /** toggle: set it rather than flip it */
  done?: boolean;
  /** count: how much to add */
  amount?: number;
  /** set: the counter's new value */
  value?: number;
};

/** One change to what's in the app, from a tap or from the assistant. Pure, so it's tested. */
export function applyOp(
  blocks: Block[],
  state: AppState,
  op: AppOp,
  today: string,
  now = Date.now(),
): { state: AppState } | { error: string } {
  const block = blocks.find((b) => b.id === op.block);
  if (!block) return { error: "That part of the app isn't there any more." };
  const cur: BlockState = { ...(state[block.id] ?? {}) };
  if (block.kind === "list") {
    let items = [...(cur.items ?? [])];
    if (op.op === "add") {
      const text = clean(op.text, 120);
      if (!text) return { error: "Nothing to add." };
      if (items.length >= MAX_LIST) return { error: "That list is full. Clear some items first." };
      items.push({ id: shortId(), text, done: false });
    } else if (op.op === "toggle") {
      const i = items.findIndex((x) => x.id === op.item);
      if (i < 0) return { error: "That item isn't on the list." };
      items[i] = { ...items[i], done: op.done ?? !items[i].done };
    } else if (op.op === "remove") {
      if (!items.some((x) => x.id === op.item)) return { error: "That item isn't on the list." };
      items = items.filter((x) => x.id !== op.item);
    } else if (op.op === "clear_done") {
      items = items.filter((x) => !x.done);
    } else return { error: `A list can't ${op.op}.` };
    cur.items = items;
  } else if (block.kind === "log") {
    let entries = [...(cur.entries ?? [])];
    if (op.op === "add") {
      const text = clean(op.text, 280);
      if (!text) return { error: "Nothing to write down." };
      entries = [{ id: shortId(), text, at: now }, ...entries].slice(0, MAX_LOG);
    } else if (op.op === "remove") {
      if (!entries.some((x) => x.id === op.item)) return { error: "That entry isn't in the log." };
      entries = entries.filter((x) => x.id !== op.item);
    } else return { error: `A log can't ${op.op}.` };
    cur.entries = entries;
  } else if (block.kind === "counter") {
    let value = counterValue(block, cur, today);
    if (op.op === "count") {
      const amount = number(op.amount ?? block.step ?? 1);
      if (!Number.isFinite(amount)) return { error: "How much?" };
      value += amount;
    } else if (op.op === "set") {
      const to = number(op.value);
      if (!Number.isFinite(to)) return { error: "Set it to what?" };
      value = to;
    } else return { error: `A counter can't ${op.op}.` };
    cur.value = Math.round(Math.min(1e6, Math.max(-1e6, value)) * 100) / 100;
    cur.day = today;
  } else return { error: `Nothing in "${block.title}" can be changed.` };
  return { state: { ...state, [block.id]: cur } };
}

// ---------- Stored ----------

type Row = {
  id: string;
  name: string;
  about: string;
  icon: string;
  tone: string;
  instructions: string;
  opener: string;
  blocks: string;
  state: string;
  speak: number;
  created_at: number;
  updated_at: number | null;
};

const parse = <T>(text: string | null | undefined, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

const shape = (r: Row) => ({
  id: r.id,
  name: r.name,
  about: r.about,
  icon: r.icon,
  tone: r.tone,
  instructions: r.instructions,
  opener: r.opener,
  blocks: parse<Block[]>(r.blocks, []),
  state: parse<AppState>(r.state, {}),
  speak: r.speak !== 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at ?? r.created_at,
});
export type MadeApp = ReturnType<typeof shape>;

const COLUMNS = "id, name, about, icon, tone, instructions, opener, blocks, state, speak, created_at, updated_at";

async function readApp(db: D1Database, userId: string, id: string) {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM user_apps WHERE id = ? AND user_id = ?`).bind(id, userId).first<Row>();
  return row ? shape(row) : null;
}

async function saveState(db: D1Database, userId: string, id: string, state: AppState) {
  await db
    .prepare("UPDATE user_apps SET state = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(JSON.stringify(state), Date.now(), id, userId)
    .run();
}

/** What a turn needs from an app that's open. Null for someone else's or a deleted one. */
export async function appFor(db: D1Database, userId: string, id: string) {
  return readApp(db, userId, id);
}

/** The app's screen as the model reads it: each part and what's in it, briefly. */
export function describeScreen(app: Pick<MadeApp, "blocks" | "state">, timeZone: string) {
  const today = buckets(Date.now(), timeZone).day;
  const lines = app.blocks.map((b) => {
    const s = app.state[b.id];
    switch (b.kind) {
      case "list": {
        const items = s?.items ?? [];
        const shown = items.slice(0, 40).map((x) => (x.done ? `${x.text} (ticked)` : x.text));
        return `- "${b.title}" (checklist): ${shown.length ? shown.join(", ") : "empty"}${items.length > 40 ? `, and ${items.length - 40} more` : ""}`;
      }
      case "counter": {
        const v = counterValue(b, s, today);
        return `- "${b.title}" (counter${b.daily ? ", starts again each day" : ""}): ${v}${b.goal ? ` of ${b.goal}` : ""}${b.unit ? ` ${b.unit}` : ""}`;
      }
      case "log": {
        const entries = s?.entries ?? [];
        const latest = entries
          .slice(0, 3)
          .map((e) => `"${e.text}" (${buckets(e.at, timeZone).day})`)
          .join("; ");
        return `- "${b.title}" (log, ${entries.length} entries)${latest ? `: latest ${latest}` : ""}`;
      }
      case "buttons":
        return `- "${b.title}" (buttons they can tap): ${(b.buttons ?? []).map((x) => x.label).join(", ")}`;
      case "note":
        return `- "${b.title}" (note they wrote): ${b.text}`;
      case "timer":
        return `- "${b.title}" (a ${b.minutes}-minute timer on their screen)`;
    }
  });
  return lines.length ? `Its screen, which they can see:\n${lines.join("\n")}` : "";
}

// ---------- While it's open: the assistant can change what's on its screen ----------

const APP_TOOL: ToolSpec = {
  name: "app_update",
  description:
    "Changes what's on the screen of the app they have open: add to its checklist or tick items off, write an entry in its log, add to or set its counter. Use it whenever what they say belongs in the app ('add milk', 'I drank a glass', 'log my run'), and never say it's done unless this returned ok.",
  parameters: {
    type: "object",
    properties: {
      part: { type: "string", description: "The part's title, as listed on the app's screen" },
      action: { type: "string", enum: ["add", "check", "uncheck", "remove", "clear_done", "count", "set"] },
      text: { type: "string", description: "add: the item or the entry. check, uncheck, remove: which item, in their words" },
      amount: { type: "number", description: "count: how much to add (negative takes some away). set: the new value" },
    },
    required: ["part", "action"],
  },
};

export const isAppTool = (name: string) => name === APP_TOOL.name;

const near = (a: string, b: string) => {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

export function appAssistant(env: Env, userId: string, appId: string, timeZone: string) {
  const callTool: CallTool = async (_name, args) => {
    // Read again rather than trusting the start of the turn: a tap may have changed it since.
    const app = await readApp(env.DB, userId, appId);
    if (!app) return { error: "That app has been deleted." };
    const action = String(args.action ?? "");
    const part = String(args.part ?? "");
    const text = String(args.text ?? "").trim();
    const kinds: BlockKind[] =
      action === "count" || action === "set" ? ["counter"] : action === "add" || action === "remove" ? ["list", "log"] : ["list"];
    const candidates = app.blocks.filter((b) => kinds.includes(b.kind));
    const block =
      candidates.find((b) => b.title.toLowerCase() === part.toLowerCase().trim()) ??
      candidates.find((b) => near(b.title, part)) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (!block) {
      return { error: `No part called "${part}" that can do that. The parts are: ${app.blocks.map((b) => `${b.title} (${b.kind})`).join(", ")}.` };
    }
    const today = buckets(Date.now(), timeZone).day;
    const s = app.state[block.id];
    const findItem = () =>
      block.kind === "log"
        ? (s?.entries ?? []).find((e) => near(e.text, text))?.id
        : (s?.items ?? []).find((x) => x.text.toLowerCase() === text.toLowerCase())?.id ??
          (s?.items ?? []).find((x) => near(x.text, text))?.id;
    let op: AppOp;
    switch (action) {
      case "add":
        op = { block: block.id, op: "add", text };
        break;
      case "check":
      case "uncheck":
        op = { block: block.id, op: "toggle", item: findItem(), done: action === "check" };
        break;
      case "remove":
        op = { block: block.id, op: "remove", item: findItem() };
        break;
      case "clear_done":
        op = { block: block.id, op: "clear_done" };
        break;
      case "count":
        op = { block: block.id, op: "count", amount: args.amount === undefined ? block.step : Number(args.amount) };
        break;
      case "set":
        op = { block: block.id, op: "set", value: Number(args.amount) };
        break;
      default:
        return { error: "action must be add, check, uncheck, remove, clear_done, count or set" };
    }
    const result = applyOp(app.blocks, app.state, op, today);
    if ("error" in result) return result;
    await saveState(env.DB, userId, app.id, result.state);
    return { ok: true, now: describeScreen({ blocks: [block], state: result.state }, timeZone) };
  };
  return { tools: [APP_TOOL], callTool };
}

// ---------- Designing one ----------

const blockSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Keep an existing part's id exactly; leave empty for a new part" },
    kind: { type: "string", enum: [...BLOCK_KINDS] },
    title: { type: "string", description: "One to three words" },
    buttons: {
      type: "array",
      description: "buttons only: 2 to 4 of them",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "One to three words on the button" },
          prompt: { type: "string", description: "What tapping it says to the assistant, in the person's voice" },
        },
        required: ["label", "prompt"],
      },
    },
    placeholder: { type: "string", description: "list and log only: the hint in the empty box" },
    unit: { type: "string", description: "counter only: what's counted, plural, e.g. 'glasses'" },
    goal: { type: "number", description: "counter only: the day's target, or 0 for none" },
    step: { type: "number", description: "counter only: how much one tap of + adds" },
    daily: { type: "boolean", description: "counter only: true to start again from 0 each day" },
    text: { type: "string", description: "note only: the words it shows" },
    minutes: { type: "number", description: "timer only: how long" },
  },
  required: ["kind", "title"],
};

const APP_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Two or three words, title case, no emoji" },
    about: { type: "string", description: "One short line, under 60 characters, saying what it does for them" },
    icon: { type: "string", enum: [...APP_ICONS] },
    tone: { type: "string", enum: [...APP_TONES] },
    instructions: {
      type: "string",
      description: "What the assistant does while this app is open, written to the assistant, 2 to 6 sentences",
    },
    opener: { type: "string", description: "The first thing the app says when it's opened: one short question" },
    blocks: { type: "array", description: "The app's screen, top to bottom: 2 to 5 parts", items: blockSchema },
  },
  required: ["name", "about", "icon", "tone", "instructions", "opener", "blocks"],
};

const DESIGNER = [
  "You design small apps that run inside a personal voice assistant called OVOA. The person describes what they want, spoken or typed, and you turn it into an app with its own screen.",
  "An app has instructions the assistant follows while it's open. The assistant can already: talk and answer questions, search the web, read and add to their calendar, email, reminders, notes, to-do lists and alarms, text and call people (with their approval), track health and money, and remember things. It can also change the app's own checklist, counter and log with its app_update tool. Only promise what that covers.",
  "Write the instructions to the assistant, in the second person: what to do when the person talks to it inside this app, what to ask for, what to keep track of (on the app's own screen where it has a part for it), and how to answer. Keep the person's own wording for anything specific (names, places, amounts).",
  "Give it a screen from these parts, 2 to 5 of them, most useful first:",
  "- buttons: quick actions. Almost every app has one, with 2 to 4 buttons, each a short label and the full request it sends to the assistant (e.g. label 'Plan dinner', prompt 'Plan tonight's dinner from what's on my list'). A button is for something that needs the assistant to think or act (plan, suggest, quiz, look up, sum up), never for what the other parts already do with a tap (adding to the list, counting, starting the timer).",
  "- list: a checklist they tick off (groceries, packing, tasks).",
  "- counter: something counted with + and - (glasses of water, push-ups, pages); a goal when there's a natural one; daily when it's a per-day count.",
  "- log: dated entries kept over time (workouts done, moods, a journal, what the baby ate).",
  "- timer: a countdown they start (a study session, a plank, steeping tea).",
  "- note: fixed words they'll want to see (their goals, a routine, rules). Only when the description gives you the words.",
  "Only add a part the app will really use. Keep everything plain: no Markdown, no emoji.",
].join("\n");

const draftSchema = z.object({
  name: z.string().trim().min(1).max(30),
  about: z.string().trim().min(1).max(90),
  icon: z.enum(APP_ICONS),
  tone: z.enum(APP_TONES),
  instructions: z.string().trim().min(1).max(1500),
  opener: z.string().trim().max(160).default(""),
  blocks: z.array(z.unknown()).max(MAX_BLOCKS * 2).default([]),
  speak: z.boolean().default(true),
});
export type AppDraft = Omit<z.infer<typeof draftSchema>, "blocks"> & { blocks: Block[] };

/** The model's answer as a draft. Anything it got wrong is fixed up, not refused. */
function toDraft(data: Record<string, unknown>, fallback: string, keep?: Partial<AppDraft>): AppDraft {
  const icon = APP_ICONS.find((i) => i === data.icon) ?? (keep?.icon as AppDraft["icon"] | undefined) ?? "sparkles-outline";
  const tone = APP_TONES.find((t) => t === data.tone) ?? (keep?.tone as AppDraft["tone"] | undefined) ?? "violet";
  return {
    name: clean(data.name, 30) || keep?.name || "My App",
    about: clean(data.about, 90) || keep?.about || clean(fallback, 90),
    icon,
    tone,
    instructions: String(data.instructions ?? "").trim().slice(0, 1500) || keep?.instructions || fallback.slice(0, 1500),
    opener: clean(data.opener, 160),
    blocks: sanitizeBlocks(data.blocks),
    speak: keep?.speak ?? true,
  };
}

async function askDesigner(env: Env, userId: string, purpose: string, system: string, text: string) {
  const raw = await generateText(env, {
    model: env.MEMORY_MODEL,
    json: { schema: APP_SCHEMA },
    fast: true,
    usage: { userId, purpose },
    system,
    turns: [{ role: "user", text }],
  });
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("I couldn't make an app from that. Could you say it another way?");
  }
}

/** Turns what someone said they want into an app. */
export async function designApp(env: Env, userId: string, description: string): Promise<AppDraft> {
  const data = await askDesigner(env, userId, "create app", DESIGNER, description);
  return toDraft(data, description);
}

/** Changes an app the way they asked ("add a button for dessert ideas"), keeping the rest as it was. */
export async function reviseApp(env: Env, userId: string, current: AppDraft, change: string): Promise<AppDraft> {
  const system = [
    DESIGNER,
    "",
    "Here you are changing an app they already have. You get the app as JSON and the change they asked for. Return the whole app with that change made, and everything they didn't ask to change exactly as it was, including every part's id and order.",
  ].join("\n");
  const { speak: _speak, ...app } = current;
  const data = await askDesigner(env, userId, "change app", system, JSON.stringify({ app, change }));
  const draft = toDraft(data, change, current);
  // A reply that lost the screen altogether keeps the one they had.
  if (!draft.blocks.length && current.blocks.length) draft.blocks = current.blocks;
  if (!draft.opener && current.opener && !/opener|first|ask/i.test(change)) draft.opener = current.opener;
  return draft;
}

// ---------- Routes ----------

export const myApps = new Hono<{ Bindings: Env; Variables: Vars }>();

myApps.get("/apps", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM user_apps WHERE user_id = ? ORDER BY created_at ASC`)
    .bind(c.var.userId)
    .all<Row>();
  return c.json({ apps: results.map(shape) });
});

myApps.post("/apps/design", async (c) => {
  const parsed = z.object({ description: z.string().trim().min(3).max(2000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Say a little about what the app should do" }, 400);
  try {
    return c.json({ draft: await designApp(c.env, c.var.userId, parsed.data.description) });
  } catch (err) {
    // Not part of their plan, the day's spend is used up, or no consent yet: said plainly (plans.ts).
    if (isModelRefused(err)) return refusedResponse(c, err);
    console.error("ovoa.err apps: couldn't design an app", err);
    // No engine could answer: said plainly, the way a turn says it (llm.ts).
    if (isAiUnreachable(err)) return c.json({ error: AI_UNREACHABLE }, 503);
    return c.json({ error: err instanceof Error ? err.message : "Couldn't make that app" }, 502);
  }
});

myApps.post("/apps/revise", async (c) => {
  const parsed = z
    .object({ app: draftSchema, change: z.string().trim().min(2).max(1000) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Say what you'd like to change" }, 400);
  const current = { ...parsed.data.app, blocks: sanitizeBlocks(parsed.data.app.blocks) };
  try {
    return c.json({ draft: await reviseApp(c.env, c.var.userId, current, parsed.data.change) });
  } catch (err) {
    // Not part of their plan, the day's spend is used up, or no consent yet: said plainly (plans.ts).
    if (isModelRefused(err)) return refusedResponse(c, err);
    console.error("ovoa.err apps: couldn't change an app", err);
    if (isAiUnreachable(err)) return c.json({ error: AI_UNREACHABLE }, 503);
    return c.json({ error: err instanceof Error ? err.message : "Couldn't change that app" }, 502);
  }
});

/**
 * Keeps a designed app as theirs: the Save on the Create screen (POST /apps),
 * and setup, which makes one for each goal they name (onboarding.ts). Null
 * when they already have MAX_APPS.
 */
export async function saveApp(db: D1Database, userId: string, d: Omit<AppDraft, "blocks"> & { blocks: unknown[] }) {
  const count = await db.prepare("SELECT COUNT(*) AS n FROM user_apps WHERE user_id = ?").bind(userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_APPS) return null;
  const now = Date.now();
  const row: Row = {
    id: crypto.randomUUID(),
    name: d.name,
    about: d.about,
    icon: d.icon,
    tone: d.tone,
    instructions: d.instructions,
    opener: d.opener,
    blocks: JSON.stringify(sanitizeBlocks(d.blocks)),
    state: "{}",
    speak: d.speak ? 1 : 0,
    created_at: now,
    updated_at: now,
  };
  await db
    .prepare(
      "INSERT INTO user_apps (id, user_id, name, about, icon, tone, instructions, opener, blocks, state, speak, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(row.id, userId, row.name, row.about, row.icon, row.tone, row.instructions, row.opener, row.blocks, row.state, row.speak, now, now)
    .run();
  return shape(row);
}

myApps.post("/apps", async (c) => {
  const parsed = draftSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "That app is missing something" }, 400);
  const app = await saveApp(c.env.DB, c.var.userId, parsed.data);
  if (!app) return c.json({ error: `You can make up to ${MAX_APPS} apps. Delete one to make room.` }, 409);
  return c.json({ app });
});

/** Changes how the app looks and behaves. What's in its parts stays, except in parts taken away. */
myApps.put("/apps/:id", async (c) => {
  const parsed = draftSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "That app is missing something" }, 400);
  const app = await readApp(c.env.DB, c.var.userId, c.req.param("id"));
  if (!app) return c.json({ error: "That app has been deleted" }, 404);
  const d = parsed.data;
  const blocks = sanitizeBlocks(d.blocks);
  const state = pruneState(blocks, app.state);
  await c.env.DB.prepare(
    "UPDATE user_apps SET name = ?, about = ?, icon = ?, tone = ?, instructions = ?, opener = ?, blocks = ?, state = ?, speak = ?, updated_at = ? WHERE id = ? AND user_id = ?",
  )
    .bind(d.name, d.about, d.icon, d.tone, d.instructions, d.opener, JSON.stringify(blocks), JSON.stringify(state), d.speak ? 1 : 0, Date.now(), app.id, c.var.userId)
    .run();
  return c.json({ app: await readApp(c.env.DB, c.var.userId, app.id) });
});

const opSchema = z.object({
  block: z.string().min(1).max(40),
  op: z.enum(["add", "toggle", "remove", "clear_done", "count", "set"]),
  text: z.string().max(400).optional(),
  item: z.string().max(40).optional(),
  done: z.boolean().optional(),
  amount: z.number().finite().optional(),
  value: z.number().finite().optional(),
  timeZone: z.string().max(64).optional(),
});

/** A tap on the app's screen: tick an item, add to the log, count one more. No model, so no allowance. */
myApps.post("/apps/:id/state", async (c) => {
  const parsed = opSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "That change didn't make sense" }, 400);
  const app = await readApp(c.env.DB, c.var.userId, c.req.param("id"));
  if (!app) return c.json({ error: "That app has been deleted" }, 404);
  const { timeZone, ...op } = parsed.data;
  let zone = "UTC";
  try {
    if (timeZone) {
      new Intl.DateTimeFormat("en-US", { timeZone });
      zone = timeZone;
    }
  } catch {}
  const result = applyOp(app.blocks, app.state, op, buckets(Date.now(), zone).day);
  if ("error" in result) return c.json({ error: result.error }, 400);
  await saveState(c.env.DB, c.var.userId, app.id, result.state);
  return c.json({ app: { ...app, state: result.state } });
});

myApps.delete("/apps/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM user_apps WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.var.userId).run();
  return c.json({ ok: true });
});
