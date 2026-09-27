// Standing approvals: the "you don't have to ask me" rules.
//
// "Approve for me" (settings.auto_approve) is all or nothing. Most people want
// something in between: "don't ask before emailing my wife", "just put things on
// my calendar". A rule covers one kind of action for one recipient, or for
// anyone. It's checked right before an action would be parked for a YES
// (google/assistant.ts), and when it matches, the action runs as with Approve
// for me.
//
// What a rule can never cover: deleting or trashing anything, money (budget.ts
// purchases always wait for a YES), anything the agent starts on its own (the
// caller passes no rules for those turns), and a Google action where OVOA
// picked the account itself.

import { Hono } from "hono";
import type { CallTool, ToolSpec } from "./llm";
import type { Env, Vars } from "./types";

export const RULE_KINDS = ["email", "text", "call", "calendar"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/** Which tools each kind covers. Deletes are absent on purpose. */
const TOOLS_BY_KIND: Record<RuleKind, string[]> = {
  email: ["gmail_send", "phone_email_compose"],
  text: ["phone_message_compose"],
  call: ["phone_call"],
  calendar: ["calendar_create_event", "calendar_update_event", "phone_calendar_create_event", "phone_calendar_update_event"],
};

export const kindOfTool = (tool: string): RuleKind | null =>
  (RULE_KINDS.find((k) => TOOLS_BY_KIND[k].includes(tool)) as RuleKind | undefined) ?? null;

/** One way to write an address, a number or a name, so "Sam@X.com" and "sam@x.com " match. Pure. */
export function normalRecipient(value: string): string {
  const v = value.trim().toLowerCase();
  if (!v) return "";
  if (v.includes("@")) return v.replace(/^.*<([^>]+)>.*$/, "$1").trim();
  const digits = v.replace(/\D/g, "");
  if (digits.length >= 10 && /^[\d\s()+.-]+$/.test(v)) return digits.slice(-10);
  return v.replace(/\s+/g, " ");
}

/** Everyone an action goes to, from the tool's own arguments. Pure. */
export function recipientsOf(args: Record<string, unknown>): string[] {
  const raw: unknown[] = [];
  for (const key of ["to", "cc", "attendees", "number", "phone"]) {
    const v = args[key];
    if (Array.isArray(v)) raw.push(...v);
    else if (typeof v === "string") raw.push(...v.split(","));
  }
  return raw.map((r) => normalRecipient(String(r))).filter(Boolean);
}

type RuleRow = { id: string; kind: string; recipient: string; label: string; created_at: number };

/**
 * Does a standing rule let this action go without asking? Every recipient has to
 * be covered (by their own rule or an "anyone" rule for that kind).
 */
export async function ruleAllows(db: D1Database, userId: string, tool: string, args: Record<string, unknown>): Promise<boolean> {
  const kind = kindOfTool(tool);
  if (!kind) return false;
  const { results } = await db
    .prepare("SELECT recipient FROM approval_rules WHERE user_id = ? AND kind = ?")
    .bind(userId, kind)
    .all<{ recipient: string }>();
  if (!results.length) return false;
  const covered = new Set(results.map((r) => r.recipient));
  const to = recipientsOf(args);
  // A calendar event with guests emails them invitations: an "anyone" calendar
  // rule covers events with no guests, and each guest needs a rule of their own.
  if (kind === "calendar" && to.length) return to.every((r) => covered.has(r));
  if (covered.has("")) return true;
  return to.length > 0 && to.every((r) => covered.has(r));
}

/** A rule check bound to one person, or null for turns rules never apply to (the agent's own). */
export type RuleCheck = (tool: string, args: Record<string, unknown>) => Promise<boolean>;
export const rulesFor = (env: Env, userId: string): RuleCheck => (tool, args) => ruleAllows(env.DB, userId, tool, args);

export const MAX_RULES = 50;

export async function addRule(db: D1Database, userId: string, kindIn: unknown, recipientIn: unknown, now = Date.now()) {
  const kind = String(kindIn ?? "") as RuleKind;
  if (!(RULE_KINDS as readonly string[]).includes(kind)) return { error: `kind must be one of ${RULE_KINDS.join(", ")}` };
  const recipient = normalRecipient(String(recipientIn ?? ""));
  const count = await db.prepare("SELECT COUNT(*) AS n FROM approval_rules WHERE user_id = ?").bind(userId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_RULES) return { error: `That's the ${MAX_RULES} rules they can have. Remove one first.` };
  const label = recipient ? `${kind} to ${recipient} without asking` : `any ${kind} without asking`;
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO approval_rules (id, user_id, kind, recipient, label, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, kind, recipient) DO NOTHING")
    .bind(id, userId, kind, recipient, label, now)
    .run();
  return { kind, recipient: recipient || "anyone", label };
}

export async function listRules(db: D1Database, userId: string) {
  const { results } = await db
    .prepare("SELECT id, kind, recipient, label, created_at FROM approval_rules WHERE user_id = ? ORDER BY created_at")
    .bind(userId)
    .all<RuleRow>();
  return results.map((r) => ({ id: r.id, kind: r.kind, recipient: r.recipient || "anyone", label: r.label }));
}

const TOOLS: ToolSpec[] = [
  {
    name: "rule_add",
    description:
      "Saves a standing approval when they say not to ask before something: kind email, text, call or calendar, for one recipient (email address, phone number or contact name) or leave recipient empty for anyone. Deletes and purchases can't be covered.",
    parameters: {
      type: "object",
      properties: { kind: { type: "string", enum: [...RULE_KINDS] }, recipient: { type: "string" } },
      required: ["kind"],
    },
  },
  {
    name: "rule_list",
    description: "Lists their standing approvals.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "rule_remove",
    description: "Removes a standing approval by its id (from rule_list), so that kind of action asks again.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isRuleTool = (name: string) => NAMES.has(name);

export function rulesAssistant(env: Env, userId: string) {
  const callTool: CallTool = async (name, args) => {
    if (name === "rule_add") return addRule(env.DB, userId, args.kind, args.recipient);
    if (name === "rule_list") return { rules: await listRules(env.DB, userId) };
    if (name === "rule_remove") {
      const done = await env.DB.prepare("DELETE FROM approval_rules WHERE id = ? AND user_id = ?").bind(String(args.id ?? ""), userId).run();
      return done.meta.changes ? { removed: true } : { error: "No rule with that id." };
    }
    return { error: `Unknown tool ${name}` };
  };
  return {
    tools: TOOLS,
    callTool,
    prompt:
      "Standing approvals: when they say you don't need to ask before something (\"just email my wife, don't ask\", \"put things on my calendar without asking\"), save it with rule_add and say what it covers. Deleting, money and anything you do on your own always still ask.",
  };
}

/** The app's list of standing approvals. */
export const ruleRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

ruleRoutes.get("/approval-rules", async (c) => c.json({ rules: await listRules(c.env.DB, c.var.userId) }));

ruleRoutes.post("/approval-rules", async (c) => {
  const body = ((await c.req.json().catch(() => null)) ?? {}) as { kind?: unknown; recipient?: unknown };
  const added = await addRule(c.env.DB, c.var.userId, body.kind, body.recipient);
  return c.json(added, "error" in added ? 400 : 201);
});

ruleRoutes.delete("/approval-rules/:id", async (c) => {
  const done = await c.env.DB.prepare("DELETE FROM approval_rules WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.var.userId).run();
  return done.meta.changes ? c.body(null, 204) : c.json({ error: "Not found." }, 404);
});
