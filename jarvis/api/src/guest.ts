// Texts from a number no account is linked to: a free trial, no sign-up, with
// the whole OVOA. The number gets a hidden trial account (users.trial_phone)
// linked to it, so its texts run the same turn a member's do: tools, web
// search, reminders, websites (at a demo address). The trial is counted per
// number, in text_guests:
//
//   FREE texts, then an automated (no AI) text asks for their email;
//   FREE more for the email, then it asks them to make an account and link
//   the number; FREE more once a real account is linked; then a plan.
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

export const FREE = 5;
const TELL_EVERY_MS = 6 * 3_600_000;
const SIGN_UP = "https://ovoa.ai/text";

type Row = { used: number; email: string | null };

// An offer, not a wall: what they get and what it doesn't cost them.
export const ASK_EMAIL = `Want to keep going? Reply with your email and I'll give you ${FREE} more free texts. No account, no card, no spam.`;
export const GOT_EMAIL = `Thanks! ${FREE} more free texts. Go ahead.`;
export const MAKE_ACCOUNT = (email: string) =>
  `Out of free texts. Sign up free at ${SIGN_UP} with ${email}, then text me that email again. I'll link this number and you get ${FREE} more.`;
export const CAPPED = `That was your last free text. Pick a plan to keep texting me (I'll remember all of this): ${SIGN_UP}`;

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
    await db.prepare("UPDATE text_guests SET used = ? WHERE phone = ?").bind(FREE * 2, phone).run();
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
  let limit: number;
  let capped: string;
  if (trial) {
    const email = emailIn(content);
    // Their account's email, given now or before: the way to link, not more trial.
    const account = await accountFor(db, email ?? row.email);
    if (account && (email || row.used >= FREE * 2)) {
      if (email && !row.email) await db.prepare("UPDATE text_guests SET email = ?, updated_at = ? WHERE phone = ?").bind(email, now, phone).run();
      await send(await offerLink(env, account, now));
      say("text", { outcome: "guest has an account", user: account.id });
      return { answer: false };
    }
    if (email && !row.email) {
      await db.prepare("UPDATE text_guests SET email = ?, updated_at = ? WHERE phone = ?").bind(email, now, phone).run();
      row.email = email;
      say("text", { outcome: "guest email" });
      // Just the email: thank them. Anything more gets answered below.
      if (content.replace(EMAIL, "").trim().length < 3) {
        await send(row.used >= FREE * 2 ? MAKE_ACCOUNT(email) : GOT_EMAIL);
        return { answer: false };
      }
    }
    limit = row.email ? FREE * 2 : FREE;
    capped = row.email ? MAKE_ACCOUNT(row.email) : ASK_EMAIL;
  } else {
    // A free account with its number linked: FREE more, however it got here.
    if (row.used < FREE * 2) await db.prepare("UPDATE text_guests SET used = ? WHERE phone = ?").bind(FREE * 2, phone).run();
    row.used = Math.max(row.used, FREE * 2);
    limit = FREE * 3;
    capped = CAPPED;
  }

  // Take one of their free texts, atomically, so a burst can't overspend.
  const took = await db
    .prepare("UPDATE text_guests SET used = used + 1, updated_at = ? WHERE phone = ? AND used < ?")
    .bind(now, phone, limit)
    .run();
  if (!took.meta.changes) {
    const tell = await db
      .prepare("UPDATE text_guests SET told_at = ? WHERE phone = ? AND (told_at IS NULL OR told_at < ?)")
      .bind(now, phone, now - TELL_EVERY_MS)
      .run();
    if (tell.meta.changes) await send(capped);
    say("text", { outcome: "trial capped", user: userId });
    return { answer: false };
  }
  const used = row.used + 1;
  grantTrialTurn(userId, now);
  const after: { text: string; media?: string }[] = [];
  // Their first reply brings OVOA's contact card, so they can save it with its name and logo.
  if (trial && used === 1) after.push({ text: "OVOA", media: `https://api.ovoa.ai${CONTACT_CARD_PATH}` });
  if (used >= limit) {
    await db.prepare("UPDATE text_guests SET told_at = ? WHERE phone = ?").bind(now, phone).run();
    after.push({ text: capped });
  }
  say("text", { outcome: "trial text", user: userId, used });
  return { answer: true, after };
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
