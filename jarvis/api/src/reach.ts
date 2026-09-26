import { say } from "./obs";
import { push, type PushMessage } from "./push";
import { bubbles, linkOf, sendblue, setApprovals, textingReady, waitingLine, type Sender } from "./texting";
import type { Env } from "./types";

// OVOA reaching someone on its own: Instinct's half of texting (2026-09-26).
//
// Everything OVOA says without being asked (the morning brief, a reminder, a
// routine's check-in, what background work found, a website that's ready, a
// message from a website's contact form) used to be a notification. For
// someone who texts OVOA it's a text now, in the conversation they already
// have with it: they answer by replying, and it's saved there like any other
// message, so the reply is read with it ("yes send it", "done", "move it to 4").
//
// A notification is still the way when they haven't linked a number, turned
// texting first off (texting.ts texting_first, PUT /texting), or have had
// today's share of texts; when Sendblue won't take it; and for everything only
// the phone can do (alarms, the band, a card with buttons), which never comes
// here at all. The callers keep their silent pushes (the band's buzz, the
// phone speaking): this only replaces the visible notification.

/** Texts sent first in any 24 hours, at most. Past it they're notifications again: a phone that buzzes all day gets muted. */
export const TEXTS_FIRST_PER_DAY = 12;
/** A YES to something proposed in a text sent first waits this long; one to a reply waits half an hour (texting.ts). */
export const FIRST_APPROVAL_TTL_MS = 12 * 3_600_000;
const DAY_MS = 86_400_000;

export type Reach = {
  /** What it is, for the outbox and the log: brief, reminder, routine, note, site, lead… */
  kind: string;
  /** What's texted: plain words, a blank line between bubbles. */
  text: string;
  /** The notification sent instead, when it isn't texted. */
  push: PushMessage;
  /** Parked actions (pending_actions ids) a YES carries out: the text ends by asking for one. */
  approvals?: string[];
  /** Something they asked for and are waiting on (their website is ready): outside the day's cap. */
  asked?: boolean;
};

/** Tests pass their own sender and push. */
export type ReachIo = { sender?: Sender; push?: (env: Env, userId: string, message: PushMessage) => Promise<number>; now?: number };

/** Texts sent first in the last day, not counting the ones they asked for. */
async function sentLately(db: D1Database, userId: string, now: number) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM text_outbox WHERE user_id = ? AND ok = 1 AND sent_at > ? AND kind NOT LIKE 'asked:%'")
    .bind(userId, now - DAY_MS)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Tells them, by text when they text OVOA and by notification otherwise. Never
 * throws. "text": it went by text and is in the conversation; "push": it went
 * as a notification (which may have reached no phone, as ever).
 */
export async function reach(env: Env, userId: string, r: Reach, io: ReachIo = {}): Promise<"text" | "push"> {
  const now = io.now ?? Date.now();
  const notify = async () => {
    await (io.push ?? push)(env, userId, r.push).catch((err) => console.error("reach: push failed", err));
    return "push" as const;
  };
  try {
    if (!textingReady(env)) return notify();
    const link = await linkOf(env.DB, userId);
    if (!link || link.proactive === 0) return notify();
    if (!r.asked && (await sentLately(env.DB, userId, now)) >= TEXTS_FIRST_PER_DAY) {
      say("text", { outcome: "first: over the day's texts", user: userId, kind: r.kind });
      return notify();
    }
    const texts = bubbles(r.text);
    if (!texts.length) return notify();
    const approvals = (r.approvals ?? []).filter(Boolean);
    if (approvals.length) texts.push(waitingLine(approvals.map(() => ({ summary: "" }))));
    const out = io.sender ?? sendblue(env, null);
    let sent = 0;
    for (const t of texts) {
      if (!(await out.text(link.phone, t))) break;
      sent++;
    }
    await env.DB.prepare("INSERT INTO text_outbox (id, user_id, kind, sent_at, ok) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), userId, `${r.asked ? "asked:" : ""}${r.kind}`.slice(0, 40), now, sent ? 1 : 0)
      .run();
    // Nothing got through: the notification, so it isn't lost.
    if (!sent) return notify();
    // Into the conversation, as a reply of OVOA's would be, so their answer is read with it.
    await env.DB.prepare("INSERT INTO messages (id, user_id, role, content, created_at, source) VALUES (?, ?, 'assistant', ?, ?, 'text')")
      .bind(crypto.randomUUID(), userId, texts.slice(0, sent).join("\n\n"), now)
      .run();
    if (approvals.length && sent === texts.length) await setApprovals(env.DB, userId, approvals, now, FIRST_APPROVAL_TTL_MS);
    say("text", { outcome: "sent first", user: userId, kind: r.kind, bubbles: sent });
    return "text";
  } catch (err) {
    console.error("ovoa.err reach: couldn't text; notifying instead", err);
    return notify();
  }
}
