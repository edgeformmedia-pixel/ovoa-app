import { Hono } from "hono";
import { logAction } from "./actionlog";
import { scheduleNudges } from "./agent";
import { resolveDue } from "./context";
import type { CallTool, ToolSpec } from "./llm";
import { push } from "./push";
import { buckets, clock } from "./time";
import type { Env, Vars } from "./types";

// Social memory (F14-F17). See migrations/0023_people.sql.
//
// Most of this is fed by the transcripts: when a five-minute block is titled,
// the same model call also says who came up and what was learned about them,
// what anyone asked the user to do, and what the user was called. digestBlock
// takes that and files it. The rest is said outright, through the tools.

/** Favors this sure are kept; between the two floors, the user is asked first; below, dropped. */
export const FAVOR_KEEP = 0.8;
export const FAVOR_ASK = 0.5;
/** A new name the user answers to, heard this often, is worth asking about. */
const NAME_ASK_AFTER = 2;
const MAX_FACTS = 40;

export type Extracted = {
  people?: { name?: string; facts?: string[] }[];
  favors?: { who?: string; what?: string; quote?: string; due?: string; confidence?: number }[];
  calledUser?: string[];
};

type PersonRow = { id: string; name: string; aliases: string; facts: string; relation: string | null; birthday: string | null; last_seen: number | null };

