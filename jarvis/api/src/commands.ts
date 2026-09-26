import { Hono } from "hono";
import { z } from "zod";
import { logAction } from "./actionlog";
import { push } from "./push";
import type { Env, Vars } from "./types";

// The push command channel. See migrations/0015_command_queue.sql.

/** A phone that claimed a command and never reported back is assumed to have died doing it. */
const CLAIM_TIMEOUT_MS = 10 * 60_000;
/** Past this, a command is dropped rather than run late. */
const EXPIRE_MS = 24 * 60 * 60_000;
/** Commands handed to the phone per drain, so a backlog can't pin it for minutes. */
const PER_DRAIN = 5;

export type CommandSource = "agent" | "system";

/**
 * Tools a command turn never gets, on top of the agent's own list: anything that
 * reaches another person or deletes. The phone versions matter here because a
 * command runs on the phone, where the model otherwise has them.
 */
export const FORBIDDEN_FOR_COMMANDS = new Set([
  "gmail_send",
  "gmail_trash",
  "drive_trash",
  "calendar_delete_event",
  "phone_message_compose",
  "phone_email_compose",
  "phone_call",
  "phone_calendar_delete_event",
  "phone_shortcut_run",
  // Another person's OVOA is another person (network.ts), and a username is theirs to pick.
  "ovoa_connect",
  "ovoa_connect_answer",
  "ovoa_ask",
  "ovoa_approve",
  "ovoa_disconnect",
  "ovoa_perms",
  "username_set",
  "username_change",
]);

export async function enqueueCommand(env: Env, userId: string, text: string, source: CommandSource, reason?: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO command_queue (id, user_id, text, source, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, userId, text.slice(0, 2000), source, reason?.slice(0, 300) ?? null, Date.now())
    .run();
  // The doorbell. Losing it costs nothing but time: the app drains on next open.
  const rang = await push(env, userId, { silent: true, data: { type: "command", id } }).catch(() => 0);
  return { id, rang: rang > 0 };
}

/** How many commands the agent has queued in the last hour. */
export async function agentCommandsLastHour(db: D1Database, userId: string) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM command_queue WHERE user_id = ? AND source = 'agent' AND created_at > ?")
    .bind(userId, Date.now() - 3_600_000)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export const commands = new Hono<{ Bindings: Env; Variables: Vars }>();

/**
 * What the phone should run now. Claiming happens here, in the same request, so
 * two drains racing each other (a push and a return to the app at once) can't
 * both run the same command.
 */
commands.get("/commands/pending", async (c) => {
  const db = c.env.DB;
  const userId = c.var.userId;
  const now = Date.now();
  await db
    .prepare("UPDATE command_queue SET status = 'expired' WHERE user_id = ? AND status IN ('pending', 'running') AND created_at < ?")
    .bind(userId, now - EXPIRE_MS)
    .run();
  const { results } = await db
    .prepare(
      `UPDATE command_queue SET status = 'running', claimed_at = ?
        WHERE id IN (
          SELECT id FROM command_queue
           WHERE user_id = ? AND (status = 'pending' OR (status = 'running' AND claimed_at < ?))
           ORDER BY created_at LIMIT ?)
        RETURNING id, text, source, reason, created_at`,
    )
    .bind(now, userId, now - CLAIM_TIMEOUT_MS, PER_DRAIN)
    .all<{ id: string; text: string; source: CommandSource; reason: string | null; created_at: number }>();
  results.sort((a, b) => a.created_at - b.created_at);
  return c.json({ commands: results });
});

const doneSchema = z.object({ ok: z.boolean(), result: z.string().max(2000).optional() });

commands.post("/commands/:id/done", async (c) => {
  const parsed = doneSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid result" }, 400);
  const row = await c.env.DB.prepare(
    `UPDATE command_queue SET status = ?, ran_at = ?, result = ?
      WHERE id = ? AND user_id = ? AND status = 'running'
      RETURNING text, source`,
  )
    .bind(parsed.data.ok ? "done" : "failed", Date.now(), parsed.data.result ?? null, c.req.param("id"), c.var.userId)
    .first<{ text: string; source: CommandSource }>();
  if (!row) return c.json({ error: "No such command running" }, 404);
  await logAction(
    c.env.DB,
    c.var.userId,
    "command",
    `${parsed.data.ok ? "Ran" : "Couldn't run"}: ${row.text}`.slice(0, 300),
    row.source === "agent" ? "agent" : "system",
    c.req.param("id"),
  );
  return c.json({ ok: true });
});

/** Recent commands and how they went, for Dev tools and the feed. */
commands.get("/commands", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, text, source, reason, status, created_at, ran_at, result FROM command_queue WHERE user_id = ? ORDER BY created_at DESC LIMIT 30",
  )
    .bind(c.var.userId)
    .all();
  return c.json({ commands: results });
});
