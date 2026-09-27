// Invite a friend.
//
// An invite is a text the person sends from their own phone: "I use OVOA,
// text it at +1 512 555 0000 and say @tigh sent you". OVOA never texts the
// friend itself. When a number that isn't linked to anyone texts OVOA with
// "@tigh sent me" in it, that's remembered (one inviter per number, first one
// wins). If that number later links an account, the inviter hears "Jake
// joined from your invite", and the count shows in the app.
//
// Rewards for inviting (free days, a better plan) are the owner's call and
// aren't here: the count is what a reward would be built on.

import { Hono } from "hono";
import type { CallTool, ToolSpec } from "./llm";
import { reach, type Reach } from "./reach";
import type { Env, Vars } from "./types";

/** An account made up to a day before the "@x sent me" text still counts as new (signed up, then texted). */
const NEW_ACCOUNT_GRACE_MS = 86_400_000;

/** "@tigh sent me", "@tigh invited me", "from @tigh", "via @tigh": the username, lowercased. Pure. */
export function inviterIn(text: string): string | null {
  const m =
    /@([a-z0-9][a-z0-9-]{1,29})\s+(?:sent|invited|told|referred)\s+me\b/i.exec(text) ??
    /\b(?:from|via|invited by|sent by|referred by)\s+@([a-z0-9][a-z0-9-]{1,29})\b/i.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/** The words someone sends a friend, and a tap-to-text link that fills them in. Pure. */
export function inviteFor(line: string | undefined, username: string | null) {
  const hello = username ? `Hi OVOA, @${username} sent me` : "Hi OVOA";
  const number = line ?? "";
  return {
    number,
    text: number
      ? `I use OVOA, an assistant you just text. Try it: text ${number}${username ? ` and say "@${username} sent me"` : ""}.`
      : "I use OVOA, an assistant you just text. Get it at https://ovoa.ai",
    // iOS reads "&body=", Android "?body="; "?&body=" works on both.
    smsLink: number ? `sms:${number}?&body=${encodeURIComponent(hello)}` : null,
  };
}

/**
 * A stranger's text: if it names who sent them, remember it. Only for a number
 * that isn't linked and wasn't invited before, and never for inviting yourself.
 * Returns the inviter's name, or null. Never throws.
 */
export async function noteInvite(db: D1Database, phone: string, text: string, now = Date.now()): Promise<string | null> {
  try {
    const username = inviterIn(text);
    if (!username) return null;
    // Its holder now, or whoever gave it up (a friend may have an old invite).
    const inviter =
      (await db.prepare("SELECT id, name FROM users WHERE username = ?").bind(username).first<{ id: string; name: string | null }>()) ??
      (await db
        .prepare("SELECT u.id, u.name FROM usernames_history h JOIN users u ON u.id = h.user_id WHERE h.username = ?")
        .bind(username)
        .first<{ id: string; name: string | null }>());
    if (!inviter) return null;
    const linked = await db.prepare("SELECT user_id FROM text_links WHERE phone = ?").bind(phone).first<{ user_id: string }>();
    if (linked) return null;
    const done = await db
      .prepare("INSERT INTO invite_referrals (phone, inviter_id, invited_at) VALUES (?, ?, ?) ON CONFLICT(phone) DO NOTHING")
      .bind(phone, inviter.id, now)
      .run();
    return done.meta.changes ? (inviter.name?.split(" ")[0] ?? username) : null;
  } catch (err) {
    console.error("noteInvite failed", err);
    return null;
  }
}

/**
 * A number just linked an account: if someone invited it, they're told once.
 * Never throws.
 */
export async function inviteJoined(
  env: Env,
  phone: string,
  userId: string,
  now = Date.now(),
  tell: (env: Env, userId: string, r: Reach) => Promise<unknown> = reach,
): Promise<boolean> {
  try {
    // Only a new account counts: someone already on OVOA who unlinks and texts
    // "@x sent me" before linking again didn't join from an invite.
    const row = await env.DB
      .prepare(
        `UPDATE invite_referrals SET joined_user_id = ?1, joined_at = ?2
         WHERE phone = ?3 AND joined_at IS NULL AND inviter_id != ?1
           AND (SELECT created_at FROM users WHERE id = ?1) >= invited_at - ?4
         RETURNING inviter_id`,
      )
      .bind(userId, now, phone, NEW_ACCOUNT_GRACE_MS)
      .first<{ inviter_id: string }>();
    if (!row) return false;
    const who = await env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(userId).first<{ name: string | null }>();
    // Their name goes into a text OVOA sends, so only a first name's letters: never a sentence someone typed as a name.
    const first = (who?.name ?? "").trim().split(/\s+/)[0]!.replace(/[^\p{L}'-]/gu, "").slice(0, 20) || "A friend you invited";
    const line = `${first} just joined OVOA from your invite.`;
    await tell(env, row.inviter_id, { kind: "invite", text: line, push: { title: "Your invite worked", body: line } });
    return true;
  } catch (err) {
    console.error("inviteJoined failed", err);
    return false;
  }
}

async function counts(db: D1Database, userId: string) {
  const row = await db
    .prepare("SELECT COUNT(joined_at) AS joined, COUNT(*) - COUNT(joined_at) AS waiting FROM invite_referrals WHERE inviter_id = ?")
    .bind(userId)
    .first<{ joined: number; waiting: number }>();
  return { joined: row?.joined ?? 0, waiting: row?.waiting ?? 0 };
}

async function usernameOf(db: D1Database, userId: string) {
  return (await db.prepare("SELECT username FROM users WHERE id = ?").bind(userId).first<{ username: string | null }>())?.username ?? null;
}

const TOOLS: ToolSpec[] = [
  {
    name: "invite_friend",
    description:
      "The words and a tap-to-text link for inviting a friend to OVOA, with how many they've invited so far. They send it themselves (from their phone, or phone_message_compose); OVOA never texts the friend first.",
    parameters: { type: "object", properties: {} },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isInviteTool = (name: string) => NAMES.has(name);

export function invitesAssistant(env: Env, userId: string) {
  const callTool: CallTool = async (name) => {
    if (name !== "invite_friend") return { error: `Unknown tool ${name}` };
    const username = await usernameOf(env.DB, userId);
    return {
      ...inviteFor(env.SENDBLUE_NUMBER, username),
      ...(await counts(env.DB, userId)),
      ...(!username && { note: "They have no @username, so invites can't be credited to them. Offer to set one (username_set)." }),
    };
  };
  return {
    tools: TOOLS,
    callTool,
    prompt: "",
  };
}

export const inviteRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

inviteRoutes.get("/invites", async (c) => {
  const username = await usernameOf(c.env.DB, c.var.userId);
  return c.json({ ...inviteFor(c.env.SENDBLUE_NUMBER, username), username, ...(await counts(c.env.DB, c.var.userId)) });
});
