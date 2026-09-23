import { Hono } from "hono";
import { z } from "zod";
import type { Env, Vars } from "./types";

const MAX_CONTACTS = 5;

export const fitness = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---------- Steps ----------

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const stepsSchema = z.object({
  days: z.array(z.object({ day, steps: z.number().int().min(0).max(200_000) })).min(1).max(31),
});

// The phone is the source of truth (iOS keeps 7 days), so each sync overwrites those days.
fitness.put("/steps", async (c) => {
  const parsed = stepsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid step data" }, 400);
  const db = c.env.DB;
  const now = Date.now();
  await db.batch(
    parsed.data.days.map((d) =>
      db
        .prepare(
          `INSERT INTO step_days (user_id, day, steps, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, day) DO UPDATE SET steps = excluded.steps, updated_at = excluded.updated_at`,
        )
        .bind(c.var.userId, d.day, d.steps, now),
    ),
  );
  return c.json({ ok: true });
});

fitness.get("/steps", async (c) => {
  const { results } = await c.env.DB
    .prepare("SELECT day, steps FROM step_days WHERE user_id = ? ORDER BY day DESC LIMIT 30")
    .bind(c.var.userId)
    .all<{ day: string; steps: number }>();
  return c.json({ days: results.reverse() });
});

export async function fitnessSummary(db: D1Database, userId: string) {
  const { results } = await db
    .prepare("SELECT day, steps FROM step_days WHERE user_id = ? ORDER BY day DESC LIMIT 7")
    .bind(userId)
    .all<{ day: string; steps: number }>();
  return results.map((d) => `- ${d.day}: ${d.steps} steps`).join("\n");
}

// ---------- Emergency contacts ----------

const contactSchema = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()\-.]{7,20}$/, "Enter a valid phone number"),
});

fitness.get("/contacts", async (c) => {
  const { results } = await c.env.DB
    .prepare("SELECT id, name, phone FROM emergency_contacts WHERE user_id = ? ORDER BY created_at")
    .bind(c.var.userId)
    .all();
  return c.json({ contacts: results });
});

fitness.post("/contacts", async (c) => {
  const parsed = contactSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid contact" }, 400);
  const db = c.env.DB;
  const count = await db
    .prepare("SELECT COUNT(*) AS n FROM emergency_contacts WHERE user_id = ?")
    .bind(c.var.userId)
    .first<number>("n");
  if ((count ?? 0) >= MAX_CONTACTS) return c.json({ error: `You can add up to ${MAX_CONTACTS} contacts` }, 400);

  const contact = { id: crypto.randomUUID(), ...parsed.data };
  await db
    .prepare("INSERT INTO emergency_contacts (id, user_id, name, phone, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(contact.id, c.var.userId, contact.name, contact.phone, Date.now())
    .run();
  return c.json({ contact }, 201);
});

fitness.delete("/contacts/:id", async (c) => {
  await c.env.DB
    .prepare("DELETE FROM emergency_contacts WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.var.userId)
    .run();
  return c.json({ ok: true });
});

// ---------- Safety events ----------

const eventSchema = z.object({
  // SOS only since 2026-09-23. A "fall" from an older build gets the 400 (the
  // phone logs it and moves on; its text to the contacts doesn't wait on this),
  // and the fall rows already stored go with the 14-day purge (retention.ts).
  kind: z.literal("sos"),
  status: z.enum(["ok", "alerted"]),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
});

fitness.post("/safety-events", async (c) => {
  const parsed = eventSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid event" }, 400);
  const e = parsed.data;
  const event = { id: crypto.randomUUID(), ...e, created_at: Date.now() };
  await c.env.DB
    .prepare(
      "INSERT INTO safety_events (id, user_id, kind, status, latitude, longitude, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(event.id, c.var.userId, e.kind, e.status, e.latitude ?? null, e.longitude ?? null, event.created_at)
    .run();
  return c.json({ event }, 201);
});

fitness.get("/safety-events", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      "SELECT id, kind, status, latitude, longitude, created_at FROM safety_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
    )
    .bind(c.var.userId)
    .all();
  return c.json({ events: results });
});
