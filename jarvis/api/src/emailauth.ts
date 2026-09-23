// Proving an email address, for signing in and signing up on ovoa.ai
// (migrations/0039_email_codes.sql). Two ways:
//
//   1. A six-digit code, emailed from no-reply@ovoa.ai through Resend. Ten
//      minutes to type it, five tries at it, five codes an hour per address.
//   2. Google. The site does the OAuth round trip with its own client and
//      hands over the ID token, which is checked with Google here: the site
//      can't just say "this is so-and-so".
//
// A proven address either has an account and is signed straight in, or gets
// a signup ticket that "Create your account" spends with a name and password.
// There is one `users` table, so an account made in the app signs in on the
// site and one made on the site signs in to the app: the password is what the
// app asks for.
//
// The site's browser calls these routes itself, not the site's server: every
// Worker's requests reach this one from the same address, and the per-address
// limit on sign-ins (RL_AUTH) would then count every visitor as one person.

import { randomHex, sha256 } from "./auth";
import type { Env } from "./types";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_ATTEMPTS = 5;
/** Between two codes to the same address, so a double tap sends one email. */
export const CODE_RESEND_MS = 30 * 1000;
export const CODE_SENDS_PER_HOUR = 5;
export const TICKET_TTL_MS = 30 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// ---------- Codes ----------

/** Six digits, each of the million equally likely (rejection sampling, not a bare modulo). */
export function newCode(fill: (buf: Uint32Array) => void = (buf) => crypto.getRandomValues(buf)): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (;;) {
    fill(buf);
    if (buf[0]! < limit) return String(buf[0]! % 1_000_000).padStart(6, "0");
  }
}

/** Digits only, so "123 456" or "123-456" pasted from the email still matches. */
export const cleanCode = (raw: string) => raw.replace(/\D/g, "");

const codeHash = (email: string, code: string) => sha256(`${email}:${code}`);

/** Hex digests of equal length, compared without stopping at the first difference. */
function sameHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type Issued = { code: string } | { waitSeconds: number };

/**
 * A new code for this address, replacing any earlier one, or how long to wait
 * first. Nothing is sent here: the caller emails it, and calls unsendCode if
 * that fails so the person can try again straight away.
 */
export async function issueCode(db: D1Database, email: string, now = Date.now(), code = newCode()): Promise<Issued> {
  const row = await db
    .prepare("SELECT sent_at, window_start, window_sends FROM email_codes WHERE email = ?")
    .bind(email)
    .first<{ sent_at: number; window_start: number; window_sends: number }>();
  let windowStart = now;
  let windowSends = 1;
  if (row) {
    const since = now - row.sent_at;
    if (since < CODE_RESEND_MS) return { waitSeconds: Math.ceil((CODE_RESEND_MS - since) / 1000) };
    if (now - row.window_start < HOUR_MS) {
      if (row.window_sends >= CODE_SENDS_PER_HOUR) {
        return { waitSeconds: Math.ceil((row.window_start + HOUR_MS - now) / 1000) };
      }
      windowStart = row.window_start;
      windowSends = row.window_sends + 1;
    }
  }
  await db
    .prepare(
      `INSERT INTO email_codes (email, code_hash, expires_at, attempts, sent_at, window_start, window_sends)
       VALUES (?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
         attempts = 0, sent_at = excluded.sent_at, window_start = excluded.window_start,
         window_sends = excluded.window_sends`,
    )
    .bind(email, await codeHash(email, code), now + CODE_TTL_MS, now, windowStart, windowSends)
    .run();
  return { code };
}

/** The email didn't go out: the code is void and doesn't count against the hour. */
export async function unsendCode(db: D1Database, email: string) {
  await db
    .prepare("UPDATE email_codes SET expires_at = 0, sent_at = 0, window_sends = MAX(window_sends - 1, 0) WHERE email = ?")
    .bind(email)
    .run();
}

export type Checked =
  | { ok: true }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "wrong"; attemptsLeft: number };

