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

// ---------- Pacing (2026-09-26) ----------
//
// Not messaging too much is most of sounding like a person. An assistant that
// asks something every few hours gets muted; the one people keep asks once a
// day at most, and when they don't answer, waits: a day, then three, then a
// week (Instinct's rhythm, as the user described it). Their reply, in the app
// or by text, starts it over.
//
// Three kinds of text OVOA sends first:
//   their own:  what they set up and wait for (a reminder, a routine's check-in,
//               "leave now", meeting prep) and anything they asked for: never held.
//   asks:       OVOA wanting something of them (a question, a nudge about a
//               promise, a follow-up, "different day?"): one a day at most, and
//               backing off while they don't answer.
//   news:       everything else (the brief, the wind-down, what background
//               work found): three a day at most, and fewer once they've gone
//               quiet altogether.
// What's held isn't sent at all, not even as a notification: it's in the app.

/** Kinds that are theirs: they set these up, and they're on time or they're useless. */
const THEIRS = new Set(["reminder", "routine", "commute", "prep"]);
/** Kinds that ask something of them. */
const ASKS = new Set(["followup", "oddity", "note:question", "note:nudge"]);
/** News texts in any 24 hours. */
export const NEWS_PER_DAY = 3;
/** How long an ask waits after unanswered ones: one, two, three or more since their last word. */
const ASK_BACKOFF_MS = [0, 20 * 3_600_000, 3 * DAY_MS, 7 * DAY_MS];

export type PaceState = {
  /** When they last said anything to OVOA, in the app or by text. */
  lastWordAt: number | null;
  /** Asks sent since then, and when the last of them went. */
  asksSince: number;
  lastAskAt: number | null;
  /** News sent since then, and when the last went. */
  newsSince: number;
  lastNewsAt: number | null;
  /** In the last day. */
  newsToday: number;
};

/** Which group a kind is in (THEIRS, ASKS, news). Pure. */
export function paceGroup(kind: string): "theirs" | "ask" | "news" {
  return THEIRS.has(kind) ? "theirs" : ASKS.has(kind) ? "ask" : "news";
}

/**
 * Whether a text sent first goes now or is held. `asked`: they asked for it
 * and are waiting (a website that's ready). Pure.
 */
export function paceVerdict(kind: string, asked: boolean, s: PaceState, now: number): "send" | "hold" {
  const group = paceGroup(kind);
  if (asked || group === "theirs") return "send";
  if (group === "ask") {
    const wait = ASK_BACKOFF_MS[Math.min(s.asksSince, ASK_BACKOFF_MS.length - 1)];
    return s.lastAskAt !== null && now - s.lastAskAt < Math.max(wait, 20 * 3_600_000) ? "hold" : "send";
  }
  if (s.newsToday >= NEWS_PER_DAY) return "hold";
  // Quiet for a week and not answering: news every three days; three weeks: every week.
  const quietFor = s.lastWordAt === null ? Infinity : now - s.lastWordAt;
  const gap = quietFor > 21 * DAY_MS ? 7 * DAY_MS : quietFor > 7 * DAY_MS ? 3 * DAY_MS : 0;
  return gap && s.newsSince >= 2 && s.lastNewsAt !== null && now - s.lastNewsAt < gap ? "hold" : "send";
}

/** Where things stand with them, from the conversation and the outbox. */
export async function paceState(db: D1Database, userId: string, now: number): Promise<PaceState> {
  const word = await db
    .prepare("SELECT MAX(created_at) AS at FROM messages WHERE user_id = ? AND role = 'user'")
    .bind(userId)
    .first<{ at: number | null }>();
  const lastWordAt = word?.at ?? null;
  const { results } = await db
    .prepare("SELECT kind, sent_at FROM text_outbox WHERE user_id = ? AND ok = 1 AND kind NOT LIKE 'asked:%' AND sent_at > ? ORDER BY sent_at")
    .bind(userId, now - 30 * DAY_MS)
    .all<{ kind: string; sent_at: number }>();
  const since = results.filter((r) => lastWordAt === null || r.sent_at > lastWordAt);
  const asks = since.filter((r) => paceGroup(r.kind) === "ask");
  const news = since.filter((r) => paceGroup(r.kind) === "news");
  return {
    lastWordAt,
    asksSince: asks.length,
    lastAskAt: results.filter((r) => paceGroup(r.kind) === "ask").at(-1)?.sent_at ?? null,
    newsSince: news.length,
    lastNewsAt: news.at(-1)?.sent_at ?? null,
    newsToday: results.filter((r) => paceGroup(r.kind) === "news" && r.sent_at > now - DAY_MS).length,
  };
}

/**
 * Tells them, by text when they text OVOA and by notification otherwise. Never
 * throws. "text": it went by text and is in the conversation; "push": it went
 * as a notification (which may have reached no phone, as ever).
 */
export async function reach(env: Env, userId: string, r: Reach, io: ReachIo = {}): Promise<"text" | "push" | "held"> {
  const now = io.now ?? Date.now();
  const notify = async () => {
    await (io.push ?? push)(env, userId, r.push).catch((err) => console.error("reach: push failed", err));
    return "push" as const;
  };
  try {
    if (!textingReady(env)) return notify();
    const link = await linkOf(env.DB, userId);
    if (!link || link.proactive === 0) return notify();
    // Paced like a person (paceVerdict): held ones wait in the app, with no notification either.
    if (paceVerdict(r.kind, !!r.asked, await paceState(env.DB, userId, now), now) === "hold") {
      say("text", { outcome: "first: held for pacing", user: userId, kind: r.kind });
      return "held";
    }
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
