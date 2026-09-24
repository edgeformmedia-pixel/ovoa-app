import { Hono } from "hono";
import { approveAction, type PendingAction } from "./google/assistant";
import { allowed, tooMany } from "./limits";
import type { CallTool, ToolSpec } from "./llm";
import { appFor, describeScreen, type MadeApp } from "./myapps";
import { recordError, say } from "./obs";
import { isPhoneTool } from "./phone";
import { push } from "./push";
import type { Env, Vars } from "./types";

// Texting OVOA over iMessage, through Sendblue (docs/texting.md).
//
// Someone texts OVOA's number the way they'd text a friend, and OVOA answers
// by text. It is the same OVOA as the app, not a second one: a text is a turn
// on their account (index.ts textTurn, which runs runTurn), so it reads and
// adds to the same conversation, the same memories, the same reminders, notes,
// lists, money and food, their Google account, and the apps they made. Only
// what has to happen on the iPhone itself (texting or calling someone, the
// iPhone's contacts, calendar and Reminders app, shortcuts) waits in the app,
// and the reply says so.
//
// Linking. A number belongs to an account once its owner proves both: the app
// (signed in) makes a code, and puts it in a text to OVOA's number for them to
// send (POST /texting/link). The text arrives from their number with the code
// in it, and the number is theirs. Codes are ten characters, single use, for
// fifteen minutes. A number nobody linked is told once a day how to link, and
// nothing it says goes anywhere near a model.
//
// Only iMessage. An SMS sender can be spoofed, and the replies go to the real
// number, so a spoofed one could make OVOA act without ever seeing why; an
// iMessage sender is Apple's. OVOA is an iPhone app, so everyone has iMessage.
//
// Order. Sendblue posts each text to the webhook (POST /texting/webhook), and
// may post the same one twice. Every text is written down once, by its
// message_handle, before anything is done with it. A linked person's texts
// then wait for their turn: the text that arrives last in a burst (a photo and
// its words come as two) answers the whole burst, in one reply, and while a
// reply is being written the next texts wait behind it (text_links.busy_until)
// and are answered together after it. So replies come one at a time and in
// order, each written with the one before it in the conversation.
//
// Time. Sendblue waits 45 seconds for the webhook, so it answers within 40,
// and the work goes on for the 30 seconds a Worker gets after that. A text
// that is still waiting after that (the reply before it took too long) is
// answered by the cron (textsTick), and one whose run died half way through is
// apologised for there.
//
// Approvals. What waits for approval in the app (sending an email, deleting,
// inviting) is approved by replying YES, or cancelled with NO (a thumbs up on
// the text counts). Anything else lets it go: the next request is the one
// that counts.

// ---------- Sendblue ----------

const API_BASE = "https://api.sendblue.co";
/** Sendblue takes messages under 18,996 characters. */
const SENDBLUE_MAX = 18_000;

/** Every secret texting needs is set (types.ts): without all four it is off. */
export function textingReady(env: Env) {
  return !!(env.SENDBLUE_API_KEY_ID && env.SENDBLUE_API_SECRET && env.SENDBLUE_NUMBER && env.SENDBLUE_WEBHOOK_SECRET);
}

/** What sends texts: Sendblue, from one of OVOA's numbers, or a capture for tests and /texting/try. */
export type Sender = {
  /** True when Sendblue took it. Never throws. */
  text: (to: string, content: string) => Promise<boolean>;
  /** The "…" bubble while a reply is written. Best effort. */
  typing: (to: string) => Promise<void>;
  /** The "Read" under their text. Best effort. */
  read: (to: string) => Promise<void>;
};

/** A number in a log line: never the whole of it. */
const tag = (phone: string) => `…${phone.slice(-2)}`;

/** Sendblue, sending from `line` (the number a text came in on) or OVOA's own number. */
export function sendblue(env: Env, line: string | null): Sender {
  const from = line && isE164(line) ? line : (env.SENDBLUE_NUMBER ?? "");
  const base = (env.SENDBLUE_API_BASE || API_BASE).replace(/\/+$/, "");
  const call = async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-api-key-id": env.SENDBLUE_API_KEY_ID ?? "",
        "sb-api-secret-key": env.SENDBLUE_API_SECRET ?? "",
      },
      body: JSON.stringify({ ...body, from_number: from }),
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Not JSON: the status says enough.
    }
    return { ok: res.ok, status: res.status, json, raw };
  };
  return {
    async text(to, content) {
      try {
        const r = await call("/api/send-message", { number: to, content: content.slice(0, SENDBLUE_MAX) });
        if (!r.ok || r.json?.status === "ERROR") {
          const why = String(r.json?.error_message ?? r.json?.message ?? r.raw).slice(0, 160);
          say("text", { outcome: "send failed", to: tag(to), status: r.status, why });
          return false;
        }
        return true;
      } catch (err) {
        say("text", { outcome: "send failed", to: tag(to), why: err instanceof Error ? err.name : "error" });
        return false;
      }
    },
    async typing(to) {
      await call("/api/send-typing-indicator", { number: to }).catch(() => null);
    },
    async read(to) {
      await call("/api/mark-read", { number: to }).catch(() => null);
    },
  };
}

/** A Sender that keeps what it would have sent: tests, and /texting/try. */
export function capture() {
  const sent: { to: string; content: string }[] = [];
  const sender: Sender = {
    text: async (to, content) => (sent.push({ to, content }), true),
    typing: async () => {},
    read: async () => {},
  };
  return { sent, sender };
}

// ---------- What came in ----------

export const isE164 = (v: string) => /^\+[1-9]\d{7,14}$/.test(v);
/** An iMessage sender: a phone number, or the Apple ID email some people send from. */
const isHandle = (v: string) => isE164(v) || /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(v);

/** The longest text kept, as the app's /chat keeps its messages. */
const MAX_TEXT = 8_000;

