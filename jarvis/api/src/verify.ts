import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { checkCode, codeEmail, codesAvailable, CODE_RESEND_MS, CODE_TTL_MS, deliverCode, issueCode, unmailable, unsendCode } from "./emailauth";
import { randomHex, sha256 } from "./auth";
import { allowed, tooMany } from "./limits";
import { say } from "./obs";
import type { Env, Vars } from "./types";

// Proving the address on an account, in the app (the v1 release, decision 3).
//
// The app keeps its email and password sign-up. Straight after it, a six-digit
// code goes to the address (the same codes as ovoa.ai's sign-in, emailauth.ts:
// hashed, ten minutes, five tries, a minute between two, five an hour), and the
// app asks for it. Until it's typed, an account made that way (users.must_verify,
// migration 0041) can reach only what it needs to finish or give up: GET /me,
// signing out, deleting the account, and the two code routes here. Everything
// else answers 403 needs_verification (requireVerified).
//
// Accounts from before this aren't blocked by the server: phones already
// signed in never sign in again (sessions renew with use), and an old build has
// no box to type a code in. The new app asks them for a code once, at their
// next open, because GET /me says emailVerified is false; users.email_verified_at
// (migration 0039) is set by whichever proof comes first, here or on ovoa.ai.
//
// For smoke tests and the bench scripts, POST /debug/verify (index.ts, DEBUG_KEY
// only) marks an account proven, and a local worker (EMAIL_CODES_TO_LOG)
// without RESEND_API_KEY writes each code to its log (emailauth.ts deliverCode).
// Where no code can go out at all (no Resend key on a deployed Worker), a new
// account isn't held (index.ts /auth/signup): the app's code step can be put off.

/** What an unproven new account may still reach. Everything else is 403 until the code is typed. */
const OPEN_ROUTES: [method: string, path: RegExp][] = [
  ["GET", /^\/me$/],
  ["DELETE", /^\/me$/],
  ["POST", /^\/auth\/logout$/],
  ["POST", /^\/me\/email\/(code|verify)$/],
];

export const openWhileUnverified = (method: string, path: string) => {
  const m = method.toUpperCase();
  return OPEN_ROUTES.some(([rm, re]) => rm === m && re.test(path));
};

export const VERIFY_NEEDED =
  "Enter the code we emailed you to finish making your account. No box for it? Update OVOA from TestFlight.";

export const needsVerificationBody = () => ({ error: "needs_verification" as const, message: VERIFY_NEEDED });

export type VerifyRow = { must_verify: number | null; email_verified_at: number | null };

/**
 * Blocked until the code is typed: made by the app's sign-up since this shipped
 * (must_verify 1), and not proven yet. 2 is the same sign-up on a Worker that
 * couldn't send a code, not held (migration 0045). Pure.
 */
export const mustVerifyNow = (row: VerifyRow | null | undefined) => !!row && Number(row.must_verify) === 1 && row.email_verified_at == null;

// Per isolate, and only the answer that can't change back: once proven (or an
// account from before, which never has to be), always so. Every signed-in
// request asks, so after the first a person costs nothing here. An unproven
// account is read every time, which is only ever a handful of requests.
const MEMO_MAX = 10_000;
const clear = new Set<string>();

/** Forgets what this isolate remembered (tests; a deleted account's id is never reused). */
export function forgetVerified(userId?: string) {
  if (userId) clear.delete(userId);
  else clear.clear();
}

/** Whether this account is held at the code screen right now. */
export async function needsVerification(env: Pick<Env, "DB">, userId: string): Promise<boolean> {
  if (clear.has(userId)) return false;
  const row = await env.DB.prepare("SELECT must_verify, email_verified_at FROM users WHERE id = ?").bind(userId).first<VerifyRow>();
  // No row: the session is for an account that's gone, and GET /me says so.
  if (!row) return false;
  if (mustVerifyNow(row)) return true;
  clear.add(userId);
  if (clear.size > MEMO_MAX) clear.delete(clear.values().next().value!);
  return false;
}

/**
 * For signed-in routes, after the session is found and before the plan is
 * asked: an account that must prove its address and hasn't gets 403
 * needs_verification from anything but OPEN_ROUTES.
 */
export function requireVerified(): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    if (openWhileUnverified(c.req.method, c.req.path)) return next();
    if (!(await needsVerification(c.env, c.var.userId))) return next();
    say("verify", { outcome: "403", user: c.var.userId, path: c.req.path });
    return c.json(needsVerificationBody(), 403);
  };
}

