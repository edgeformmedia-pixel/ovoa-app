import { Hono } from "hono";
import { z } from "zod";
import type { CallTool, ToolSpec } from "./llm";
import { say } from "./obs";
import { labelTaken, siteDomain, slugify, slugProblem, USERNAME_HELD_DAYS } from "./sites";
import type { Env, Vars } from "./types";

// Usernames (2026-09-26, docs/ovoa-network.md): @thomas.
//
// One name that is three things: how other people's OVOAs find yours ("connect
// with @maria", network.ts), the address of their websites (thomas.ovoa.ai,
// with each project in a folder under it, sites.ts), and the page that lists
// them. Because it's a host under ovoa.ai, it's in one namespace with the flat
// website names from before (tonys-pizza.ovoa.ai) and follows their rules:
// none of OVOA's own names, nothing that looks like a brand or a sign-in page
// (sites.ts slugProblem), and nobody else's name, current or given up in the
// last 90 days (sites.ts labelTaken).
//
// Picked in the conversation (username_set, suggested from their name and
// confirmed before it's claimed) or in the app (Settings, Account). It can
// change once every 30 days; the old one sends its visitors on for 90.

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
/** A username can change once in this many days. */
export const CHANGE_EVERY_DAYS = 30;
const DAY_MS = 86_400_000;

/** Why a name can't be a username, or null when it can. Pure. */
export function usernameProblem(name: string): string | null {
  if (name.length < USERNAME_MIN) return `A username needs at least ${USERNAME_MIN} letters or digits.`;
  if (name.length > USERNAME_MAX) return `A username can be at most ${USERNAME_MAX} characters.`;
  if (!/^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/.test(name)) {
    return "A username can only have lowercase letters, digits and single hyphens, and can't start or end with a hyphen.";
  }
  return slugProblem(name)?.replace("An address", "A username") ?? null;
}

/** "@Thomas.L " as "thomas-l": what they typed or said, as a username to check. Pure. */
export const usernameFrom = (said: string) => slugify(said.trim().replace(/^@+/, "")).slice(0, USERNAME_MAX).replace(/-+$/, "");

/** Usernames to offer, best first, from a person's name: thomas, thomas-lancheros, thomasl, tlancheros. Pure. */
export function usernameIdeas(name: string) {
  const parts = slugify(name).split("-").filter(Boolean);
  if (!parts.length) return [];
  const [first, ...rest] = parts;
  const last = rest.at(-1);
  const ideas = [first, ...(last ? [`${first}-${last}`, `${first}${last[0]}`, `${first[0]}${last}`, `${first}${last}`] : [])];
  return [...new Set(ideas)].filter((n) => !usernameProblem(n));
}

/** The first username free for them from their name, or with a digit after it; null when there's nothing to go on. */
export async function suggestUsername(db: D1Database, name: string, userId?: string) {
  const ideas = usernameIdeas(name);
  for (const idea of ideas) if (!(await labelTaken(db, idea, userId))) return idea;
  const base = ideas[0];
  if (!base) return null;
  for (let i = 2; i <= 99; i++) {
    const next = `${base.slice(0, USERNAME_MAX - 3)}${i}`;
    if (!usernameProblem(next) && !(await labelTaken(db, next, userId))) return next;
  }
  return null;
}

type Mine = { username: string | null; username_at: number | null; name: string };
const mine = (db: D1Database, userId: string) =>
  db.prepare("SELECT username, username_at, name FROM users WHERE id = ?").bind(userId).first<Mine>();

/** When they may change it next: 30 days after the last change (the first pick doesn't count). */
export const changeableAt = (m: Pick<Mine, "username" | "username_at">) =>
  m.username && m.username_at ? m.username_at + CHANGE_EVERY_DAYS * DAY_MS : null;

/** Why they can't have `name`, in a sentence, or null when it's theirs to take. */
export async function claimProblem(db: D1Database, userId: string, name: string) {
  const problem = usernameProblem(name);
  if (problem) return problem;
  const taken = await labelTaken(db, name, userId);
  if (taken === "site") return `${name} is already a website's address, so it can't be a username.`;
  if (taken) return `@${name} is taken.`;
  return null;
}

/**
 * Sets their username, or changes it: the name checked, the old one held for
 * them (and redirecting) for 90 days, and their projects moved with it
 * (sites.slug is "<username>/<project>"). What went wrong, in a sentence, or
 * the name they have now.
 */
export async function claimUsername(db: D1Database, userId: string, wanted: string, now = Date.now()): Promise<{ username: string } | { error: string }> {
  const name = usernameFrom(wanted);
  const me = await mine(db, userId);
  if (!me) return { error: "No such account." };
  if (me.username === name) return { username: name };
  const problem = await claimProblem(db, userId, name);
  if (problem) return { error: problem };
  const next = changeableAt(me);
  if (next && next > now) {
    return { error: `A username can change once every ${CHANGE_EVERY_DAYS} days: @${me.username} can change on ${new Date(next).toISOString().slice(0, 10)}.` };
  }
  const old = me.username;
  try {
    await db.batch([
      db.prepare("UPDATE users SET username = ?, username_at = ? WHERE id = ?").bind(name, now, userId),
      // Taking back a name of their own that was being held.
      db.prepare("DELETE FROM usernames_history WHERE username = ? AND user_id = ?").bind(name, userId),
      ...(old
        ? [
            db.prepare("INSERT OR REPLACE INTO usernames_history (username, user_id, released_at) VALUES (?, ?, ?)").bind(old, userId, now),
            db
              .prepare("UPDATE sites SET slug = ? || '/' || path, owner_username = ? WHERE user_id = ? AND owner_username = ? AND path IS NOT NULL")
              .bind(name, name, userId, old),
          ]
        : []),
    ]);
  } catch (err) {
    // The unique index: someone took it between the check and now.
    if (/unique/i.test(String(err))) return { error: `@${name} is taken.` };
    throw err;
  }
  say("username", { outcome: old ? "changed" : "set", user: userId });
  return { username: name };
}

