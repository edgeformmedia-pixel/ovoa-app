// OVOA in an iMessage group, when someone asks it something there.
//
// Groups were ignored outright (texting.ts): the others never agreed to OVOA
// reading them. This lets OVOA join in only when all of these hold:
//   - TEXT_GROUPS is "1" (off by default, so nothing changes until it's on);
//   - the message names OVOA (or the sender's own name for it);
//   - the sender has OVOA linked to their number;
//   - everyone else in the group is one of the sender's Friends (an accepted
//     connection, network.ts) with OVOA linked too.
//
// In the group OVOA has no tools and none of anyone's private things (no
// memories, calendar, email, vault): it answers from the conversation alone. When
// the ask needs the sender's accounts or an action ("book us a table", "put it
// on my calendar"), OVOA says so in the group and hands the task to the
// sender's private 1:1 thread, where their usual tools and approvals apply.
// Only the lines that named OVOA and its answers are kept, for 14 days.

import { generateText, isModelRefused } from "./llm";
import { noDashes } from "./sentences";
import type { Env } from "./types";

export const MAX_GROUP_LINES = 16;
const DAY_MS = 86_400_000;

export type GroupLine = { who: string; text: string };

export const groupsOn = (env: Env) => env.TEXT_GROUPS === "1";

/** Does the text name OVOA? `extra` is the sender's own name for it (settings.assistant_name). Pure. */
export function mentionsOvoa(text: string, extra?: string | null): boolean {
  const names = ["ovoa", ...(extra && extra.trim().length >= 2 ? [extra.trim().toLowerCase()] : [])];
  const t = text.toLowerCase();
  return names.some((n) => new RegExp(`(^|[^a-z0-9])@?${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(t));
}

const SYSTEM = [
  "You are OVOA, an AI assistant, answering in an iMessage group chat because someone in it asked you something.",
  "Everyone in the group reads your reply. You have no tools here and none of anyone's private things (calendar, email, memories, saved details): answer only from the conversation and what you generally know.",
  "Text like a chill person in a group chat: one or two short sentences, plain words, no markdown, never em dashes.",
  "If what they ask needs the asker's own accounts or an action (booking, emailing, their calendar, reminders, buying, looking something up live), don't do it in the group: set private_task to a clear, complete instruction for yourself to carry out privately for the asker, and in reply say briefly that you'll sort it out with them 1:1.",
  "Never reveal or guess anyone's private details.",
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "What to say in the group." },
    private_task: { type: ["string", "null"], description: "An instruction to carry out privately for the asker, or null." },
  },
  required: ["reply", "private_task"],
  description: "OVOA's group reply",
};

export type GroupAnswer = { reply: string; private_task: string | null };

export type GroupWrite = (system: string, turns: { role: "user" | "model"; text: string }[], userId: string) => Promise<GroupAnswer>;
type Write = GroupWrite;

const modelWrite: (env: Env) => Write = (env) => async (system, turns, userId) => {
  const raw = await generateText(env, {
    model: env.CHAT_MODEL,
    fast: true,
    usage: { userId, purpose: "group text" },
    json: { schema: SCHEMA },
    system,
    turns,
  });
  const parsed = JSON.parse(raw) as Partial<GroupAnswer>;
  return { reply: String(parsed.reply ?? ""), private_task: parsed.private_task ? String(parsed.private_task) : null };
};

/** Sends to a Sendblue group (POST /api/send-group-message). */
export async function sendGroup(env: Env, groupId: string, content: string, line: string | null): Promise<boolean> {
  const base = (env.SENDBLUE_API_BASE || "https://api.sendblue.co").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/send-group-message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-api-key-id": env.SENDBLUE_API_KEY_ID ?? "",
        "sb-api-secret-key": env.SENDBLUE_API_SECRET ?? "",
      },
      body: JSON.stringify({ group_id: groupId, content, from_number: line || env.SENDBLUE_NUMBER || "" }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function userByPhone(db: D1Database, phone: string) {
  return db
    .prepare("SELECT l.user_id, u.name, s.assistant_name FROM text_links l JOIN users u ON u.id = l.user_id LEFT JOIN settings s ON s.user_id = l.user_id WHERE l.phone = ?")
    .bind(phone)
    .first<{ user_id: string; name: string; assistant_name: string | null }>();
}

async function connected(db: D1Database, a: string, b: string) {
  return !!(await db
    .prepare(
      "SELECT 1 AS x FROM connections WHERE status = 'accepted' AND ((requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1))",
    )
    .bind(a, b)
    .first());
}

async function history(db: D1Database, groupId: string, now: number): Promise<GroupLine[]> {
  const row = await db.prepare("SELECT history, updated_at FROM text_groups WHERE group_id = ?").bind(groupId).first<{ history: string; updated_at: number }>();
  if (!row || row.updated_at < now - 14 * DAY_MS) return [];
  try {
    const lines = JSON.parse(row.history) as GroupLine[];
    return Array.isArray(lines) ? lines.slice(-MAX_GROUP_LINES) : [];
  } catch {
    return [];
  }
}

async function remember(db: D1Database, groupId: string, lines: GroupLine[], now: number) {
  await db
    .prepare("INSERT INTO text_groups (group_id, history, updated_at) VALUES (?, ?, ?) ON CONFLICT(group_id) DO UPDATE SET history = excluded.history, updated_at = excluded.updated_at")
    .bind(groupId, JSON.stringify(lines.slice(-MAX_GROUP_LINES)), now)
    .run();
}

export type GroupText = {
  groupId: string;
  from: string;
  line: string | null;
  content: string;
  /** Everyone in the group, OVOA's line included. */
  participants: string[];
};

/**
 * Answers a group text if OVOA was asked and everyone there is the sender's
 * Friend. `privately` hands a task to the sender's own 1:1 thread (texting.ts).
 * Returns what happened, for logs.
 */
export async function answerGroup(
  env: Env,
  g: GroupText,
  privately: (userId: string, task: string, asker: string) => Promise<void>,
  now = Date.now(),
  write?: Write,
): Promise<string> {
  const answerWith = write ?? modelWrite(env);
  const db = env.DB;
  const sender = await userByPhone(db, g.from);
  if (!sender) return "group: sender not linked";
  if (!mentionsOvoa(g.content, sender.assistant_name)) return "group: not for ovoa";

  const lines = new Set([g.line, env.SENDBLUE_NUMBER].filter(Boolean) as string[]);
  const others = [...new Set(g.participants)].filter((p) => p !== g.from && !lines.has(p));
  for (const phone of others) {
    const them = await userByPhone(db, phone);
    if (!them || !(await connected(db, sender.user_id, them.user_id))) return "group: not everyone is a friend";
  }

  const first = sender.name.split(" ")[0] || "Someone";
  const past = await history(db, g.groupId, now);
  const turns = past.map((l) => (l.who === "OVOA" ? { role: "model" as const, text: l.text } : { role: "user" as const, text: `${l.who}: ${l.text}` }));
  turns.push({ role: "user", text: `${first}: ${g.content}` });

  let answer: GroupAnswer;
  try {
    answer = await answerWith(SYSTEM, turns, sender.user_id);
  } catch (err) {
    // Out of replies for the day, or no consent: stay quiet in the group.
    if (!isModelRefused(err)) console.error("ovoa.err group text", err);
    return "group: no answer";
  }
  const reply = noDashes(answer.reply.trim()).slice(0, 1_000);
  if (reply) await sendGroup(env, g.groupId, reply, g.line);
  await remember(db, g.groupId, [...past, { who: first, text: g.content }, ...(reply ? [{ who: "OVOA", text: reply }] : [])], now);
  if (answer.private_task?.trim()) await privately(sender.user_id, answer.private_task.trim().slice(0, 1_000), first);
  return answer.private_task ? "group: answered, task handed over" : "group: answered";
}
