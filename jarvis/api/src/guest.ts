// Texts from a number no account is linked to: a free trial, no sign-up.
// The first FREE texts get real AI replies; then an automated (no AI) text
// asks for their email, which is worth FREE more; after that an automated
// text sends them to Base. The counts are per phone number.
import { noDashes } from "./sentences";
import { CONTACT_CARD_PATH } from "./contactcard";
import { generateText } from "./llm";
import { say } from "./obs";
import type { Env } from "./types";

export const FREE = 5;
const HISTORY_TURNS = 12;
const TELL_EVERY_MS = 6 * 3_600_000;
const SIGN_UP = "https://ovoa.ai/text";

type Row = { used: number; email: string | null; history: string };
export type Turn = { role: "user" | "model"; text: string };

export const ASK_EMAIL = `That was your ${FREE}th free text. Reply with your email and you'll get ${FREE} more, no account needed.`;
export const GOT_EMAIL = `Thanks! You've got ${FREE} more free texts. Go ahead.`;
export const CAPPED = `You've used your free texts. Get OVOA Base to keep texting me (I'll remember this chat): ${SIGN_UP}`;
export const BUSY = `I'm getting a ton of texts today, so free replies are paused till tomorrow. You can keep going with OVOA Base: ${SIGN_UP}`;

/**
 * AI replies the whole free trial may give in a UTC day, across every number.
 * Guest calls carry no account, so the model gate's plan and spend checks pass
 * them (plans.ts); this is their ceiling. GUEST_DAILY_REPLIES overrides it.
 */
export const GUEST_DAILY_DEFAULT = 2_000;
export const guestDailyLimit = (env: { GUEST_DAILY_REPLIES?: string }) => {
  const set = Number(env.GUEST_DAILY_REPLIES);
  return Number.isFinite(set) && set >= 0 ? Math.floor(set) : GUEST_DAILY_DEFAULT;
};

/** Takes one of today's trial replies. False when the day's are all used. */
async function takeDaily(db: D1Database, now: number, limit: number): Promise<boolean> {
  const day = new Date(now).toISOString().slice(0, 10);
  const row = await db
    .prepare(
      "INSERT INTO guest_daily (day, replies) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET replies = replies + 1 WHERE replies < ? RETURNING replies",
    )
    .bind(day, limit)
    .first<{ replies: number }>();
  return limit > 0 && row !== null;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
export const emailIn = (text: string) => text.match(EMAIL)?.[0]?.toLowerCase() ?? null;

export const limitFor = (row: { email: string | null }) => (row.email ? FREE * 2 : FREE);

async function load(db: D1Database, phone: string, now: number): Promise<Row> {
  await db
    .prepare("INSERT OR IGNORE INTO text_guests (phone, created_at, updated_at) VALUES (?, ?, ?)")
    .bind(phone, now, now)
    .run();
  return (await db.prepare("SELECT used, email, history FROM text_guests WHERE phone = ?").bind(phone).first<Row>())!;
}

const SYSTEM = [
  "You are OVOA, an AI assistant people text over iMessage. This person is trying you out: they have no account yet.",
  "Text like a real person, super chill and casual: short, warm, plain words, contractions, lowercase is fine if they write that way. One to three sentences unless they ask for more. No markdown. Never use em dashes; use commas or periods.",
  "Answer questions, help them think, draft things, explain things. You can't set reminders, read their accounts, or look things up live in this trial; if they ask for that, say it comes with an OVOA account.",
  "Don't mention limits or pricing unless asked.",
].join("\n");

/**
 * Deals with one text from a guest. `send` texts them. Returns the outcome
 * for logs. Never throws for a model failure: they get a plain sorry instead.
 */
export async function guestText(
  env: Env,
  phone: string,
  content: string,
  send: (text: string, media?: string) => Promise<boolean>,
  now = Date.now(),
  /** Writes the AI reply; tests stand in for the model here. */
  write: (turns: Turn[]) => Promise<string> = (turns) =>
    generateText(env, { model: env.CHAT_MODEL, usage: { userId: null, purpose: "guest text" }, system: SYSTEM, turns, fast: true }),
): Promise<string> {
  const db = env.DB;
  const row = await load(db, phone, now);
  const email = emailIn(content);

  if (email && !row.email) {
    await db.prepare("UPDATE text_guests SET email = ?, updated_at = ? WHERE phone = ?").bind(email, now, phone).run();
    say("text", { outcome: "guest email" });
    // Just the email: thank them. Anything more gets answered below.
    if (content.replace(EMAIL, "").trim().length < 3) {
      await send(row.used >= FREE * 2 ? CAPPED : GOT_EMAIL);
      return "guest email";
    }
    row.email = email;
  }

  // Take one of their free texts, atomically, so a burst can't overspend.
  const limit = limitFor(row);
  const took = await db
    .prepare("UPDATE text_guests SET used = used + 1, updated_at = ? WHERE phone = ? AND used < ?")
    .bind(now, phone, limit)
    .run();
  if (!took.meta.changes) {
    const tell = await db
      .prepare("UPDATE text_guests SET told_at = ? WHERE phone = ? AND (told_at IS NULL OR told_at < ?)")
      .bind(now, phone, now - TELL_EVERY_MS)
      .run();
    if (tell.meta.changes) await send(row.email ? CAPPED : ASK_EMAIL);
    return "guest capped";
  }
  const used = row.used + 1;

  // The whole trial's ceiling for the day. Over it, their text is given back.
  if (!(await takeDaily(db, now, guestDailyLimit(env)))) {
    await db.prepare("UPDATE text_guests SET used = used - 1 WHERE phone = ?").bind(phone).run();
    await send(BUSY);
    say("text", { outcome: "guest busy" });
    return "guest busy";
  }

  let history: Turn[] = [];
  try {
    history = JSON.parse(row.history) as Turn[];
  } catch {
    history = [];
  }
  const text = content.trim() || "(they sent something without words)";
  let reply: string;
  try {
    reply = noDashes((await write([...history, { role: "user", text }])).trim());
  } catch (err) {
    console.error("ovoa.err guest text", err);
    // Give the text back: it wasn't answered.
    await db.prepare("UPDATE text_guests SET used = used - 1 WHERE phone = ?").bind(phone).run();
    await send("Sorry, something went wrong on my side. Try again in a minute.");
    return "guest error";
  }
  if (!reply) reply = "Sorry, I didn't catch that. Could you say it another way?";
  const next = [...history, { role: "user", text }, { role: "model", text: reply }].slice(-HISTORY_TURNS);
  await db.prepare("UPDATE text_guests SET history = ? WHERE phone = ?").bind(JSON.stringify(next), phone).run();
  await send(reply);
  // Their first reply brings OVOA's contact card, so they can save it with its name and logo.
  if (used === 1) await send("OVOA", `https://api.ovoa.ai${CONTACT_CARD_PATH}`);

  if (used >= limit) {
    await db.prepare("UPDATE text_guests SET told_at = ? WHERE phone = ?").bind(now, phone).run();
    await send(row.email ? CAPPED : ASK_EMAIL);
  }
  say("text", { outcome: "guest reply", used });
  return "guest reply";
}