// ---------- In conversation ----------

function specs(domain: string): ToolSpec[] {
  return [
    {
      name: "username_get",
      description: `Their OVOA username (@name), which is also the address of their websites (<name>.${domain}) and how other people's OVOAs find theirs. Also says when it can next change.`,
      parameters: { type: "object", properties: {} },
    },
    {
      name: "username_set",
      description:
        "Picks their username the first time. Without a username it suggests one from their name; with one it checks it. It's only claimed with confirm: true, after they've said yes to that exact name.",
      parameters: {
        type: "object",
        properties: {
          username: { type: "string", description: "The username they want, without the @. Leave out to get a suggestion." },
          confirm: { type: "boolean", description: "true only once they've agreed to this exact username" },
        },
      },
    },
    {
      name: "username_change",
      description: `Changes their username (at most once every ${CHANGE_EVERY_DAYS} days). Their websites move with it, and the old address sends visitors on for ${USERNAME_HELD_DAYS} days. Only with confirm: true, after they've agreed to the new name.`,
      parameters: {
        type: "object",
        properties: {
          username: { type: "string", description: "The new username, without the @" },
          confirm: { type: "boolean", description: "true only once they've agreed to this exact username" },
        },
        required: ["username"],
      },
    },
  ];
}

const NAMES = new Set(specs("x").map((t) => t.name));
export const isUsernameTool = (name: string) => NAMES.has(name);

export function usernameAssistant(env: Env, userId: string) {
  const db = env.DB;
  const domain = siteDomain(env);

  const callTool: CallTool = async (name, args) => {
    const me = await mine(db, userId);
    if (!me) return { error: "No such account." };
    if (name === "username_get") {
      if (!me.username) {
        const suggestion = await suggestUsername(db, me.name, userId);
        return { username: null, ...(suggestion && { suggestion }), note: "They don't have one yet. Offer the suggestion if it comes up; set it with username_set once they agree." };
      }
      const next = changeableAt(me);
      return {
        username: `@${me.username}`,
        address: `${me.username}.${domain}`,
        ...(next && next > Date.now() && { canChangeOn: new Date(next).toISOString().slice(0, 10) }),
      };
    }
    if (name === "username_set" || name === "username_change") {
      if (name === "username_set" && me.username) return { error: `They already have @${me.username}. To change it, use username_change.` };
      if (name === "username_change" && !me.username) return { error: "They don't have a username yet: use username_set." };
      const said = String(args.username ?? "").trim();
      const wanted = said ? usernameFrom(said) : await suggestUsername(db, me.name, userId);
      if (!wanted) return { error: "Ask them what username they'd like." };
      const problem = wanted === me.username ? null : await claimProblem(db, userId, wanted);
      if (problem) {
        const other = await suggestUsername(db, `${wanted} ${me.name}`, userId);
        return { error: problem, ...(other && { suggestion: other }), note: "Say why in a few words and offer the suggestion, or ask for another." };
      }
      if (args.confirm !== true) {
        return {
          available: `@${wanted}`,
          address: `${wanted}.${domain}`,
          note: `@${wanted} is free. Ask them to confirm it (their websites will be at ${wanted}.${domain}/…), then call ${name} again with confirm: true. Don't claim it yet.`,
        };
      }
      const got = await claimUsername(db, userId, wanted);
      if ("error" in got) return got;
      return {
        username: `@${got.username}`,
        address: `${got.username}.${domain}`,
        ...(me.username && { note: `Their websites moved to ${got.username}.${domain}; ${me.username}.${domain} sends visitors there for ${USERNAME_HELD_DAYS} days.` }),
      };
    }
    return { error: `Unknown tool ${name}` };
  };

  return {
    tools: specs(domain),
    callTool,
    prompt: `Their username (@name) is also their websites' address (<name>.${domain}) and how other people's OVOAs find theirs. Suggest one from their name when they need one (a first website, a first connection), and claim it only after they've said yes to that exact name.`,
  };
}

// ---------- Routes ----------

/** The app's side: their username, whether one is free (as they type), and setting or changing it. No model. */
export const usernameRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

usernameRoutes.get("/me/username", async (c) => {
  const me = await mine(c.env.DB, c.var.userId);
  if (!me) return c.json({ error: "No such account" }, 404);
  const next = changeableAt(me);
  return c.json({
    username: me.username,
    address: me.username ? `${me.username}.${siteDomain(c.env)}` : null,
    changeableAt: next && next > Date.now() ? next : null,
    suggestion: me.username ? null : await suggestUsername(c.env.DB, me.name, c.var.userId),
  });
});

usernameRoutes.get("/me/username/check", async (c) => {
  const name = usernameFrom(c.req.query("name") ?? "");
  const problem = name ? await claimProblem(c.env.DB, c.var.userId, name) : "Type a username.";
  return c.json({ username: name, available: !problem, ...(problem && { problem }) });
});

const usernameBody = z.object({ username: z.string().min(1).max(60) });

usernameRoutes.put("/me/username", async (c) => {
  const parsed = usernameBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "username is needed" }, 400);
  const got = await claimUsername(c.env.DB, c.var.userId, parsed.data.username);
  if ("error" in got) return c.json(got, 409);
  const me = await mine(c.env.DB, c.var.userId);
  return c.json({ username: got.username, address: `${got.username}.${siteDomain(c.env)}`, changeableAt: me ? changeableAt(me) : null });
});
