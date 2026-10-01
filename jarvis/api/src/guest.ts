// Texts from a number no account is linked to: a free trial, no sign-up, with
// the whole OVOA. The number gets a hidden trial account (users.trial_phone)
// linked to it, so its texts run the same turn a member's do: tools, web
// search, reminders, websites (at a demo address). The trial is counted per
// number, in text_guests:
//
//   FREE texts, no email or account asked for along the way, then one
//   automated (no AI) text with the way to pay: ovoa.ai/join?id=…, which
//   makes the account, links this number and takes Base in one visit.
//   (Until 2026-10-01: 5, then 5 for an email, then 5 for an account.)
//
// The trial's turns are steered (texting.ts textChannel, `trial`) to land a
// reminder and a website, so a reminder still goes off after the texts run
// out, carrying the way to pay (notes.ts fireDueNotes, PAY_AFTER_REMINDER).
//
// An email that already has an OVOA account doesn't make the texts that
// account's: anyone could text anyone's address. OVOA emails that address a
// link code instead, with a one-tap link that puts it in a text to OVOA, and
// the text from this number is what links it (texting.ts redeem), exactly as
// the app's Link my number does. Linking moves what the trial account made
// (its chat, notes, reminders, websites and their addresses) to the real
// account and deletes the trial account (mergeTrial).
import { CONTACT_CARD_PATH } from "./contactcard";
import { emailConfigured, esc, sendEmail, type Email } from "./emailauth";
import { atLeast, grantTrialTurn, isDevEmail, loadPlan } from "./plans";
import { say } from "./obs";
import { issueLinkCode, linkText } from "./texting";
import type { Env } from "./types";

/** Free texts per number, all of them before anything is asked. */
export const FREE = 15;
const TELL_EVERY_MS = 6 * 3_600_000;
/** Base's price, as the texts say it. The site's plans are the real one (Stripe). */
export const BASE_PRICE = "$9.95/mo";

type Row = { used: number; email: string | null };

const JOIN = "https://ovoa.ai/join?id=";
/** A free account that already has its number linked picks its plan here (signed in). */
const PICK_PLAN = "https://ovoa.ai/text/link";
// What they keep, what it costs, and that they can leave: one text, no pressure after it.
export const PAY = (link: string) =>
  `That's your ${FREE} free texts. Keep me for ${BASE_PRICE} and I'll remember everything from today. Cancel anytime: ${link}`;
export const CAPPED = PAY(PICK_PLAN);
/** Under a reminder that went off after the free texts ran out. */
export const PAY_AFTER_REMINDER = (link: string) => `That's me keeping track for you. Keep me around for ${BASE_PRICE}: ${link}`;

export const LINK_EMAILED = (email: string) =>
  `That email has an OVOA account. I just sent ${email} a link. Tap it on this phone and send the text it opens. That's it.`;
export const LINK_ON_SITE =
  "That email has an OVOA account. Sign in at ovoa.ai/account and tap Link my number.";
/** One link email per account in this long, however many times the address is texted. */
const LINK_EMAIL_EVERY_MS = 10 * 60_000;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
export const emailIn = (text: string) => text.match(EMAIL)?.[0]?.toLowerCase() ?? null;

/** The trial account's address: .invalid never receives mail (emailauth.ts sendEmail won't try). */
const trialEmail = (phone: string) => `trial-${phone.replace(/\D/g, "")}@trial.ovoa.invalid`;
export const isTrialEmail = (email: string) => email.endsWith(".invalid");

async function load(db: D1Database, phone: string, now: number): Promise<Row> {
  const fresh = await db
    .prepare("INSERT OR IGNORE INTO text_guests (phone, created_at, updated_at) VALUES (?, ?, ?)")
    .bind(phone, now, now)
    .run();
  // The trial is once per number, ever: a number whose old row was deleted for
  // age (retention.ts) comes back with its free texts already used.
  const first = await db
    .prepare("INSERT OR IGNORE INTO text_trial_numbers (phone, created_at) VALUES (?, ?)")
    .bind(phone, now)
    .run();
  if (fresh.meta.changes && !first.meta.changes)
    await db.prepare("UPDATE text_guests SET used = ? WHERE phone = ?").bind(FREE, phone).run();
  return (await db.prepare("SELECT used, email FROM text_guests WHERE phone = ?").bind(phone).first<Row>())!;
}

