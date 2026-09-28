// Texts from a number no account is linked to: a free trial, no sign-up.
// The first FREE texts get real AI replies; then an automated (no AI) text
// asks for their email, which is worth FREE more; after that an automated
// text sends them to Base. The counts are per phone number.
//
// An email that already has an OVOA account doesn't make the texts that
// account's: anyone could text anyone's address. OVOA emails that address a
// link code instead, with a one-tap link that puts it in a text to OVOA, and
// the text from this number is what links it (texting.ts redeem), exactly as
// the app's Link my number does. After that their texts are their account's,
// on their plan.
import { noDashes } from "./sentences";
import { CONTACT_CARD_PATH } from "./contactcard";
import { emailConfigured, esc, sendEmail, type Email } from "./emailauth";
import { generateText } from "./llm";
import { say } from "./obs";
import { issueLinkCode, linkText } from "./texting";
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

export const LINK_EMAILED = (email: string) =>
  `That email has an OVOA account. I just emailed ${email} a link: tap it on this phone and send the text it opens, and your texts go to your account and your plan.`;
export const LINK_IN_APP =
  "That email has an OVOA account. To text me as you, open the OVOA app, go to Settings, and tap Link my number under Text OVOA.";
/** One link email per account in this long, however many times the address is texted. */
const LINK_EMAIL_EVERY_MS = 10 * 60_000;

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

  // Their account's email, given now or before: the way to link, not more trial.
  const account = await accountFor(db, email ?? row.email);
  if (account && (email || row.used >= limitFor(row))) {
    if (email && !row.email) await db.prepare("UPDATE text_guests SET email = ?, updated_at = ? WHERE phone = ?").bind(email, now, phone).run();
    await send(await offerLink(env, account, now));
    say("text", { outcome: "guest has an account", user: account.id });
    return "guest has an account";
  }

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

type Account = { id: string; email: string; name: string | null };

const accountFor = (db: D1Database, email: string | null) =>
  email
    ? db.prepare("SELECT id, email, name FROM users WHERE lower(email) = ?").bind(email.toLowerCase()).first<Account>()
    : Promise.resolve(null);

/** Emails the account a link code (at most once in LINK_EMAIL_EVERY_MS). The text to send the guest. */
async function offerLink(env: Env, account: Account, now: number): Promise<string> {
  if (!emailConfigured(env) || !env.SENDBLUE_NUMBER) return LINK_IN_APP;
  const recent = await env.DB.prepare("SELECT 1 AS y FROM text_link_codes WHERE user_id = ? AND created_at > ?")
    .bind(account.id, now - LINK_EMAIL_EVERY_MS)
    .first();
  if (recent) return LINK_EMAILED(account.email);
  const { code } = await issueLinkCode(env.DB, account.id, now);
  const sent = await sendEmail(env, linkEmail(account, env.SENDBLUE_NUMBER, code));
  return sent ? LINK_EMAILED(account.email) : LINK_IN_APP;
}

/** The email with the link code: a button that opens Messages with the text ready, and the text to send by hand. */
export function linkEmail(account: Account, number: string, code: string): Email {
  const first = account.name?.trim().split(/\s+/)[0] ?? null;
  const hello = `Hi${first ? ` ${first}` : ""},`;
  const why = "You texted OVOA this email. To make those texts yours, on your account and your plan, tap the button on your iPhone and send the text it opens:";
  const body = linkText(code);
  const link = `sms:${number}&body=${encodeURIComponent(body)}`;
  const orText = `Or text this to ${number}:`;
  const after = "It works for 15 minutes. If this wasn't you, ignore this email: nothing is linked without that text.";
  const p = (s: string) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#060606">${esc(s)}</p>`;
  return {
    to: account.email,
    subject: "Link your number to OVOA",
    text: [hello, why, link, orText, body, after, "OVOA"].join("\n\n"),
    html: `<!doctype html><html><body style="margin:0;padding:0;background:#edebee">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#edebee;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:20px;padding:32px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"><tr><td>
<p style="margin:0 0 24px;font-size:14px;font-weight:700;letter-spacing:0.08em;color:#060606">OVOA</p>
${p(hello)}
${p(why)}
<p style="margin:8px 0 24px"><a href="${esc(link)}" style="display:inline-block;background:#060606;color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:24px">Link my number</a></p>
${p(orText)}
<p style="margin:8px 0 24px;font-size:18px;font-weight:700;color:#060606;font-family:'SF Mono',Menlo,Consolas,monospace">${esc(body)}</p>
${p(after)}
</td></tr></table>
</td></tr></table></body></html>`,
  };
}