export type Inbound = {
  /** Sendblue's id for the text: the same text delivered twice has the same one. */
  handle: string;
  /** Who sent it. */
  from: string;
  /** The Sendblue number it came in on. */
  line: string | null;
  content: string;
  /** A photo, a voice note or a file came with it. */
  media: boolean;
  /** One OVOA sent, reported back. */
  outbound: boolean;
  /** Said in a group chat. */
  group: boolean;
  /** Came as SMS, not iMessage. */
  sms: boolean;
  /** They opted out of texts from this line (Sendblue). */
  optedOut: boolean;
};

/** A short, stable tag for a text Sendblue gave no id. */
function fnv(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Sendblue's receive webhook body, or null when it isn't a text from someone. Pure. */
export function parseInbound(raw: unknown): Inbound | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const from = str(b.from_number) || str(b.number);
  if (!isHandle(from)) return null;
  const content = typeof b.content === "string" ? b.content.replace(/\r\n?/g, "\n").trim().slice(0, MAX_TEXT) : "";
  const line = str(b.sendblue_number) || str(b.to_number);
  const participants = Array.isArray(b.participants) ? b.participants.length : 0;
  return {
    handle: str(b.message_handle).slice(0, 200) || `sb:${fnv(`${from}|${str(b.date_sent)}|${content}`)}`,
    from,
    line: isE164(line) ? line : null,
    content,
    media: str(b.media_url) !== "",
    outbound: b.is_outbound === true,
    group: str(b.group_id) !== "" || participants > 2 || str(b.message_type).toLowerCase() === "group",
    sms: str(b.service).toLowerCase() === "sms",
    optedOut: b.opted_out === true,
  };
}

// ---------- Link codes ----------

/** No 0/O or 1/I: a code is copied into a text, not read aloud, but it may be typed. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;
const CODE_TTL_MS = 15 * 60_000;
/**
 * A code, anywhere in a text: ten of the alphabet's characters on their own,
 * at least one a digit and one a letter, so no English word is ever mistaken
 * for one ("strengthen" has the letters, not the digit).
 */
const CODE_WORD = /\b(?=[A-HJ-NP-Z2-9]*[2-9])(?=[A-HJ-NP-Z2-9]*[A-HJ-NP-Z])[A-HJ-NP-Z2-9]{10}\b/gi;

/** A fresh code: 50 random bits, with a digit and a letter in it. 256 is a multiple of 32, so every character is equally likely. */
export function makeCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  for (;;) {
    const code = [...random(CODE_LENGTH)].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    if (/[2-9]/.test(code) && /[A-Z]/.test(code)) return code;
  }
}

/** The codes a text might carry, upper-cased, at most three. Pure. */
export function linkCodesIn(content: string) {
  return [...new Set((content.match(CODE_WORD) ?? []).map((c) => c.toUpperCase()))].slice(0, 3);
}

/** The text the app puts in Messages for them to send. */
export const linkText = (code: string) => `Link my OVOA account: ${code}`;

// ---------- Reactions and short answers ----------

/**
 * A tapback, as it reaches a number that isn't on iMessage's own side of the
 * conversation: `Loved “Done — 3pm tomorrow”`. Null for anything else. Pure.
 */
export function tapbackOf(content: string): { kind: string; quoted: string } | null {
  const m =
    /^(loved|liked|disliked|laughed at|emphasi[sz]ed|questioned|reacted\s+\S{1,16}\s+to|removed\s+an?\s+.{1,30}?\s+from)\s+[“"‘'](.*)[”"’']\s*$/isu.exec(
      content.trim(),
    );
  return m ? { kind: m[1].toLowerCase().split(/\s+/)[0], quoted: m[2] } : null;
}

/** A thumbs up or down on the text asking for a YES, as the YES or the NO. */
export function tapbackVerdict(t: { kind: string; quoted: string }): "yes" | "no" | null {
  if (!/reply yes/i.test(t.quoted)) return null;
  if (t.kind === "liked" || t.kind === "loved") return "yes";
  if (t.kind === "disliked") return "no";
  return null;
}

const YES = new Set([
  "y", "yes", "yeah", "yea", "yep", "yup", "ya", "ye", "yes please", "ok", "okay", "k", "kk", "sure",
  "do it", "go ahead", "go for it", "send it", "send", "approve", "approved", "confirm", "confirmed", "go", "👍", "✅",
]);
const NO = new Set([
  "n", "no", "nope", "nah", "no thanks", "no thank you", "cancel", "cancel it", "stop", "don't", "dont",
  "do not", "don't send it", "never mind", "nevermind", "nvm", "👎", "❌",
]);

/** A reply that is only a yes or only a no; anything more is a request of its own. Pure. */
export function yesOrNo(text: string): "yes" | "no" | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[.!,\s]+$/u, "")
    .replace(/\s+/g, " ");
  if (YES.has(t)) return "yes";
  if (NO.has(t)) return "no";
  return null;
}

// ---------- What goes out ----------

/**
 * A reply as a text: Markdown taken out, which Messages would show as
 * asterisks and hashes. The prompt asks for plain text; this is for when a
 * model forgets. Pure.
 */
export function plainText(reply: string) {
  return reply
    .replace(/\r\n?/g, "\n")
    .replace(/```[a-z]*\n?([\s\S]*?)```/gi, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label: string, url: string) => (label.trim() === url ? url : `${label} (${url})`))
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[\s(])\*(?=\S)([^*\n]+?)(?<=\S)\*(?=[\s).,!?:;]|$)/gm, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[*•]\s+/gm, "- ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const MAX_BUBBLES = 3;

/** A reply as the texts it goes out as: a blank line starts the next, three at most. Pure. */
export function bubbles(reply: string, max = MAX_BUBBLES) {
  const parts = plainText(reply)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= max) return parts;
  return [...parts.slice(0, max - 1), parts.slice(max - 1).join("\n\n")];
}

/** What a reply ends with when something it set up waits: a YES, or the app. Empty when nothing waits. Pure. */
export function waitingLine(pending: Pick<PendingAction, "summary" | "phone">[]) {
  const server = pending.filter((a) => !a.phone);
  const phone = pending.filter((a) => a.phone);
  const lines: string[] = [];
  if (server.length) lines.push(server.length === 1 ? "Reply YES to go ahead, or NO to cancel." : `Reply YES to do all ${server.length}, or NO to cancel.`);
  if (phone.length) {
    const what = phone.map((a) => a.summary.split("\n")[0]).join("; ");
    lines.push(`Waiting for you in the OVOA app: ${what}. Open it to finish.`);
  }
  return lines.join("\n");
}