/**
 * Whether `given` is this address's live code. The try is counted before the
 * comparison, in one statement, so guesses sent all at once still get five
 * between them. A right code is spent; the fifth wrong one voids it.
 */
export async function checkCode(db: D1Database, email: string, given: string, now = Date.now()): Promise<Checked> {
  const row = await db
    .prepare(
      `UPDATE email_codes SET attempts = attempts + 1
        WHERE email = ? AND expires_at > ? AND attempts < ?
        RETURNING code_hash, attempts`,
    )
    .bind(email, now, CODE_ATTEMPTS)
    .first<{ code_hash: string; attempts: number }>();
  if (!row) return { ok: false, reason: "expired" };
  const code = cleanCode(given);
  if (code.length === 6 && sameHex(await codeHash(email, code), row.code_hash)) {
    await db.prepare("UPDATE email_codes SET expires_at = 0 WHERE email = ?").bind(email).run();
    return { ok: true };
  }
  const attemptsLeft = CODE_ATTEMPTS - row.attempts;
  if (attemptsLeft <= 0) {
    await db.prepare("UPDATE email_codes SET expires_at = 0 WHERE email = ?").bind(email).run();
    return { ok: false, reason: "expired" };
  }
  return { ok: false, reason: "wrong", attemptsLeft };
}

// ---------- Signup tickets ----------

/** For a proven address with no account yet. Only its hash is stored. */
export async function issueTicket(db: D1Database, email: string, name: string | null, now = Date.now()) {
  const ticket = randomHex(24);
  await db.batch([
    db.prepare("DELETE FROM signup_tickets WHERE expires_at <= ?").bind(now),
    db
      .prepare("INSERT INTO signup_tickets (ticket_hash, email, name, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(ticket), email, name, now + TICKET_TTL_MS),
  ]);
  return ticket;
}

export type Ticket = { email: string; name: string | null };

/** What a live ticket is for, without spending it: the form shows the address. */
export async function readTicket(db: D1Database, ticket: string, now = Date.now()): Promise<Ticket | null> {
  if (!/^[0-9a-f]{48}$/.test(ticket)) return null;
  return db
    .prepare("SELECT email, name FROM signup_tickets WHERE ticket_hash = ? AND expires_at > ?")
    .bind(await sha256(ticket), now)
    .first<Ticket>();
}

/** Spends a ticket: good once. */
export async function spendTicket(db: D1Database, ticket: string, now = Date.now()): Promise<Ticket | null> {
  if (!/^[0-9a-f]{48}$/.test(ticket)) return null;
  return db
    .prepare("DELETE FROM signup_tickets WHERE ticket_hash = ? AND expires_at > ? RETURNING email, name")
    .bind(await sha256(ticket), now)
    .first<Ticket>();
}

/** For the nightly tidy-up: codes and tickets nobody can use any more. */
export function pruneEmailAuth(db: D1Database, now = Date.now()) {
  return [
    // Kept for the hour after the last send, for the hourly limit.
    db.prepare("DELETE FROM email_codes WHERE expires_at <= ? AND window_start <= ?").bind(now, now - HOUR_MS),
    db.prepare("DELETE FROM signup_tickets WHERE expires_at <= ?").bind(now),
  ];
}

// ---------- The email ----------

export type Email = { to: string; subject: string; text: string; html: string };

const FROM = "OVOA <no-reply@ovoa.ai>";
const REPLY_TO = "support@ovoa.ai";

export const emailConfigured = (env: Pick<Env, "RESEND_API_KEY">) => !!env.RESEND_API_KEY;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The code email. Laid out like the site's own emails (ovoa-team,
 * src/lib/membership/email.server.ts): one column, readable in any mail app,
 * with the code big enough to read off a phone and type on a laptop.
 */
