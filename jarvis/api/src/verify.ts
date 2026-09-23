import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { checkCode, codeEmail, codesAvailable, CODE_RESEND_MS, CODE_TTL_MS, deliverCode, issueCode, unsendCode } from "./emailauth";
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
// only) marks an account proven, and a local worker without RESEND_API_KEY
// writes each code to its log (emailauth.ts deliverCode).

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

/** Blocked until the code is typed: made by the app's sign-up since this shipped, and not proven yet. Pure. */
export const mustVerifyNow = (row: VerifyRow | null | undefined) => !!row && !!row.must_verify && row.email_verified_at == null;

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

/**
 * Sends a code to the account's own address, for the app's code step. Shared
 * by POST /me/email/code and the sign-up itself (index.ts), which sends the
 * first one. `waitSeconds` when it's too soon for another.
 */
export async function sendAccountCode(
  env: Env,
  user: { email: string; name: string | null },
): Promise<{ sent: true; via: "sent" | "logged" } | { sent: false; waitSeconds?: number }> {
  if (!codesAvailable(env)) return { sent: false };
  const issued = await issueCode(env.DB, user.email);
  if ("waitSeconds" in issued) return { sent: false, waitSeconds: issued.waitSeconds };
  const email = codeEmail({ to: user.email, code: issued.code, name: user.name, existing: true, confirm: true });
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
  const out = await sendAccountCode(c.env, user);
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
