// The four words a texting line has to understand on their own: STOP, START,
// HELP and CARD, each only as the whole message. Anything longer is an ordinary
// text for the model ("stop texting me first" is texting.ts textingFirstSaid,
// "help me plan dinner" is a request).
//
// STOP puts the number on the do-not-contact list: OVOA never texts it first
// (reach.ts) and no campaign reaches it. They can still text OVOA and be
// answered; texting OVOA is them reaching out. START takes them off. A bare
// "stop" while an approval is waiting stays the NO it always was (texting.ts),
// so the caller checks that first.

import { CONTACT_CARD_PATH } from "./contactcard";
import { endInboundFor } from "./inbound";
import type { Env } from "./types";

export type Keyword = "stop" | "start" | "help" | "card";

const WORDS: Record<string, Keyword> = {
  stop: "stop",
  stopall: "stop",
  unsubscribe: "stop",
  start: "start",
  unstop: "start",
  help: "help",
  info: "help",
  card: "card",
  contact: "card",
  "contact card": "card",
};

/** The keyword a whole message is, or null. Case, spaces and end punctuation don't matter. Pure. */
export function keywordOf(text: string): Keyword | null {
  const t = text
    .toLowerCase()
    .replace(/[.!\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return WORDS[t] ?? null;
}

export const KEYWORD_REPLIES = {
  stopLinked: "Got it, I won't text you first anymore. You can still text me anytime. Reply START to undo.",
  stopGuest: "Got it, you won't hear from OVOA unless you text first. Reply START to undo.",
  startLinked: "You're back on. I'll text you first again when something's worth it.",
  startGuest: "You're back on.",
  help:
    "I'm OVOA, an AI assistant you can just text. Ask me anything or tell me what to handle. Reply CARD to save my contact, STOP to stop me texting you first. More at ovoa.ai",
  card: "Here's my card, tap it to save me.",
} as const;

export async function onDoNotContact(db: D1Database, phone: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 AS x FROM do_not_contact WHERE phone = ?").bind(phone).first());
}

type Out = { text: (to: string, content: string, media?: string) => Promise<boolean> };

/**
 * Asks Sendblue to show OVOA's name and photo in their Messages, natively
 * (contact sharing: docs.sendblue.com/api-v2/contact-sharing). Only when
 * SENDBLUE_CONTACT_SHARING is "1": the profile (name and photo) is set once by
 * the owner in Sendblue first. Only works in a 1:1 iMessage chat that exists,
 * which a keyword reply always is. Best effort; the vCard already covers it.
 */
export async function shareContact(env: Env, to: string, line: string | null): Promise<boolean> {
  if (env.SENDBLUE_CONTACT_SHARING !== "1") return false;
  const base = (env.SENDBLUE_API_BASE || "https://api.sendblue.co").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/v2/contact-sharing/share`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-api-key-id": env.SENDBLUE_API_KEY_ID ?? "",
        "sb-api-secret-key": env.SENDBLUE_API_SECRET ?? "",
      },
      body: JSON.stringify({ fromNumber: line || env.SENDBLUE_NUMBER || "", toNumber: to }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Does what a keyword asks and answers it. `userId`: the account linked to the number, if any. */
export async function answerKeyword(
  env: Env,
  keyword: Keyword,
  phone: string,
  userId: string | null,
  out: Out,
  line: string | null,
  now = Date.now(),
): Promise<void> {
  const db = env.DB;
  if (keyword === "stop") {
    await db
      .prepare("INSERT INTO do_not_contact (phone, reason, created_at) VALUES (?, 'texted STOP', ?) ON CONFLICT(phone) DO NOTHING")
      .bind(phone, now)
      .run();
    if (userId) await db.prepare("UPDATE text_links SET proactive = 0 WHERE user_id = ?").bind(userId).run();
    // No more questions from a creator's text-in code either (inbound.ts).
    await endInboundFor(db, phone, now);
    await out.text(phone, userId ? KEYWORD_REPLIES.stopLinked : KEYWORD_REPLIES.stopGuest);
    return;
  }
  if (keyword === "start") {
    await db.prepare("DELETE FROM do_not_contact WHERE phone = ?").bind(phone).run();
    if (userId) await db.prepare("UPDATE text_links SET proactive = 1 WHERE user_id = ?").bind(userId).run();
    await out.text(phone, userId ? KEYWORD_REPLIES.startLinked : KEYWORD_REPLIES.startGuest);
    return;
  }
  if (keyword === "help") {
    await out.text(phone, KEYWORD_REPLIES.help);
    return;
  }
  await out.text(phone, KEYWORD_REPLIES.card);
  await out.text(phone, "OVOA", `https://api.ovoa.ai${CONTACT_CARD_PATH}`);
  await shareContact(env, phone, line);
}