export function codeEmail(input: { to: string; code: string; name: string | null; existing: boolean }): Email {
  const first = input.name?.trim().split(/\s+/)[0] ?? null;
  const hello = `Hi${first ? ` ${first}` : ""},`;
  const why = input.existing ? "Here's your code to sign in to OVOA:" : "Here's your code to create your OVOA account:";
  const minutes = CODE_TTL_MS / 60_000;
  const after = `It works for ${minutes} minutes. If you didn't ask for it, ignore this email: nobody can use your address without the code.`;
  const signOff = "Questions? Reply to this email, or write to support@ovoa.ai.";
  const p = (s: string) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.55;color:#060606">${esc(s)}</p>`;
  return {
    to: input.to,
    subject: `${input.code} is your OVOA code`,
    text: [hello, why, input.code, after, signOff, "OVOA"].join("\n\n"),
    html: `<!doctype html><html><body style="margin:0;padding:0;background:#edebee">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#edebee;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:20px;padding:32px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"><tr><td>
<p style="margin:0 0 24px;font-size:14px;font-weight:700;letter-spacing:0.08em;color:#060606">OVOA</p>
${p(hello)}
${p(why)}
<p style="margin:8px 0 24px;font-size:34px;font-weight:700;letter-spacing:0.18em;color:#060606;font-family:'SF Mono',Menlo,Consolas,monospace">${esc(input.code)}</p>
${p(after)}
${p(signOff)}
</td></tr></table>
</td></tr></table></body></html>`,
  };
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Through Resend. Never throws: false when it didn't go out, with the reason logged. */
export async function sendEmail(
  env: Pick<Env, "RESEND_API_KEY" | "EMAIL_FROM" | "RESEND_API_BASE">,
  email: Email,
  fetcher: Fetcher = fetch,
): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  try {
    const res = await fetcher(`${env.RESEND_API_BASE || "https://api.resend.com"}/emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM || FROM,
        to: [email.to],
        reply_to: REPLY_TO,
        subject: email.subject,
        text: email.text,
        html: email.html,
      }),
    });
    if (!res.ok) {
      console.error(`emailauth: Resend said ${res.status}`, (await res.text()).slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error("emailauth: couldn't reach Resend", err);
    return false;
  }
}

// ---------- Google ----------

export type GoogleIdentity = { email: string; name: string | null };

/**
 * The OAuth clients whose sign-ins count: the app's own (GOOGLE_CLIENT_ID,
 * which connects Gmail and Calendar) and any listed in GOOGLE_SIGNIN_CLIENT_IDS,
 * such as a separate client for the site.
 */
export function googleAudiences(env: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_SIGNIN_CLIENT_IDS">) {
  return [env.GOOGLE_CLIENT_ID, ...(env.GOOGLE_SIGNIN_CLIENT_IDS ?? "").split(",")]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s);
}

/** Who a checked ID token's claims say this is, or null for anything off. */
export function googleIdentityFrom(info: unknown, audiences: string[], now = Date.now()): GoogleIdentity | null {
  if (!info || typeof info !== "object") return null;
  const t = info as Record<string, unknown>;
  if (typeof t.aud !== "string" || !audiences.includes(t.aud)) return null;
  if (t.iss !== "accounts.google.com" && t.iss !== "https://accounts.google.com") return null;
  if (!(Number(t.exp) * 1000 > now)) return null;
  // tokeninfo gives it as the string "true".
  if (t.email_verified !== true && t.email_verified !== "true") return null;
  if (typeof t.email !== "string") return null;
  const email = t.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return null;
  const name = typeof t.name === "string" && t.name.trim() ? t.name.trim().slice(0, 80) : null;
  return { email, name };
}

/**
 * Google's own check of an ID token (signature, expiry), then ours of what's
 * in it. tokeninfo is one request per sign-in, which is nothing at this volume.
 */
export async function verifyGoogleIdToken(
  env: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_SIGNIN_CLIENT_IDS">,
  idToken: string,
  fetcher: Fetcher = fetch,
  now = Date.now(),
): Promise<GoogleIdentity | null> {
  try {
    const res = await fetcher(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!res.ok) return null;
    return googleIdentityFrom(await res.json(), googleAudiences(env), now);
  } catch (err) {
    console.error("emailauth: couldn't reach Google", err);
    return null;
  }
}