const list = <T>(json: string | null, fallback: T[] = []): T[] => {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9' ]+/g, "");

export async function findPerson(db: D1Database, userId: string, name: string) {
  const want = norm(name);
  if (!want) return null;
  const { results } = await db.prepare("SELECT * FROM people WHERE user_id = ?").bind(userId).all<PersonRow>();
  return (
    results.find((p) => norm(p.name) === want || list<string>(p.aliases).some((a) => norm(a) === want)) ??
    // "Jake" finds "Jake Miller"; not the other way round, so two Jakes stay two.
    results.find((p) => norm(p.name).split(" ")[0] === want) ??
    null
  );
}

export async function rememberPerson(
  db: D1Database,
  userId: string,
  name: string,
  facts: string[],
  from: "said" | "heard",
  extra: { relation?: string | null; birthday?: string | null } = {},
) {
  const clean = name.trim().slice(0, 60);
  if (!clean) return null;
  const now = Date.now();
  const found = await findPerson(db, userId, clean);
  const newFacts = facts.map((f) => f.trim().slice(0, 200)).filter(Boolean).map((fact) => ({ fact, at: now, from }));
  if (!found) {
    const id = crypto.randomUUID();
    await db
      .prepare("INSERT INTO people (id, user_id, name, facts, relation, birthday, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, userId, clean, JSON.stringify(newFacts), extra.relation ?? null, extra.birthday ?? null, now, now)
      .run();
    return id;
  }
  const known = list<{ fact: string; at: number; from: string }>(found.facts);
  const seen = new Set(known.map((f) => norm(f.fact)));
  const merged = [...known, ...newFacts.filter((f) => !seen.has(norm(f.fact)))].slice(-MAX_FACTS);
  await db
    .prepare("UPDATE people SET facts = ?, relation = COALESCE(?, relation), birthday = COALESCE(?, birthday), last_seen = ? WHERE id = ?")
    .bind(JSON.stringify(merged), extra.relation ?? null, extra.birthday ?? null, now, found.id)
    .run();
  return found.id;
}

/**
 * Files what the titling pass pulled out of one five-minute block: people and
 * facts, favors asked of the user, and names the user was called.
 */
export async function digestBlock(env: Env, userId: string, blockId: string | null, found: Extracted, timeZone: string) {
  const db = env.DB;
  for (const p of (found.people ?? []).slice(0, 8)) {
    if (p.name) await rememberPerson(db, userId, p.name, (p.facts ?? []).slice(0, 5), "heard");
  }

  const kept: { id: string; text: string; quote: string | null; dueAt: number | null }[] = [];
  for (const f of (found.favors ?? []).slice(0, 5)) {
    const confidence = Math.max(0, Math.min(1, Number(f.confidence) || 0));
    const what = String(f.what ?? "").trim().slice(0, 300);
    if (!what || confidence < FAVOR_ASK || !blockId) continue;
    // The same favor heard twice (a late line re-titles the block) is kept once.
    const dup = await db
      .prepare("SELECT 1 FROM context_commitments WHERE user_id = ? AND lower(text) = lower(?) AND created_at > ?")
      .bind(userId, what, Date.now() - 3 * 86_400_000)
      .first();
    if (dup) continue;
    const id = crypto.randomUUID();
    const who = String(f.who ?? "").trim().slice(0, 60) || null;
    const dueAt = resolveDue(f.due, timeZone);
    await db
      .prepare(
        `INSERT INTO context_commitments (id, user_id, block_id, text, quote, who, due_hint, due_at, status, confidence, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 'favor', ?)`,
      )
      .bind(id, userId, blockId, what, f.quote?.slice(0, 300) ?? null, who, f.due ?? null, dueAt, confidence, Date.now())
      .run();
    if (confidence >= FAVOR_KEEP) {
      kept.push({ id, text: what, quote: f.quote ?? null, dueAt });
      await logAction(db, userId, "favor_caught", `${who ?? "Someone"} asked: ${what}`, "system", id);
    } else {
      await push(env, userId, {
        title: "Did someone ask you something?",
        body: `${who ?? "Someone"} might have asked you to ${what}. Open OVOA to keep or drop it.`.slice(0, 180),
        data: { type: "favor-question", commitmentId: id },
      });
    }
  }
  if (kept.length) await scheduleNudges(env, userId, kept).catch(() => 0);

  for (const raw of (found.calledUser ?? []).slice(0, 3)) {
    const name = raw.trim().slice(0, 30);
    if (!name) continue;
    const known = await db.prepare("SELECT u.name, p.nicknames FROM users u LEFT JOIN profile p ON p.user_id = u.id WHERE u.id = ?")
      .bind(userId)
      .first<{ name: string; nicknames: string | null }>();
    const names = [known?.name ?? "", ...list<string>(known?.nicknames ?? null)].map(norm);
    if (names.some((n) => n === norm(name) || n.split(" ")[0] === norm(name))) continue;
    const row = await db
      .prepare(
        `INSERT INTO name_candidates (user_id, name, count) VALUES (?, ?, 1)
         ON CONFLICT(user_id, name) DO UPDATE SET count = count + 1 RETURNING count, asked_at`,
      )
      .bind(userId, name)
      .first<{ count: number; asked_at: number | null }>();
    if (row && row.count >= NAME_ASK_AFTER && !row.asked_at) {
      await db.prepare("UPDATE name_candidates SET asked_at = ? WHERE user_id = ? AND name = ?").bind(Date.now(), userId, name).run();
      await push(env, userId, {
        title: `Should I answer to "${name}"?`,
        body: `People seem to call you ${name}. Tell OVOA "yes, add ${name} as a nickname" and it'll know it's you.`,
        data: { type: "name-question", name },
      });
    }
  }
}

// ---------- Objects ----------

export async function saveObject(db: D1Database, userId: string, name: string, where: string, spot?: { lat: number; lng: number; placeId?: string | null }) {
  await db
    .prepare("INSERT INTO objects (id, user_id, name, location_text, place_id, lat, lng, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, name.trim().toLowerCase().slice(0, 60), where.trim().slice(0, 200), spot?.placeId ?? null, spot?.lat ?? null, spot?.lng ?? null, Date.now())
    .run();
}

export async function findObject(db: D1Database, userId: string, name: string) {
  const want = name.trim().toLowerCase().replace(/^(my|the)\s+/, "");
  return db
    .prepare("SELECT name, location_text, lat, lng, ts FROM objects WHERE user_id = ? AND (name = ? OR name LIKE ?) ORDER BY ts DESC LIMIT 1")
    .bind(userId, want, `%${want}%`)
    .first<{ name: string; location_text: string; lat: number | null; lng: number | null; ts: number }>();
}

// ---------- Routes ----------

export const people = new Hono<{ Bindings: Env; Variables: Vars }>();

people.get("/people", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM people WHERE user_id = ? ORDER BY last_seen DESC LIMIT 200").bind(c.var.userId).all<PersonRow>();
  return c.json({ people: results.map((p) => ({ ...p, aliases: list(p.aliases), facts: list(p.facts) })) });
});

people.delete("/people/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM people WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.var.userId).run();
  return c.json({ ok: true });
});

/** "Yes, they did ask me that": a favor below the keep line becomes a real one. */
people.post("/favors/:id/confirm", async (c) => {
  const row = await c.env.DB.prepare(
    "UPDATE context_commitments SET confidence = 1 WHERE id = ? AND user_id = ? AND origin = 'favor' RETURNING text, quote, due_at",
  )
    .bind(c.req.param("id"), c.var.userId)
    .first<{ text: string; quote: string | null; due_at: number | null }>();
  if (!row) return c.json({ error: "No such favor" }, 404);
  await scheduleNudges(c.env, c.var.userId, [{ id: c.req.param("id"), text: row.text, quote: row.quote, dueAt: row.due_at }]).catch(() => 0);
  return c.json({ ok: true });
});

people.get("/favors", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, text, quote, who, due_at, status, confidence, created_at FROM context_commitments
      WHERE user_id = ? AND origin = 'favor' AND status = 'open' ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(c.var.userId)
    .all();
  return c.json({ favors: results });
});

// ---------- In conversation ----------