/** demo + six letters and digits: the trial's username, so its websites live at demo….ovoa.ai. */
function demoName() {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `demo${[...bytes].map((b) => abc[b % abc.length]).join("")}`;
}

/**
 * The hidden trial account for this number, made and linked to it the first
 * time. Its user id. Its AI consent is the texting itself: they texted an AI.
 */
export async function trialAccount(db: D1Database, phone: string, now = Date.now()): Promise<string> {
  const had = await db.prepare("SELECT id FROM users WHERE trial_phone = ?").bind(phone).first<{ id: string }>();
  const id = had?.id ?? crypto.randomUUID();
  if (!had) {
    await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO users (id, email, password_hash, password_salt, name, created_at, trial_phone, username, username_at, ai_consent_at, ai_consent_version, plan_override)
           VALUES (?, ?, '', '', '', ?, ?, ?, ?, ?, 1, 'free')`,
        )
        .bind(id, trialEmail(phone), now, phone, demoName(), now, now),
      db.prepare("INSERT OR IGNORE INTO settings (user_id, assistant_name, updated_at) VALUES (?, 'OVOA', ?)").bind(id, now),
    ]);
  }
  const row = await db.prepare("SELECT id FROM users WHERE trial_phone = ?").bind(phone).first<{ id: string }>();
  await db
    .prepare("INSERT INTO text_links (user_id, phone, linked_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO NOTHING")
    .bind(row!.id, phone, now)
    .run();
  if (!had) say("text", { outcome: "trial account", user: row!.id });
  return row!.id;
}

type Account = { id: string; email: string; name: string | null };

const accountFor = (db: D1Database, email: string | null) =>
  email
    ? db
        .prepare("SELECT id, email, name FROM users WHERE lower(email) = ? AND trial_phone IS NULL")
        .bind(email.toLowerCase())
        .first<Account>()
    : Promise.resolve(null);

export type TrialOutcome = { answer: false } | { answer: true; after: { text: string; media?: string }[] };

/**
 * Before a text's turn: whether to answer it, and what to text after the
 * reply. A member on a plan is always answered, uncounted. Everyone else
 * spends one of the number's free texts (and the turn is let through as
 * Base: plans.ts grantTrialTurn), or is told the next step instead.
 */
export async function trialGate(
  env: Env,
  userId: string,
  phone: string,
  content: string,
  send: (text: string) => Promise<unknown>,
  now = Date.now(),
): Promise<TrialOutcome> {
  const db = env.DB;
  const me = await db.prepare("SELECT trial_phone FROM users WHERE id = ?").bind(userId).first<{ trial_phone: string | null }>();
  const trial = !!me?.trial_phone;
  if (!trial) {
    const loaded = await loadPlan(env, userId);
    if (!loaded || atLeast(loaded.plan.tier, "base") || isDevEmail(env, loaded.email)) return { answer: true, after: [] };
  }
  const row = await load(db, phone, now);
  if (trial) {
    const email = emailIn(content);
    // Their account's email, given now or before: the way to link, not more trial.
    const account = await accountFor(db, email ?? row.email);
    if (account && (email || row.used >= FREE)) {
      if (email && !row.email) await db.prepare("UPDATE text_guests SET email = ?, updated_at = ? WHERE phone = ?").bind(email, now, phone).run();
      await send(await offerLink(env, account, now));
      say("text", { outcome: "guest has an account", user: account.id });
      return { answer: false };
    }
    // Any other email is kept (who they are, if they don't pay) and the text answered like any other.
    if (email && !row.email) {
      await db.prepare("UPDATE text_guests SET email = ?, updated_at = ? WHERE phone = ?").bind(email, now, phone).run();
      say("text", { outcome: "guest email" });
    }
  }
  // The trial number's way to pay makes the account too; a linked free account picks a plan signed in.
  const capped = async () => (trial ? PAY(await joinLink(db, phone)) : CAPPED);

  // Take one of their free texts, atomically, so a burst can't overspend.
  const took = await db
    .prepare("UPDATE text_guests SET used = used + 1, updated_at = ? WHERE phone = ? AND used < ?")
    .bind(now, phone, FREE)
    .run();
  if (!took.meta.changes) {
    // Just paid? This isolate may still remember them as free: ask the site before saying "pay".
    if (!trial) {
      const fresh = await loadPlan(env, userId, { force: true });
      if (fresh && atLeast(fresh.plan.tier, "base")) return { answer: true, after: [] };
    }
    const tell = await db
      .prepare("UPDATE text_guests SET told_at = ? WHERE phone = ? AND (told_at IS NULL OR told_at < ?)")
      .bind(now, phone, now - TELL_EVERY_MS)
      .run();
    if (tell.meta.changes) await send(await capped());
    say("text", { outcome: "trial capped", user: userId });
    return { answer: false };
  }
  const used = row.used + 1;
  grantTrialTurn(userId, now);
  const after: { text: string; media?: string }[] = [];
  // Their first reply brings OVOA's contact card, so they can save it with its name and logo.
  if (trial && used === 1) after.push({ text: "OVOA", media: `https://api.ovoa.ai${CONTACT_CARD_PATH}` });
  if (used >= FREE) {
    await db.prepare("UPDATE text_guests SET told_at = ? WHERE phone = ?").bind(now, phone).run();
    after.push({ text: await capped() });
  }
  say("text", { outcome: "trial text", user: userId, used });
  return { answer: true, after };
}

/**
 * ovoa.ai/join?id=…: the link a trial number gets when its free texts run
 * out. Only this number is ever texted it, so whoever signs in with it there
 * gets the number linked (POST /texting/join), no code to text back. The same
 * token every time, until it's used.
 */
export async function joinLink(db: D1Database, phone: string): Promise<string> {
  const had = await db.prepare("SELECT join_token FROM text_guests WHERE phone = ?").bind(phone).first<{ join_token: string | null }>();
  if (had?.join_token) return JOIN + had.join_token;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db.prepare("UPDATE text_guests SET join_token = ? WHERE phone = ? AND join_token IS NULL").bind(token, phone).run();
  const now = await db.prepare("SELECT join_token FROM text_guests WHERE phone = ?").bind(phone).first<{ join_token: string | null }>();
  return JOIN + (now?.join_token ?? token);
}

/** The number a join token was texted to. Null if it's unknown or used (linking clears it). */
export async function joinPhone(db: D1Database, token: string): Promise<string | null> {
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  const row = await db.prepare("SELECT phone FROM text_guests WHERE join_token = ?").bind(token).first<{ phone: string }>();
  return row?.phone ?? null;
}

/** How far a trial account is: texts used (this one included), and whether it has a reminder and a website yet. */
export type TrialProgress = { used: number; free: number; reminder: boolean; site: boolean };

/** Null when the account isn't a texting trial's. */
export async function trialProgress(db: D1Database, userId: string): Promise<TrialProgress | null> {
  const row = await db
    .prepare(
      `SELECT g.used AS used,
              EXISTS (SELECT 1 FROM notes WHERE user_id = u.id AND remind_at IS NOT NULL) AS reminder,
              EXISTS (SELECT 1 FROM sites WHERE user_id = u.id) AS site
         FROM users u LEFT JOIN text_guests g ON g.phone = u.trial_phone
        WHERE u.id = ? AND u.trial_phone IS NOT NULL`,
    )
    .bind(userId)
    .first<{ used: number | null; reminder: number; site: number }>();
  if (!row) return null;
  return { used: row.used ?? 0, free: FREE, reminder: !!row.reminder, site: !!row.site };
}

/**
 * What goes under a reminder that went off for a trial account whose free
 * texts are used up: the way to pay, at the moment OVOA just proved itself.
 * Null for everyone else (still texting free, or not a trial).
 */
export async function payAfterReminder(db: D1Database, userId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT u.trial_phone AS phone, g.used AS used FROM users u JOIN text_guests g ON g.phone = u.trial_phone WHERE u.id = ?")
    .bind(userId)
    .first<{ phone: string; used: number }>();
  if (!row || row.used < FREE) return null;
  return PAY_AFTER_REMINDER(await joinLink(db, row.phone));
}

// What a trial account made that's worth keeping, moved when the number is
// linked to a real account. Anything else goes with the trial account.
const KEEP = [
  "messages",
  "memories",
  "notes",
  "todos",
  "alarms",
  "routines",
  "people",
  "profile",
  "user_apps",
  "sites",
  "site_leads",
  "life_plans",
  "food_log",
  "money_settings",
  "money_accounts",
  "money_income",
  "money_bills",
  "money_spend",
  "money_plans",
  "agent_jobs",
  "agent_goals",
  "agent_notes",
];

/**
 * The number that was on a trial is now linked to `realId` (texting.ts redeem):
 * what the trial made moves there, its websites keep their addresses (and its
 * demo username too, when the account has none), and the trial account goes.
 */
export async function mergeTrial(db: D1Database, phone: string, realId: string) {
  const trial = await db
    .prepare("SELECT id, username FROM users WHERE trial_phone = ? AND id != ?")
    .bind(phone, realId)
    .first<{ id: string; username: string | null }>();
  if (!trial) return false;
  for (const table of KEEP) {
    // OR IGNORE: a row the account already has one of (its settings, say) stays theirs.
    await db
      .prepare(`UPDATE OR IGNORE ${table} SET user_id = ? WHERE user_id = ?`)
      .bind(realId, trial.id)
      .run()
      .catch((err: unknown) => console.error(`ovoa.err trial merge: ${table}`, err));
  }
  const real = await db.prepare("SELECT username FROM users WHERE id = ?").bind(realId).first<{ username: string | null }>();
  await db.prepare("DELETE FROM users WHERE id = ?").bind(trial.id).run();
  if (trial.username && !real?.username) {
    await db.prepare("UPDATE users SET username = ?, username_at = ? WHERE id = ?").bind(trial.username, Date.now(), realId).run();
  }
  say("text", { outcome: "trial merged", user: realId });
  return true;
}

/** Emails the account a link code (at most once in LINK_EMAIL_EVERY_MS). The text to send the guest. */
async function offerLink(env: Env, account: Account, now: number): Promise<string> {
  if (!emailConfigured(env) || !env.SENDBLUE_NUMBER) return LINK_ON_SITE;
  const recent = await env.DB.prepare("SELECT 1 AS y FROM text_link_codes WHERE user_id = ? AND created_at > ?")
    .bind(account.id, now - LINK_EMAIL_EVERY_MS)
    .first();
  if (recent) return LINK_EMAILED(account.email);
  const { code } = await issueLinkCode(env.DB, account.id, now);
  const sent = await sendEmail(env, linkEmail(account, env.SENDBLUE_NUMBER, code, env.PUBLIC_URL));
  return sent ? LINK_EMAILED(account.email) : LINK_ON_SITE;
}
/** The email with the link code: a button that opens Messages with the text ready, and the text to send by hand. */
export function linkEmail(account: Account, number: string, code: string, base: string): Email {
  const first = account.name?.trim().split(/\s+/)[0] ?? null;
  const hello = `Hi${first ? ` ${first}` : ""},`;
  const why = "You texted OVOA this email. To make those texts yours, on your account and your plan, tap the button on your iPhone and send the text it opens:";
  const body = linkText(code);
  // Gmail and most mail apps drop sms: links, so the button goes to a page of ours that opens Messages.
  const link = `${base}/text/open?to=${encodeURIComponent(number)}&body=${encodeURIComponent(body)}`;
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

/** GET /text/open?to=&body=: opens Messages with the text ready. Email buttons can't link to sms: directly. */
export function openMessagesPage(to: string, body: string): string | null {
  if (!/^\+?\d{7,15}$/.test(to) || body.length > 200) return null;
  const sms = `sms:${to}&body=${encodeURIComponent(body)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Messages</title>
<meta http-equiv="refresh" content="0;url=${esc(sms)}"></head>
<body style="margin:0;padding:48px 20px;background:#edebee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;text-align:center;color:#060606">
<p style="font-size:14px;font-weight:700;letter-spacing:0.08em">OVOA</p>
<p style="font-size:16px">Opening Messages. If it didn't open, tap the button, then send the text.</p>
<p><a href="${esc(sms)}" style="display:inline-block;background:#060606;color:#fff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:24px">Open Messages</a></p>
<p style="font-size:14px">Or text this to ${esc(to)}:</p>
<p style="font-size:17px;font-weight:700;font-family:'SF Mono',Menlo,Consolas,monospace">${esc(body)}</p>
<script>location.href=${JSON.stringify(sms)};</script>
</body></html>`;
}
