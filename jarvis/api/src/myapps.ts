import { Hono } from "hono";
import { z } from "zod";
import { generateText } from "./llm";
import type { Env, Vars } from "./types";

// Apps people make themselves (the app's Apps → Create).
//
// Someone says or types what they want — "a grocery helper that asks what I'm
// out of and adds it to my list" — and the model turns that into an app: a
// name, one line saying what it does, an icon, and the instructions OVOA
// follows while it's open. Designing and saving are two calls, so the person
// sees what they'd get before it's theirs.
//
// A made app is not new code. It runs on the assistant, in Talk, with its
// instructions riding on each message sent while it's open (chatTurn in
// index.ts, through `app` on /chat). So it can do whatever OVOA can already do,
// asks for approval the same way, and each thing asked of it is an ordinary
// reply against the day's allowance.

/** Icons the app can draw (Ionicons names, all in @expo/vector-icons). */
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

/** At most this many made apps each. */
export const MAX_APPS = 30;

const draftSchema = z.object({
  name: z.string().trim().min(1).max(30),
  about: z.string().trim().min(1).max(90),
  icon: z.enum(APP_ICONS),
  tone: z.enum(APP_TONES),
  instructions: z.string().trim().min(1).max(1500),
  opener: z.string().trim().max(160).default(""),
});
export type AppDraft = z.infer<typeof draftSchema>;

type Row = {
  id: string;
  name: string;
  about: string;
  icon: string;
  tone: string;
  instructions: string;
  opener: string;
  created_at: number;
};

const shape = (r: Row) => ({
  id: r.id,
  name: r.name,
  about: r.about,
  icon: r.icon,
  tone: r.tone,
  instructions: r.instructions,
  opener: r.opener,
  createdAt: r.created_at,
});

/** What a turn needs from an app that's open: its name and what to do. Null for someone else's or a deleted one. */
export async function appFor(db: D1Database, userId: string, id: string) {
  return db
    .prepare("SELECT name, instructions FROM user_apps WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<{ name: string; instructions: string }>();
}

/** Turns what someone said they want into an app. Anything the model gets wrong is fixed up, not refused. */
export async function designApp(env: Env, userId: string, description: string): Promise<AppDraft> {
  const raw = await generateText(env, {
    model: env.MEMORY_MODEL,
    json: {
      schema: {
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
          opener: { type: "string", description: "The first thing the assistant says when the app is opened: one short question" },
        },
        required: ["name", "about", "icon", "tone", "instructions", "opener"],
      },
    },
    fast: true,
    usage: { userId, purpose: "create app" },
    system: [
      "You design small apps that run inside a personal voice assistant called OVOA. The person describes what they want, spoken or typed, and you turn it into an app.",
      "An app is a set of instructions the assistant follows while the app is open. The assistant can already: talk and answer questions, search the web, read and add to their calendar, email, reminders, notes, to-do lists and alarms, text and call people (with their approval), track health and money, and remember things. Only promise what that covers.",
      "Write the instructions to the assistant, in the second person: what to do when the person talks to it inside this app, what to ask for, what to keep track of, and how to answer. Keep the person's own wording for anything specific (names, places, amounts).",
      "Keep everything plain: no Markdown, no emoji.",
    ].join("\n"),
    turns: [{ role: "user", text: description }],
  });
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("I couldn't make an app from that. Could you say it another way?");
  }
  const text = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const icon = APP_ICONS.find((i) => i === data.icon) ?? "sparkles-outline";
  const tone = APP_TONES.find((t) => t === data.tone) ?? "violet";
  const draft = {
    name: text(data.name, 30) || "My App",
    about: text(data.about, 90) || text(description, 90),
    icon,
    tone,
    instructions: String(data.instructions ?? "").trim().slice(0, 1500) || description.slice(0, 1500),
    opener: text(data.opener, 160),
  };
  return draftSchema.parse(draft);
}

export const myApps = new Hono<{ Bindings: Env; Variables: Vars }>();

myApps.get("/apps", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, about, icon, tone, instructions, opener, created_at FROM user_apps WHERE user_id = ? ORDER BY created_at ASC",
  )
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
    console.error("ovoa.err apps: couldn't design an app", err);
    return c.json({ error: err instanceof Error ? err.message : "Couldn't make that app" }, 502);
  }
});

myApps.post("/apps", async (c) => {
  const parsed = draftSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "That app is missing something" }, 400);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM user_apps WHERE user_id = ?")
    .bind(c.var.userId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_APPS) return c.json({ error: `You can make up to ${MAX_APPS} apps. Delete one to make room.` }, 409);
  const d = parsed.data;
  const row: Row = { id: crypto.randomUUID(), ...d, created_at: Date.now() };
  await c.env.DB.prepare(
    "INSERT INTO user_apps (id, user_id, name, about, icon, tone, instructions, opener, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(row.id, c.var.userId, row.name, row.about, row.icon, row.tone, row.instructions, row.opener, row.created_at)
    .run();
  return c.json({ app: shape(row) });
});

myApps.delete("/apps/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM user_apps WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.var.userId).run();
  return c.json({ ok: true });
});