const TOOLS: ToolSpec[] = [
  {
    name: "person_lookup",
    description:
      "Everything OVOA knows about someone: facts learned from conversations or told directly, what they asked the user for, and recent mentions. For 'what do I know about Jake', 'when's Sarah's birthday', 'what did Mum want'.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "person_remember",
    description: "Keeps a fact about someone the user mentions: 'Jake's birthday is March 3rd', 'Sarah's allergic to nuts', 'Tom is my manager'.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        fact: { type: "string" },
        relation: { type: "string", description: "How they're related to the user, if said: brother, manager, friend…" },
        birthday: { type: "string", description: "MM-DD or YYYY-MM-DD, if the fact is a birthday." },
      },
      required: ["name", "fact"],
    },
  },
  {
    name: "favor_done",
    description: "Marks something someone asked of the user as done or not needed ('I sent Sarah the deck'). Get the id from person_lookup or context_commitments.",
    parameters: { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["done", "dropped"] } }, required: ["id"] },
  },
  {
    name: "object_save",
    description: "Remembers where they put something: 'my keys are in the kitchen drawer', 'I parked on level 3'.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "The thing, short: keys, passport, car." }, where: { type: "string" } },
      required: ["name", "where"],
    },
  },
  {
    name: "object_find",
    description: "Where they last said something was: 'where did I put my passport', 'where's the car'.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isPeopleTool = (name: string) => NAMES.has(name);

export function peopleAssistant(env: Env, userId: string, timeZone: string) {
  const db = env.DB;
  const callTool: CallTool = async (name, args) => {
    if (name === "person_lookup") {
      const who = String(args.name ?? "").trim();
      if (!who) return { error: "name is required" };
      const p = await findPerson(db, userId, who);
      const [asked, heard] = await Promise.all([
        db
          .prepare(
            "SELECT id, text, quote, status, due_at, created_at FROM context_commitments WHERE user_id = ? AND lower(who) LIKE ? ORDER BY created_at DESC LIMIT 8",
          )
          .bind(userId, `%${who.toLowerCase()}%`)
          .all<{ id: string; text: string; quote: string | null; status: string; due_at: number | null; created_at: number }>(),
        db
          .prepare("SELECT ts, text FROM raw_captures WHERE user_id = ? AND lower(text) LIKE ? ORDER BY ts DESC LIMIT 5")
          .bind(userId, `%${who.toLowerCase()}%`)
          .all<{ ts: number; text: string }>(),
      ]);
      if (!p && !asked.results.length && !heard.results.length) return { known: false, note: `Nothing known about ${who} yet.` };
      return {
        name: p?.name ?? who,
        ...(p?.relation && { relation: p.relation }),
        ...(p?.birthday && { birthday: p.birthday }),
        facts: p ? list<{ fact: string }>(p.facts).map((f) => f.fact) : [],
        asked: asked.results.map((a) => ({ id: a.id, what: a.text, status: a.status, ...(a.quote && { theirWords: a.quote }) })),
        recentMentions: heard.results.map((h) => `${buckets(h.ts, timeZone).day} ${clock(h.ts, timeZone)}: ${h.text.slice(0, 200)}`),
      };
    }
    if (name === "person_remember") {
      const who = String(args.name ?? "").trim();
      const fact = String(args.fact ?? "").trim();
      if (!who || !fact) return { error: "name and fact are required" };
      await rememberPerson(db, userId, who, [fact], "said", {
        relation: args.relation ? String(args.relation).slice(0, 40) : null,
        birthday: args.birthday ? String(args.birthday).slice(0, 10) : null,
      });
      return { saved: true };
    }
    if (name === "favor_done") {
      const status = args.status === "dropped" ? "dropped" : "done";
      const { meta } = await db.prepare("UPDATE context_commitments SET status = ? WHERE id = ? AND user_id = ?").bind(status, String(args.id ?? ""), userId).run();
      if (!meta.changes) return { error: "No such request" };
      await db.prepare("DELETE FROM agent_jobs WHERE user_id = ? AND about = ? AND status != 'done'").bind(userId, String(args.id)).run();
      return { status };
    }
    if (name === "object_save") {
      const what = String(args.name ?? "").trim();
      const where = String(args.where ?? "").trim();
      if (!what || !where) return { error: "name and where are required" };
      await saveObject(db, userId, what, where);
      return { saved: true };
    }
    if (name === "object_find") {
      const found = await findObject(db, userId, String(args.name ?? ""));
      if (!found) return { found: false, note: "They haven't said where that is." };
      return {
        where: found.location_text,
        said: `${buckets(found.ts, timeZone).day} ${clock(found.ts, timeZone)}`,
        ...(found.lat != null && { map: `https://maps.apple.com/?ll=${found.lat},${found.lng}` }),
      };
    }
    return { error: `Unknown tool ${name}` };
  };
  return {
    tools: TOOLS,
    callTool,
    prompt:
      "OVOA remembers people (facts from conversations and what they're told), what people asked the user to do, and where the user put things. Use person_lookup before answering about someone; keep new facts with person_remember; object_save and object_find for things.",
  };
}