/** Whether `given` is the webhook secret, in time that doesn't depend on where they differ. Pure. */
export function secretMatches(given: string | null | undefined, want: string | null | undefined) {
  if (!given || !want) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(want);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ---------- Links ----------

export type TextLink = {
  user_id: string;
  phone: string;
  linked_at: number;
  app_id: string | null;
  app_at: number | null;
  approvals: string | null;
  approvals_at: number | null;
  busy_until: number | null;
};

const LINK_COLUMNS = "user_id, phone, linked_at, app_id, app_at, approvals, approvals_at, busy_until";

export const linkByPhone = (db: D1Database, phone: string) =>
  db.prepare(`SELECT ${LINK_COLUMNS} FROM text_links WHERE phone = ?`).bind(phone).first<TextLink>();

export const linkOf = (db: D1Database, userId: string) =>
  db.prepare(`SELECT ${LINK_COLUMNS} FROM text_links WHERE user_id = ?`).bind(userId).first<TextLink>();

/** A new code for this account; any earlier one stops working. */
export async function issueLinkCode(db: D1Database, userId: string, now = Date.now()) {
  const code = makeCode();
  const expiresAt = now + CODE_TTL_MS;
  await db.batch([
    db.prepare("DELETE FROM text_link_codes WHERE user_id = ?").bind(userId),
    db.prepare("INSERT INTO text_link_codes (code, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(code, userId, now, expiresAt),
  ]);
  return { code, expiresAt };
}

/** Spends the first of these codes that is live, and links `phone` to its account. The account, or null. */
async function redeem(db: D1Database, codes: string[], phone: string, now: number) {
  for (const code of codes) {
    const row = await db
      .prepare("DELETE FROM text_link_codes WHERE code = ? AND expires_at > ? RETURNING user_id")
      .bind(code, now)
      .first<{ user_id: string }>();
    if (!row) continue;
    // One number, one account: a number linked elsewhere moves here, since the
    // same person just proved both.
    await db.batch([
      db.prepare("DELETE FROM text_links WHERE phone = ? AND user_id != ?").bind(phone, row.user_id),
      db
        .prepare(
          `INSERT INTO text_links (user_id, phone, linked_at) VALUES (?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET phone = excluded.phone, linked_at = excluded.linked_at,
               app_id = NULL, app_at = NULL, approvals = NULL, approvals_at = NULL`,
        )
        .bind(row.user_id, phone, now),
      db.prepare("DELETE FROM text_link_codes WHERE user_id = ?").bind(row.user_id),
    ]);
    return row.user_id;
  }
  return null;
}

export async function unlink(db: D1Database, userId: string) {
  await db.batch([
    db.prepare("DELETE FROM text_links WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM text_link_codes WHERE user_id = ?").bind(userId),
  ]);
}

// ---------- The inbox, and one reply at a time ----------

/** How long a text waits for the rest of its burst before it's answered. */
const DEBOUNCE_MS = 1_200;
/** The per-person lock: longer than any one reply takes. */
const LOCK_MS = 100_000;
/** Waiting this long with nobody answering it: the cron answers it. */
const SWEEP_AFTER_MS = 60_000;
/** Claimed this long ago and never answered: the run that claimed it died. */
const STUCK_MS = 5 * 60_000;

/** `seq`: the row's rowid, which is the order the texts were written down in: arrival order, even within a millisecond. */
type InboxRow = { seq: number; handle: string; phone: string; line: string | null; content: string; media: number; received_at: number };

/** Writes a text down, once. False when it was already there: a second delivery. */
async function record(db: D1Database, m: Inbound, status: string, userId: string | null, now: number) {
  const keep = !!userId;
  const { meta } = await db
    .prepare(
      `INSERT OR IGNORE INTO text_inbox (handle, user_id, phone, line, content, media, status, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(m.handle, userId, m.from, m.line, keep ? m.content : "", keep && m.media ? 1 : 0, status, now)
    .run();
  return (meta.changes ?? 0) > 0;
}

/** What was done with a text; its words go once it's done with. */
const settle = (db: D1Database, handle: string, status: string) =>
  db.prepare("UPDATE text_inbox SET status = ?, content = '' WHERE handle = ?").bind(status, handle).run();

async function finish(db: D1Database, handles: string[], status: "done" | "failed" | "ignored") {
  if (!handles.length) return;
  await db
    .prepare(`UPDATE text_inbox SET status = ?, content = '' WHERE handle IN (${handles.map(() => "?").join(",")})`)
    .bind(status, ...handles)
    .run();
}

async function takeLock(db: D1Database, userId: string, now = Date.now()) {
  const until = now + LOCK_MS;
  const { meta } = await db
    .prepare("UPDATE text_links SET busy_until = ? WHERE user_id = ? AND (busy_until IS NULL OR busy_until < ?)")
    .bind(until, userId, now)
    .run();
  return (meta.changes ?? 0) > 0 ? until : null;
}

/** Only the lock this run took: after LOCK_MS another run may hold a new one. */
const releaseLock = (db: D1Database, userId: string, until: number) =>
  db.prepare("UPDATE text_links SET busy_until = NULL WHERE user_id = ? AND busy_until = ?").bind(userId, until).run();

/** Every text of theirs that's waiting, in the order they came, now this run's to answer. */
async function claimWaiting(db: D1Database, userId: string, now = Date.now()) {
  const { results } = await db
    .prepare(
      `UPDATE text_inbox SET status = 'claimed', claimed_at = ?
        WHERE user_id = ? AND status = 'new'
        RETURNING rowid AS seq, handle, phone, line, content, media, received_at`,
    )
    .bind(now, userId)
    .all<InboxRow>();
  return results.sort((a, b) => a.seq - b.seq);
}

const anyWaiting = async (db: D1Database, userId: string) =>
  !!(await db.prepare("SELECT 1 AS x FROM text_inbox WHERE user_id = ? AND status = 'new' LIMIT 1").bind(userId).first());

/** A later text of theirs is waiting: its run answers this one with it. */
const newerWaiting = async (db: D1Database, userId: string, handle: string) =>
  !!(await db
    .prepare(
      `SELECT 1 AS x FROM text_inbox
        WHERE user_id = ? AND status = 'new' AND rowid > (SELECT rowid FROM text_inbox WHERE handle = ?) LIMIT 1`,
    )
    .bind(userId, handle)
    .first());

/** A burst of texts as one message to OVOA. Pure. */
export function combine(batch: Pick<InboxRow, "content" | "media">[]) {
  const words = batch
    .map((r) => r.content.trim())
    .filter(Boolean)
    .join("\n");
  if (!batch.some((r) => r.media)) return words;
  return words
    ? `${words}\n[They sent a photo or file with this. You can't open attachments over text yet; say so if it matters.]`
    : "[They sent a photo or file with no words. You can't open attachments over text yet: say so, and ask what they need.]";
}

// ---------- Approvals by text ----------

/** A YES waited for this long, and no longer. */
const APPROVAL_TTL_MS = 30 * 60_000;

/** The parked actions a YES would approve now. Pure. */
export function waitingApprovals(link: Pick<TextLink, "approvals" | "approvals_at">, now: number): string[] {
  if (!link.approvals || !link.approvals_at || link.approvals_at < now - APPROVAL_TTL_MS) return [];
  try {
    const ids = JSON.parse(link.approvals) as unknown;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string").slice(0, 10) : [];
  } catch {
    return [];
  }
}

const setApprovals = (db: D1Database, userId: string, ids: string[], now: number) =>
  db
    .prepare("UPDATE text_links SET approvals = ?, approvals_at = ? WHERE user_id = ?")
    .bind(ids.length ? JSON.stringify(ids) : null, ids.length ? now : null, userId)
    .run();

async function saveMessages(db: D1Database, userId: string, lines: { role: "user" | "assistant"; content: string }[]) {
  const now = Date.now();
  await db.batch(
    lines.map((l, i) =>
      db
        .prepare("INSERT INTO messages (id, user_id, role, content, created_at, source) VALUES (?, ?, ?, ?, ?, 'text')")
        .bind(crypto.randomUUID(), userId, l.role, l.content, now + i),
    ),
  );
}

/** YES: each waiting action carried out (google/assistant.ts approveAction), and how it went. */
async function approveAll(env: Env, userId: string, ids: string[], said: string) {
  const zone = await env.DB.prepare("SELECT time_zone FROM settings WHERE user_id = ?").bind(userId).first<{ time_zone: string | null }>();
  await saveMessages(env.DB, userId, [{ role: "user", content: said }]);
  const done: string[] = [];
  for (const id of ids) {
    // approveAction adds its own message to the conversation.
    const message = await approveAction(env, userId, id, { timeZone: zone?.time_zone ?? undefined, source: "text" });
    if (message) done.push(message.content);
  }
  if (done.length) return done.join("\n");
  const gone = "That had expired, so nothing was done. Ask me again and I'll set it up again.";
  await saveMessages(env.DB, userId, [{ role: "assistant", content: gone }]);
  return gone;
}

async function dropApprovals(db: D1Database, userId: string, ids: string[]) {
  if (!ids.length) return;
  await db.batch(ids.map((id) => db.prepare("DELETE FROM pending_actions WHERE id = ? AND user_id = ?").bind(id, userId)));
}

// ---------- The turn ----------

/** What index.ts textTurn is given: the words, and the link they came through. */
export type TextTurnInput = { userId: string; text: string; link: TextLink; requestId?: string };
/** Its answer: the reply, and what was set up that waits (for a YES, or in the app). */
export type TextTurnOutcome = { reply: string; pendingActions: PendingAction[] };
export type Waiter = Pick<ExecutionContext, "waitUntil">;
export type TextTurn = (env: Env, ctx: Waiter, input: TextTurnInput) => Promise<TextTurnOutcome>;

export type Deps = {
  turn: TextTurn;
  /** Who sends, from which line. */
  sender: (line: string | null) => Sender;
  requestId?: string;
  /** No new reply is started after this (ms since the epoch): what's left waits for the cron. */
  deadline: number;
  /** Tests and /texting/try: no waiting for the rest of a burst. */
  debounceMs?: number;
};

const TROUBLE = "Sorry, something went wrong on my side. Try again in a minute.";
const LOST = "Sorry, I lost track of your last text before I could answer it. Could you send it again?";

/**
 * Answers every text of theirs that's waiting, a burst at a time, until none
 * is. `handle`: the text this run came in with; it waits out the burst first,
 * and leaves the answering to a later text's run when there is one. Never throws.
 */
export async function processThread(env: Env, ctx: Waiter, userId: string, handle: string | null, deps: Deps) {
  const db = env.DB;
  try {
    if (handle) {
      await new Promise((r) => setTimeout(r, deps.debounceMs ?? DEBOUNCE_MS));
      if (await newerWaiting(db, userId, handle)) return;
    }
    for (;;) {
      // Held by a reply being written: that run looks again once it's sent.
      const lock = await takeLock(db, userId);
      if (!lock) return;
      try {
        const batch = await claimWaiting(db, userId);
        if (batch.length) await answer(env, ctx, userId, batch, deps);
      } finally {
        await releaseLock(db, userId, lock).catch((err) => console.error("ovoa.err text: couldn't release the lock", err));
      }
      // Anything that came in while it was held, this run answers too.
      if (!(await anyWaiting(db, userId))) return;
      if (Date.now() > deps.deadline) return;
    }
  } catch (err) {
    console.error("ovoa.err text: a thread failed", err);
    await recordError(env, {
      kind: "error",
      route: "text thread",
      requestId: deps.requestId,
      userId,
      ms: 0,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}

/** One burst of texts, answered. */
async function answer(env: Env, ctx: Waiter, userId: string, batch: InboxRow[], deps: Deps) {
  const db = env.DB;
  const handles = batch.map((r) => r.handle);
  const link = await linkOf(db, userId);
  // Unlinked since: nobody to answer them as.
  if (!link) return finish(db, handles, "ignored");
  const last = batch[batch.length - 1];
  const to = last.phone;
  const out = deps.sender(last.line);
  ctx.waitUntil(out.typing(to));
  const text = combine(batch);
  const now = Date.now();

  // A YES or a NO to what the last reply set up. Anything else lets it go.
  const waiting = waitingApprovals(link, now);
  if (link.approvals) await setApprovals(db, userId, [], now);
  if (waiting.length) {
    const verdict = yesOrNo(text);
    if (verdict === "yes") {
      await sendAll(out, to, [await approveAll(env, userId, waiting, text)]);
      return finish(db, handles, "done");
    }
    if (verdict === "no") {
      await dropApprovals(db, userId, waiting);
      const reply = "Okay, I've cancelled that.";
      await saveMessages(db, userId, [
        { role: "user", content: text },
        { role: "assistant", content: reply },
      ]);
      await sendAll(out, to, [reply]);
      return finish(db, handles, "done");
    }
    await dropApprovals(db, userId, waiting);
  }

  let outcome: TextTurnOutcome;
  const started = Date.now();
  try {
    outcome = await deps.turn(env, ctx, { userId, text, link, requestId: deps.requestId });
  } catch (err) {
    say("text", { outcome: "turn failed", user: userId, ms: Date.now() - started });
    console.error("ovoa.err text: turn failed", err);
    await recordError(env, {
      kind: "error",
      route: "text turn",
      requestId: deps.requestId,
      userId,
      ms: Date.now() - started,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    await out.text(to, TROUBLE);
    return finish(db, handles, "failed");
  }

  const server = outcome.pendingActions.filter((a) => !a.phone);
  const phone = outcome.pendingActions.filter((a) => a.phone);
  if (server.length) await setApprovals(db, userId, server.map((a) => a.id), Date.now());
  if (phone.length) {
    // A tap on it opens Talk, where it waits (app lib/agent.tsx).
    ctx.waitUntil(
      push(env, userId, {
        title: "Waiting in OVOA",
        body: `Tap to finish: ${phone.map((a) => a.summary.split("\n")[0]).join("; ")}`.slice(0, 180),
        data: { type: "approve" },
      }).then(
        () => {},
        () => {},
      ),
    );
  }
  const texts = bubbles(outcome.reply);
  const tail = waitingLine(outcome.pendingActions);
  if (tail) texts.push(tail);
  // A reply with nothing in it (the model only ran a tool) is still an answer.
  if (!texts.length) texts.push("Okay.");
  await sendAll(out, to, texts);
  // An app open in the conversation stays open for an hour after its last use.
  await db.prepare("UPDATE text_links SET app_at = ? WHERE user_id = ? AND app_id IS NOT NULL").bind(Date.now(), userId).run();
  say("text", { outcome: "answered", user: userId, texts: batch.length, bubbles: texts.length, ms: Date.now() - started });
  return finish(db, handles, "done");
}

/** In order, one after the other, so they arrive in order. */
async function sendAll(out: Sender, to: string, texts: string[]) {
  let sent = 0;
  for (const t of texts) if (await out.text(to, t)) sent++;
  return sent;
}

// ---------- A text arrives ----------

const APP_STRANGER = "Hi! This is OVOA. To text me, open the OVOA app, go to Settings, then Assistant, and tap Link my number.";
const SMS_ONLY =
  "I only answer iMessages, to keep your account safe. Turn on iMessage in your iPhone's Settings (Apps, then Messages) and text me again.";
const BAD_CODE = "That link code didn't work: it may have expired or been used already. In the OVOA app, tap Link my number again.";
/** How often a number that isn't linked (or sends SMS) is told what to do. */
const TOLD_EVERY_MS = 24 * 3_600_000;
const BAD_CODES_PER_HOUR = 5;

async function toldLately(db: D1Database, phone: string, status: string, since: number, handle: string) {
  return !!(await db
    .prepare("SELECT 1 AS x FROM text_inbox WHERE phone = ? AND status = ? AND received_at > ? AND handle != ? LIMIT 1")
    .bind(phone, status, since, handle)
    .first());
}

async function welcome(db: D1Database, userId: string) {
  const who = await db
    .prepare("SELECT u.name, s.assistant_name FROM users u LEFT JOIN settings s ON s.user_id = u.id WHERE u.id = ?")
    .bind(userId)
    .first<{ name: string | null; assistant_name: string | null }>();
  const first = (who?.name ?? "").trim().split(/\s+/)[0];
  const me = who?.assistant_name?.trim() || "OVOA";
  return [
    `You're linked${first ? `, ${first}` : ""}! This is ${me}: text me anytime, just like talking to me in the app.`,
    `I remember what we talk about there, and from here I can set reminders, keep your notes and lists, use your apps and your Google account, and look things up. Save this number as ${me} so it's easy to find.`,
  ];
}

/**
 * The webhook's work, and /texting/try's: decides what a text is, writes it
 * down once, and deals with it. A linked person's text comes back as `work`
 * (the reply, still being written), for the caller to keep alive.
 */
export async function receive(env: Env, ctx: Waiter, raw: unknown, deps: Deps): Promise<{ outcome: string; work?: Promise<void> }> {
  const m = parseInbound(raw);
  if (!m) return { outcome: "not a text" };
  if (m.outbound) return { outcome: "outbound" };
  // Never in a group: the others there never agreed to OVOA reading them.
  if (m.group) return { outcome: "group" };
  if (m.optedOut) return { outcome: "opted out" };
  const db = env.DB;
  const now = Date.now();
  const link = await linkByPhone(db, m.from);
  const codes = linkCodesIn(m.content);

  if (m.sms) {
    if (!(await record(db, m, "sms", null, now))) return { outcome: "duplicate" };
    if (!(await toldLately(db, m.from, "sms_told", now - TOLD_EVERY_MS, m.handle))) {
      await deps.sender(m.line).text(m.from, SMS_ONLY);
      await settle(db, m.handle, "sms_told");
    }
    return { outcome: "sms" };
  }

  if (codes.length) {
    // Kept with its words while it may still turn out to be an ordinary text of theirs.
    if (!(await record(db, m, "code", link?.user_id ?? null, now))) return { outcome: "duplicate" };
    const userId = await redeem(db, codes, m.from, now);
    if (userId) {
      await settle(db, m.handle, "linked");
      say("text", { outcome: "linked", user: userId, moved: link && link.user_id !== userId ? 1 : undefined });
      const out = deps.sender(m.line);
      for (const t of await welcome(db, userId)) await out.text(m.from, t);
      return { outcome: "linked" };
    }
    if (!link) {
      const since = now - 3_600_000;
      const { results } = await db
        .prepare("SELECT COUNT(*) AS n FROM text_inbox WHERE phone = ? AND status = 'bad_code' AND received_at > ?")
        .bind(m.from, since)
        .all<{ n: number }>();
      await settle(db, m.handle, "bad_code");
      if ((results[0]?.n ?? 0) < BAD_CODES_PER_HOUR) await deps.sender(m.line).text(m.from, BAD_CODE);
      return { outcome: "bad code" };
    }
    // Not a code after all: an ordinary text from someone linked.
    await db.prepare("UPDATE text_inbox SET status = 'new' WHERE handle = ?").bind(m.handle).run();
    return queue(env, ctx, m, link, now, deps);
  }

  if (!link) {
    if (!(await record(db, m, "stranger", null, now))) return { outcome: "duplicate" };
    if (!(await toldLately(db, m.from, "told", now - TOLD_EVERY_MS, m.handle))) {
      await deps.sender(m.line).text(m.from, APP_STRANGER);
      await settle(db, m.handle, "told");
    }
    return { outcome: "stranger" };
  }

  if (/^\s*unlink\W*$/i.test(m.content)) {
    if (!(await record(db, m, "unlinked", null, now))) return { outcome: "duplicate" };
    await unlink(db, link.user_id);
    say("text", { outcome: "unlinked by text", user: link.user_id });
    await deps.sender(m.line).text(m.from, "Unlinked: texts from this number won't reach your OVOA account any more. You can link it again in the app.");
    return { outcome: "unlinked" };
  }

  const tapback = tapbackOf(m.content);
  if (tapback) {
    // A thumbs up on "Reply YES" is the YES; any other reaction needs no answer.
    const verdict = waitingApprovals(link, now).length ? tapbackVerdict(tapback) : null;
    if (!verdict) {
      if (!(await record(db, m, "ignored", null, now))) return { outcome: "duplicate" };
      return { outcome: "reaction" };
    }
    return queue(env, ctx, { ...m, content: verdict }, link, now, deps, true);
  }

  if (!m.content && !m.media) {
    if (!(await record(db, m, "ignored", null, now))) return { outcome: "duplicate" };
    return { outcome: "empty" };
  }
  return queue(env, ctx, m, link, now, deps, true);
}

/** A linked person's text, into their inbox and on its way to an answer. */
async function queue(env: Env, ctx: Waiter, m: Inbound, link: TextLink, now: number, deps: Deps, write = false) {
  if (write && !(await record(env.DB, m, "new", link.user_id, now))) return { outcome: "duplicate" };
  const out = deps.sender(m.line);
  // Read, and the "…" while it waits for the rest of the burst and the reply.
  ctx.waitUntil(Promise.allSettled([out.read(m.from), out.typing(m.from)]));
  return { outcome: "queued", work: processThread(env, ctx, link.user_id, m.handle, deps) };
}

// ---------- The cron ----------

/** Collects what a turn leaves running (ctx.waitUntil), for a caller with no request to hang it on. */
function collector() {
  const work: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void work.push(p.catch(() => {})),
    settle: () => Promise.allSettled(work),
  };
}

/** How long the cron spends answering texts, at most, per tick. */
const SWEEP_BUDGET_MS = 4 * 60_000;

/**
 * Every two minutes (index.ts runTick): answers texts nobody is answering (the
 * run they came in with gave up while the reply before them was being written),
 * says sorry for ones a run claimed and then died on, and lets go of texts
 * from a number unlinked since.
 */
export async function textsTick(
  env: Env,
  turn: TextTurn,
  now = Date.now(),
  sender: (line: string | null) => Sender = (line) => sendblue(env, line),
) {
  if (!textingReady(env)) return {};
  const db = env.DB;
  await db
    .prepare(
      "UPDATE text_inbox SET status = 'ignored', content = '' WHERE status = 'new' AND user_id IS NOT NULL AND user_id NOT IN (SELECT user_id FROM text_links)",
    )
    .run();
  const { results: stuck } = await db
    .prepare(
      "UPDATE text_inbox SET status = 'failed', content = '' WHERE status = 'claimed' AND claimed_at < ? RETURNING user_id, phone, line",
    )
    .bind(now - STUCK_MS)
    .all<{ user_id: string | null; phone: string; line: string | null }>();
  const sorry = new Set<string>();
  for (const r of stuck) {
    if (!r.user_id || sorry.has(r.user_id)) continue;
    sorry.add(r.user_id);
    await sender(r.line).text(r.phone, LOST);
  }
  const { results: waiting } = await db
    .prepare("SELECT DISTINCT user_id FROM text_inbox WHERE status = 'new' AND user_id IS NOT NULL AND received_at < ? LIMIT 20")
    .bind(now - SWEEP_AFTER_MS)
    .all<{ user_id: string }>();
  const waiter = collector();
  const deps: Deps = { turn, sender, deadline: Date.now() + SWEEP_BUDGET_MS };
  let answered = 0;
  for (const w of waiting) {
    if (Date.now() > deps.deadline) break;
    await processThread(env, waiter, w.user_id, null, deps);
    answered++;
  }
  await waiter.settle();
  return { lost: sorry.size, answered };
}

// ---------- In the turn: their apps, and what waits ----------

/** Hands a channel's tools a way to change the turn they're running in (index.ts runTurn). */
export type ChannelHooks = {
  /** From now until the end of the turn this app is open: its app_update tool, as if it had been open from the start. */
  openApp: (app: MadeApp) => void;
};

/** A way in other than the app (texting is the one): what it adds to a turn (index.ts runTurn). */
export type TurnChannel = {
  /** messages.source for what the turn saves. */
  source: string;
  /** Its section of the system prompt. */
  prompt: string;
  /** Tools only it has, carried on every turn. */
  tools: ToolSpec[];
  isTool: (name: string) => boolean;
  callTool: CallTool;
  /** A tool's result, reworded for someone who isn't looking at the app. */
  adjust: (name: string, result: unknown) => unknown;
};

/** An app left open this long without a text closes itself. */
const APP_IDLE_MS = 60 * 60_000;

/** The app open in the text conversation now, if any. Pure. */
export function openAppId(link: Pick<TextLink, "app_id" | "app_at"> | null, now = Date.now()) {
  return link?.app_id && (link.app_at ?? 0) > now - APP_IDLE_MS ? link.app_id : null;
}

export type AppName = { id: string; name: string; about: string };

/** Their apps, newest first: the names the prompt carries. */
export async function appsOf(db: D1Database, userId: string) {
  const { results } = await db
    .prepare("SELECT id, name, about FROM user_apps WHERE user_id = ? ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 30")
    .bind(userId)
    .all<AppName>();
  return results;
}

const MY_APPS: ToolSpec = {
  name: "my_apps",
  description: "The apps they made in OVOA, each with what it does, and which one is open in this conversation.",
  parameters: { type: "object", properties: {}, required: [] },
};

const APP_OPEN: ToolSpec = {
  name: "app_open",
  description:
    "Open one of their apps in this text conversation, as opening it in the OVOA app would: until it's closed, their texts go to that app and you follow its instructions. Use it when they ask to open or use one of their apps. Returns its instructions and screen.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "The app's name, as they said it" } },
    required: ["name"],
  },
};

const APP_CLOSE: ToolSpec = {
  name: "app_close",
  description: "Close the app that's open in this text conversation, when they're done with it or ask for something it isn't for.",
  parameters: { type: "object", properties: {}, required: [] },
};

const CHANNEL_TOOLS = new Set([MY_APPS.name, APP_OPEN.name, APP_CLOSE.name]);

const near = (a: string, b: string) => {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

/** An app by what they called it: its name exactly, then near enough ("my grocery app" for "Grocery Helper"). Pure. */
export function findApp<A extends { name: string }>(apps: A[], said: string) {
  const exact = said.trim().toLowerCase();
  if (!exact) return undefined;
  const bare = exact.replace(/^(my|the|our)\s+/, "").replace(/\s+app$/, "").trim();
  return (
    apps.find((a) => a.name.toLowerCase() === exact) ??
    apps.find((a) => a.name.toLowerCase() === bare) ??
    (bare ? apps.find((a) => near(a.name, bare)) : undefined)
  );
}

const WAITING_IN_APP = {
  status: "waiting_in_the_ovoa_app",
  note: "It has NOT happened yet: it runs on their iPhone, so it waits in the OVOA app until they open it. Never say it was sent, texted, called or done. Say it's waiting in OVOA, in a few words (\"Your text to Sam is waiting in OVOA.\"); a line telling them to open OVOA is added to your text for you.",
};

/**
 * What a text turn adds (index.ts textTurn): how to write for Messages, what
 * can't be done from here, their apps, and results reworded for someone who
 * isn't looking at the app. `apps`: their apps' names; `open`: the one open
 * in the conversation now.
 */
export function textChannel(env: Env, userId: string, timeZone: string, apps: AppName[], open: MadeApp | null, hooks: ChannelHooks): TurnChannel {
  let current = open;
  const callTool: CallTool = async (name, args) => {
    if (name === MY_APPS.name) {
      return { apps: apps.map((a) => ({ name: a.name, about: a.about })), open: current?.name ?? null };
    }
    if (name === APP_OPEN.name) {
      const found = findApp(apps, String(args.name ?? ""));
      if (!found) {
        return { error: `No app of theirs is called "${String(args.name ?? "")}". Their apps: ${apps.map((a) => a.name).join(", ") || "none yet"}.` };
      }
      const app = await appFor(env.DB, userId, found.id);
      if (!app) return { error: "That app has been deleted." };
      await env.DB.prepare("UPDATE text_links SET app_id = ?, app_at = ? WHERE user_id = ?").bind(app.id, Date.now(), userId).run();
      hooks.openApp(app);
      current = app;
      return {
        opened: app.name,
        note: "Open now: their texts go to this app until app_close, or an hour without a text. Follow its instructions from now on, this reply included, and stay yourself while doing it. Change what's on its screen with app_update, and never say something is done unless a tool did it.",
        instructions: app.instructions,
        ...(app.opener && { opener: app.opener }),
        screen: describeScreen(app, timeZone) || "Its screen is empty.",
      };
    }
    if (name === APP_CLOSE.name) {
      await env.DB.prepare("UPDATE text_links SET app_id = NULL, app_at = NULL WHERE user_id = ?").bind(userId).run();
      const was = current?.name ?? null;
      current = null;
      return was ? { closed: was } : { closed: null, note: "No app was open." };
    }
    return { error: `Unknown tool ${name}` };
  };

  const adjust = (name: string, result: unknown) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) return result;
    const { status, note: _note, ...rest } = result as Record<string, unknown>;
    if (isPhoneTool(name) && (status === "waiting_for_user_approval" || status === "running_on_phone")) return { ...rest, ...WAITING_IN_APP };
    if (status === "waiting_for_user_approval") {
      return {
        ...rest,
        status: "waiting_for_their_yes",
        note: "It has NOT happened yet, so never say it was sent or done. Over text they approve it by replying YES; that line is added to your text for you. Say in a few words what's ready (\"Your email to Sam is ready.\"), and don't mention an Approve button.",
      };
    }
    return result;
  };

  const prompt = [
    "They're texting you from Messages on their iPhone (iMessage), not using the OVOA app. It's the same conversation as the app, with the same memories, lists, notes, reminders and tools.",
    "Write like a text message: short and plain, no Markdown, headings or asterisks. A blank line starts a new text bubble; use one to three. Links are fine: they can tap them.",
    "From here you can't reach the iPhone itself: its contacts, calendar, Reminders app or location. Anything that has to run on the iPhone (texting or calling someone, the iPhone's contacts, calendar or Reminders app, a shortcut) waits in the OVOA app until they open it; say that in a few words. Everything else works from here: OVOA's own reminders and alarms (reminder_set, alarm_set), notes, lists, routines, money, food, Google and web search.",
    "Things that need their OK (sending an email, deleting something, inviting people) are approved by text: they reply YES. A line saying so is added to your text for you.",
    apps.length
      ? `Their own apps, made in OVOA: ${apps.map((a) => `"${a.name}"`).join(", ")}. my_apps says what each does; app_open opens one in this conversation, as opening it in the app would, and app_close closes it.`
      : "They haven't made any apps in OVOA yet; they make them in the app, under Apps.",
    open ? `"${open.name}" is open in this conversation. Close it with app_close when they're done with it or ask for something it isn't for.` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    source: "text",
    prompt,
    tools: apps.length ? [MY_APPS, APP_OPEN, APP_CLOSE] : [],
    isTool: (name) => CHANNEL_TOOLS.has(name),
    callTool,
    adjust,
  };
}

// ---------- Routes ----------

/** The webhook waits this long for the reply before answering Sendblue, which gives up at 45 s. */
const HOLD_MS = 40_000;
/** Then the work has what a Worker gets after its answer (waitUntil). */
const AFTER_MS = 30_000;
/** A new reply only starts with this long left; the cron answers what can't. */
const REPLY_ROOM_MS = 25_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/**
 * POST /texting/webhook: every text to OVOA's number, from Sendblue. Public:
 * the secret Sendblue sends back (sb-signing-secret) is the proof. Answers
 * 503 while texting is off (Sendblue retries, and never drops the webhook as
 * it would for a 410), 401 for a wrong secret, and otherwise 200, once the
 * reply has gone or 40 seconds have. A failure before the text is written down
 * is a 500, so Sendblue sends it again; after, the text is answered here or
 * by the cron, never twice.
 */
export function textingWebhook(turn: TextTurn) {
  const routes = new Hono<{ Bindings: Env; Variables: Vars }>();
  routes.post("/texting/webhook", async (c) => {
    const env = c.env;
    if (!textingReady(env)) {
      say("text", { outcome: "webhook while off" });
      return c.json({ error: "Texting isn't set up" }, 503);
    }
    if (!secretMatches(c.req.header("sb-signing-secret"), env.SENDBLUE_WEBHOOK_SECRET)) {
      say("text", { outcome: "wrong secret" });
      return c.json({ error: "Not from Sendblue" }, 401);
    }
    const raw = await c.req.json().catch(() => null);
    if (raw === null) return c.json({ error: "Expected JSON" }, 400);
    const started = Date.now();
    const got = await receive(env, c.executionCtx, raw, {
      turn,
      sender: (line) => sendblue(env, line),
      requestId: c.var.requestId,
      deadline: started + HOLD_MS + AFTER_MS - REPLY_ROOM_MS,
    });
    if (got.outcome !== "queued") say("text", { outcome: got.outcome, rid: c.var.requestId });
    if (got.work) {
      c.executionCtx.waitUntil(got.work);
      await Promise.race([got.work, sleep(HOLD_MS - (Date.now() - started))]);
    }
    return c.json({ ok: true });
  });
  return routes;
}

/**
 * The app's side, signed in: whether texting is on and to which number
 * (GET /texting), a code to link a number with (POST /texting/link), and
 * unlinking (DELETE /texting/link). None of them calls a model. And
 * POST /texting/try: a text as if sent from their linked number, answered
 * here instead of by text, for the probes (scripts/texting-probe.mjs).
 */
export function textingRoutes(turn: TextTurn) {
  const routes = new Hono<{ Bindings: Env; Variables: Vars }>();

  routes.get("/texting", async (c) => {
    const link = await linkOf(c.env.DB, c.var.userId);
    const on = textingReady(c.env);
    return c.json({
      available: on,
      number: on ? (c.env.SENDBLUE_NUMBER ?? null) : null,
      linked: link ? { phone: link.phone, linkedAt: link.linked_at } : null,
    });
  });

  routes.post("/texting/link", async (c) => {
    if (!textingReady(c.env)) return c.json({ error: "Texting OVOA isn't switched on yet." }, 503);
    if (!(await allowed(c.env, "RL_AUTH", `textlink:${c.var.userId}`))) return tooMany(c, "link codes");
    const { code, expiresAt } = await issueLinkCode(c.env.DB, c.var.userId);
    return c.json({ code, number: c.env.SENDBLUE_NUMBER, body: linkText(code), expiresAt });
  });

  routes.delete("/texting/link", async (c) => {
    await unlink(c.env.DB, c.var.userId);
    return c.json({ ok: true });
  });

  routes.post("/texting/try", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message.trim().slice(0, MAX_TEXT) : "";
    if (!message) return c.json({ error: "Message is required" }, 400);
    const link = await linkOf(c.env.DB, c.var.userId);
    if (!link) return c.json({ error: "Link a number first" }, 409);
    const { sent, sender } = capture();
    const m: Inbound = {
      handle: `try:${crypto.randomUUID()}`,
      from: link.phone,
      line: null,
      content: message,
      media: false,
      outbound: false,
      group: false,
      sms: false,
      optedOut: false,
    };
    const deps: Deps = { turn, sender: () => sender, requestId: c.var.requestId, deadline: Date.now() + 60_000, debounceMs: 0 };
    // Straight to the turn: never a link code, an unlink or a reaction, whatever it says.
    const got = await queue(c.env, c.executionCtx, m, link, Date.now(), deps, true);
    if (got.work) await got.work;
    return c.json({ outcome: got.outcome, texts: sent.map((s) => s.content) });
  });

  return routes;
}