/** Proven: by the code here, on ovoa.ai, or by POST /debug/verify. */
export async function markVerified(env: Pick<Env, "DB">, userId: string, now = Date.now()) {
  await env.DB.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?").bind(now, userId).run();
  clear.add(userId);
}

// ---------- The link in the email ----------
//
// The confirmation email carries a button as well as the code (2026-09-24): a
// link to api.ovoa.ai/verify?id=<token> that proves the address in one tap.
// The token is 32 random bytes; only its hash is kept (verify_links, migration
// 0048). It works once, for LINK_TTL_MS, and only while the account still has
// the address it was sent to. The code in the same email still works, for a
// link opened on another device. The app notices either way (it reads GET /me
// again while its code screen is up).

/** How long the link in a confirmation email works. */
export const LINK_TTL_MS = 24 * 60 * 60_000;

/** A one-time link for the confirmation email. */
export async function issueVerifyLink(env: Pick<Env, "DB" | "PUBLIC_URL">, userId: string, email: string, now = Date.now()) {
  const token = randomHex(32);
  await env.DB.prepare("INSERT INTO verify_links (token_hash, user_id, email, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(token), userId, email, now + LINK_TTL_MS, now)
    .run();
  return `${(env.PUBLIC_URL || "https://api.ovoa.ai").replace(/\/+$/, "")}/verify?id=${token}`;
}

export type LinkOutcome = "proven" | "already" | "expired" | "unknown";

/** The link was opened: proves the address if the link is live and the account still has it. */
export async function useVerifyLink(env: Pick<Env, "DB">, token: string, now = Date.now()): Promise<LinkOutcome> {
  if (!/^[0-9a-f]{64}$/.test(token)) return "unknown";
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT l.user_id, l.email, l.expires_at, l.used_at, u.email AS current_email, u.email_verified_at
       FROM verify_links l JOIN users u ON u.id = l.user_id WHERE l.token_hash = ?`,
  )
    .bind(hash)
    .first<{ user_id: string; email: string; expires_at: number; used_at: number | null; current_email: string; email_verified_at: number | null }>();
  if (!row || row.current_email.toLowerCase() !== row.email.toLowerCase()) return "unknown";
  // Tapped twice, or the code got there first: nothing more to do, and nothing wrong.
  if (row.email_verified_at != null) return "already";
  if (row.used_at != null || row.expires_at < now) return "expired";
  await env.DB.prepare("UPDATE verify_links SET used_at = ? WHERE token_hash = ?").bind(now, hash).run();
  await markVerified(env, row.user_id, now);
  return "proven";
}

/** The page the link opens. Plain HTML, the email's look. Pure. */
export function linkPage(outcome: LinkOutcome) {
  const ok = outcome === "proven" || outcome === "already";
  const title = ok ? "Your email is confirmed" : outcome === "expired" ? "That link has expired" : "That link doesn't work";
  const body = ok
    ? "You're all set. Go back to OVOA: it carries on by itself."
    : "Open OVOA and send yourself a new email from the code screen, or from Settings → Account.";
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · OVOA</title></head>
<body style="margin:0;padding:0;background:#edebee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<div style="max-width:520px;margin:48px auto;padding:0 16px"><div style="background:#fff;border-radius:20px;padding:32px 28px">
<p style="margin:0 0 24px;font-size:14px;font-weight:700;letter-spacing:0.08em;color:#060606">OVOA</p>
<h1 style="margin:0 0 12px;font-size:24px;color:#060606">${esc(title)}</h1>
<p style="margin:0 0 24px;font-size:16px;line-height:1.55;color:#060606">${esc(body)}</p>
<a href="ovoa://" style="display:inline-block;background:#060606;color:#fff;text-decoration:none;font-weight:600;padding:14px 22px;border-radius:22px">Open OVOA</a>
</div></div></body></html>`;
}

/** Public: the link from the email. No session, so the token is the whole proof. */
export const verifyLinkRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

verifyLinkRoutes.get("/verify", async (c) => {
  const outcome = await useVerifyLink(c.env, c.req.query("id") ?? "");
  say("verify", { outcome: `link ${outcome}` });
  c.header("cache-control", "no-store");
  return c.html(linkPage(outcome), outcome === "proven" || outcome === "already" ? 200 : 410);
});

/**
 * Sends a code to the account's own address, for the app's code step, with a
 * one-tap link beside it (issueVerifyLink). Shared by POST /me/email/code and
 * the sign-up itself (index.ts), which sends the first one. `waitSeconds` when
 * it's too soon for another. Nothing for a reserved test address
 * (emailauth.ts reservedAddress), which can't receive it.
 */
export async function sendAccountCode(
  env: Env,
  user: { id: string; email: string; name: string | null },
): Promise<{ sent: true; via: "sent" | "logged" } | { sent: false; waitSeconds?: number }> {
  if (!codesAvailable(env) || unmailable(env, user.email)) return { sent: false };
  const issued = await issueCode(env.DB, user.email);
  if ("waitSeconds" in issued) return { sent: false, waitSeconds: issued.waitSeconds };
  // The code alone still does the job if the link can't be made.
  const link = await issueVerifyLink(env, user.id, user.email).catch((err: unknown) => {
    console.error("ovoa.err verify: couldn't make the link", err);
    return undefined;
  });
  const email = codeEmail({ to: user.email, code: issued.code, name: user.name, existing: true, confirm: true, link });
  const via = await deliverCode(env, email, issued.code);
  if (via === "failed") {
    // Not sent: void, and not counted against the hour, so they can ask again at once.
    await unsendCode(env.DB, user.email);
    return { sent: false };
  }
  return { sent: true, via };
}

// ---------- Routes ----------

export const emailVerifyRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

async function accountOf(env: Env, userId: string) {
  return env.DB.prepare("SELECT email, name, email_verified_at FROM users WHERE id = ?")
    .bind(userId)
    .first<{ email: string; name: string | null; email_verified_at: number | null }>();
}

const RESEND_SECONDS = CODE_RESEND_MS / 1000;

/** A code to the signed-in account's own address. Already proven: nothing to send. */
emailVerifyRoutes.post("/me/email/code", async (c) => {
  const user = await accountOf(c.env, c.var.userId);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  if (user.email_verified_at != null) return c.json({ ok: true, emailVerified: true });
  const out = await sendAccountCode(c.env, { ...user, id: c.var.userId });
  if (out.sent) {
    say("verify", { outcome: `code ${out.via}`, user: c.var.userId });
    return c.json({ ok: true, expiresInMinutes: CODE_TTL_MS / 60_000, resendInSeconds: RESEND_SECONDS });
  }
  if (out.waitSeconds !== undefined) {
    const wait = out.waitSeconds;
    c.header("retry-after", String(wait));
    return c.json(
      {
        error:
          wait > 60
            ? `That's a lot of codes. You can ask for another in ${Math.ceil(wait / 60)} minutes.`
            : `We just sent you a code. You can ask for another in ${wait} seconds.`,
        retryAfter: wait,
      },
      429,
    );
  }
  say("verify", { outcome: "code not sent", user: c.var.userId });
  return c.json({ error: "We couldn't send the email just now. Try again in a minute." }, 502);
});

const codeSchema = z.object({ code: z.string().max(20) });

/** The code from the email. Right: the address is proven, and everything opens up. */
emailVerifyRoutes.post("/me/email/verify", async (c) => {
  const parsed = codeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Enter the 6-digit code from the email" }, 400);
  const user = await accountOf(c.env, c.var.userId);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  if (user.email_verified_at != null) return c.json({ ok: true, emailVerified: true });
  // Five tries a code already; this stops one account trying code after code.
  if (!(await allowed(c.env, "RL_AUTH", `verify:${c.var.userId}`))) return tooMany(c, "tries");
  const checked = await checkCode(c.env.DB, user.email, parsed.data.code);
  if (!checked.ok) {
    say("verify", { outcome: checked.reason === "wrong" ? "wrong code" : "no live code", user: c.var.userId });
    if (checked.reason === "expired") {
      return c.json({ error: "That code has expired or been used up. Send yourself a new one.", expired: true }, 400);
    }
    const left = checked.attemptsLeft === 1 ? "One more try" : `${checked.attemptsLeft} more tries`;
    return c.json({ error: `That code isn't right. ${left}, then you'll need a new one.`, attemptsLeft: checked.attemptsLeft }, 400);
  }
  await markVerified(c.env, c.var.userId);
  say("verify", { outcome: "proven", user: c.var.userId });
  return c.json({ ok: true, emailVerified: true });
});
