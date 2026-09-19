import { Hono } from "hono";
import { z } from "zod";
import { isMeantForAssistant } from "./ambient";
import { sessionForToken } from "./auth";
import type { Env } from "./types";

// The app uploads its log here every few seconds. Public on purpose, so crashes
// before sign-in still arrive; a bearer token, when sent, tags the rows with the user.

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

const uploadSchema = z.object({
  deviceId: z.string().min(8).max(64),
  sessionId: z.string().min(4).max(64),
  build: z.string().max(64).optional(),
  entries: z
    .array(
      z.object({
        time: z.number().int(),
        kind: z.string().max(16),
        text: z.string().max(1000),
        detail: z.string().max(4000).optional(),
      }),
    )
    .min(1)
    .max(200),
});

export const logs = new Hono<{ Bindings: Env }>();

logs.post("/logs", async (c) => {
  const parsed = uploadSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid logs" }, 400);
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const session = token ? await sessionForToken(c.env.DB, token).catch(() => null) : null;
  const { deviceId, sessionId, build, entries } = parsed.data;
  const now = Date.now();
  const db = c.env.DB;
  await db.batch([
    ...entries.map((e) =>
      db
        .prepare(
          "INSERT INTO device_logs (device_id, user_id, session_id, app_build, time, kind, text, detail, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(deviceId, session?.userId ?? null, sessionId, build ?? null, e.time, e.kind, e.text, e.detail ?? null, now),
    ),
    // Roughly 1 upload in 50 also clears out old rows.
    ...(Math.random() < 0.02 ? [db.prepare("DELETE FROM device_logs WHERE received_at < ?").bind(now - KEEP_MS)] : []),
  ]);
  return c.json({ ok: true, stored: entries.length });
});

/** Checks the always-listening gate on a sentence, without any user's history. Needs the DEBUG_KEY secret. */
logs.post("/debug/ambient", async (c) => {
  if (!c.env.DEBUG_KEY || c.req.header("x-debug-key") !== c.env.DEBUG_KEY) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
  if (!body?.text) return c.json({ error: "text is required" }, 400);
  const started = Date.now();
  const addressed = await isMeantForAssistant(c.env, null, body.text, "OVOA");
  return c.json({ addressed, ms: Date.now() - started });
});
