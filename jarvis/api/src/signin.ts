// Signing in to the app with Google or Apple (migrations/0044_app_signin.sql).
// Google ends where emailauth.ts's proofs end: the address has an account and
// is signed in, or a signup ticket goes back for the name + password step.
// Apple never gets that step: it signs in, or makes the account there and
// then. An account whose address nobody had proven is taken back from whoever
// made it first (index.ts disown()). The routes are in index.ts, beside
// /auth/email/* and afterProven().
//
// Google, "Continue with Google":
//
//   1. POST /auth/google/start {returnUrl}: the app gets Google's URL and a
//      key. Scopes openid email profile only, PKCE, state kept here. The
//      return URL is ovoa://google-signin exactly, or Expo Go on a dev server
//      nearby (appReturnUrl).
//   2. The app opens the URL in an auth session. Google sends the browser to
//      /google/callback, the one redirect registered with Google, which the
//      connect flow (google/oauth.ts) also uses: a sign-in state is found in
//      signin_states and handled here; anything else is a connect.
//   3. Here the code is swapped with the client secret, the ID token checked
//      (verifyGoogleIdToken: the address must be one Google has verified), and
//      the address kept behind a one-time code: random, only its hash stored,
//      sixty seconds, once. The browser goes back to <returnUrl>?code=...
//      Never a session token in a URL.
//   4. POST /auth/google/redeem {code, key}. The key came back with the URL in
//      step 1, straight to the app and never through the browser, so another
//      app that catches the redirect has a code it can't use.
//
// Apple, "Sign in with Apple" (App Store rule 4.8 asks for it beside Google):
//
//   1. POST /auth/apple/start: a nonce, good once, for ten minutes.
//   2. The app passes it to Apple; Apple puts it in the identity token it signs.
//   3. POST /auth/apple {identityToken, nonce, fullName?}: the token's
//      signature is checked against Apple's published keys, then who it's
//      from, for whom (this app), when, and the nonce, which is spent.
//
// Apple's "sub" is kept on the account (users.apple_sub): it stays the same
// when the address behind an Apple ID changes, so a returning person is found
// by it first and by address second.

import { randomHex, sha256 } from "./auth";
import { base64url } from "./crypto";
import { verifyGoogleIdToken } from "./emailauth";
import type { Env } from "./types";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export const SIGNIN_STATE_TTL_MS = 10 * 60 * 1000;
export const SIGNIN_CODE_TTL_MS = 60 * 1000;
/** The installed app's way back: scheme "ovoa" in app.json, and the path lib/signInWith.ts uses. */
export const APP_RETURN_URL = "ovoa://google-signin";
/**
 * Expo Go's way back names the computer serving the app, and only a private
 * or loopback IPv4 address or localhost, the whole host, is taken. Any other
 * exp:// host could be someone else's Expo project: its JavaScript would read
 * the code, and whoever called /auth/google/start holds the key that redeems it.
 */
const EXPO_GO_HOST =
  /^(127(\.\d{1,3}){3}|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|localhost)$/;
export const GOOGLE_SIGNIN_SCOPES = "openid email profile";
/** The app's bundle id: Apple's identity tokens for it name it as their audience. */
export const APPLE_AUDIENCE = "com.ovoa.app";
export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";

/** The connect flow's redirect, which is the only one registered with Google. */
const redirectUri = (env: Pick<Env, "PUBLIC_URL">) => `${env.PUBLIC_URL}/google/callback`;

/** Hex digests of equal length, compared without stopping at the first difference. */
function sameHash(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A return URL the app may be sent back to, or null: exactly the installed
 * app's, or Expo Go on a dev server nearby (EXPO_GO_HOST) unless `expoGo` is
 * off (EXPO_GO_SIGNIN "off" on the Worker). Anyone on the same network as the
 * person signing in could still serve an Expo project, which is why it can be
 * turned off once nobody runs the app in Expo Go.
 */
export function appReturnUrl(raw: unknown, { expoGo = true }: { expoGo?: boolean } = {}): string | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  if (raw === APP_RETURN_URL) return raw;
  if (!expoGo) return null;
  try {
    const url = new URL(raw);
    return (url.protocol === "exp:" || url.protocol === "exps:") && EXPO_GO_HOST.test(url.hostname) ? raw : null;
  } catch {
    return null;
  }
}

// ---------- Google ----------

/**
 * Google's sign-in page for this attempt, and the key that redeems what comes
 * back. The key isn't stored, only its hash.
 */
export async function startGoogleSignin(
  env: Pick<Env, "DB" | "GOOGLE_CLIENT_ID" | "PUBLIC_URL">,
  returnUrl: string,
  now = Date.now(),
): Promise<{ url: string; key: string }> {
  const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const key = randomHex(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM signin_states WHERE expires_at < ?").bind(now),
    env.DB
      .prepare(
        `INSERT INTO signin_states (state, provider, code_verifier, return_url, key_hash, expires_at)
         VALUES (?, 'google', ?, ?, ?, ?)`,
      )
      .bind(state, verifier, returnUrl, await sha256(key), now + SIGNIN_STATE_TTL_MS),
  ]);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(env),
    response_type: "code",
    scope: GOOGLE_SIGNIN_SCOPES,
    // Someone signed in to several Google accounts picks which one.
    prompt: "select_account",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), key };
}

export type GoogleSigninState = { codeVerifier: string; returnUrl: string; keyHash: string; expiresAt: number };

/**
 * A Google sign-in's state, taken (it's good once), or null when `state` isn't
 * one: then it's the connect flow's. Never throws, so a missing table can't
 * take Connect Google down with it.
 */
export async function takeGoogleSigninState(db: D1Database, state: string): Promise<GoogleSigninState | null> {
  try {
    const row = await db
      .prepare(
        `DELETE FROM signin_states WHERE state = ? AND provider = 'google'
         RETURNING code_verifier, return_url, key_hash, expires_at`,
      )
      .bind(state)
      .first<{ code_verifier: string; return_url: string; key_hash: string; expires_at: number }>();
    return row
      ? { codeVerifier: row.code_verifier, returnUrl: row.return_url, keyHash: row.key_hash, expiresAt: row.expires_at }
      : null;
  } catch (err) {
    console.error("signin: couldn't read signin_states", err);
    return null;
  }
}

/** Why a Google sign-in came back without a code, as the app reads it from ?error=. */
export type SigninError = "cancelled" | "expired" | "google" | "unconfirmed";

/** Back to the app: a 302 to its return URL with ?code= or ?error=. */
function backToApp(returnUrl: string, params: { code: string } | { error: SigninError }) {
  const url = new URL(returnUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: url.toString(), "cache-control": "no-store" } });
}

/**
 * The rest of /google/callback for a sign-in: swap Google's code, check who it
 * is, and send the browser back to the app with a one-time code for that.
 */
export async function finishGoogleSignin(
  env: Pick<Env, "DB" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "GOOGLE_SIGNIN_CLIENT_IDS" | "PUBLIC_URL">,
  signin: GoogleSigninState,
  query: { code?: string; error?: string },
  fetcher: Fetcher = fetch,
  now = Date.now(),
): Promise<Response> {
  if (signin.expiresAt < now) return backToApp(signin.returnUrl, { error: "expired" });
  if (query.error || !query.code) {
    // access_denied is the person pressing Cancel on Google's page.
    if (query.error !== "access_denied") console.error("signin: Google came back with", query.error ?? "no code");
    return backToApp(signin.returnUrl, { error: query.error === "access_denied" ? "cancelled" : "google" });
  }
  let idToken: string | undefined;
  try {
    const res = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
        grant_type: "authorization_code",
        code: query.code,
        code_verifier: signin.codeVerifier,
        redirect_uri: redirectUri(env),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!res.ok) console.error("signin: Google code exchange failed", res.status, body.error);
    else idToken = body.id_token;
  } catch (err) {
    console.error("signin: couldn't reach Google", err);
  }
  if (!idToken) return backToApp(signin.returnUrl, { error: "google" });
  // Also refuses an address Google hasn't verified: that proves nothing.
  const who = await verifyGoogleIdToken(env, idToken, fetcher, now);
  if (!who) return backToApp(signin.returnUrl, { error: "unconfirmed" });
  const code = await issueSigninCode(env.DB, signin.keyHash, who, now);
  return backToApp(signin.returnUrl, { code });
}

/** A one-time code for a proven address. Only its hash is kept. */
export async function issueSigninCode(
  db: D1Database,
  keyHash: string,
  who: { email: string; name: string | null },
  now = Date.now(),
) {
  const code = randomHex(24);
  await db.batch([
    db.prepare("DELETE FROM signin_codes WHERE expires_at <= ?").bind(now),
    db
      .prepare("INSERT INTO signin_codes (code_hash, key_hash, email, name, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256(code), keyHash, who.email, who.name, now + SIGNIN_CODE_TTL_MS),
  ]);
  return code;
}

/**
 * Who a one-time code was for, if it's live and `key` is the one its sign-in
 * started with. A code that's looked up is spent whatever the answer: one met
 * with the wrong key is gone too.
 */
export async function redeemSigninCode(
  db: D1Database,
  code: string,
  key: string,
  now = Date.now(),
): Promise<{ email: string; name: string | null } | null> {
  if (!/^[0-9a-f]{48}$/.test(code) || !/^[0-9a-f]{64}$/.test(key)) return null;
  const row = await db
    .prepare("DELETE FROM signin_codes WHERE code_hash = ? RETURNING key_hash, email, name, expires_at")
    .bind(await sha256(code))
    .first<{ key_hash: string; email: string; name: string | null; expires_at: number }>();
  if (!row || row.expires_at <= now || !sameHash(await sha256(key), row.key_hash)) return null;
  return { email: row.email, name: row.name };
}

// ---------- Apple ----------

/** A nonce for one Sign in with Apple, good once for ten minutes. Kept by hash. */
export async function issueAppleNonce(db: D1Database, now = Date.now()) {
  const nonce = randomHex(24);
  await db.batch([
    db.prepare("DELETE FROM signin_states WHERE expires_at < ?").bind(now),
    db
      .prepare("INSERT INTO signin_states (state, provider, expires_at) VALUES (?, 'apple', ?)")
      .bind(await sha256(nonce), now + SIGNIN_STATE_TTL_MS),
  ]);
  return nonce;
}

/** True once for a live nonce this server issued; it's gone after. */
export async function spendAppleNonce(db: D1Database, nonce: string, now = Date.now()) {
  if (!/^[0-9a-f]{48}$/.test(nonce)) return false;
  const row = await db
    .prepare("DELETE FROM signin_states WHERE state = ? AND provider = 'apple' RETURNING expires_at")
    .bind(await sha256(nonce))
    .first<{ expires_at: number }>();
  return !!row && row.expires_at > now;
}

export type AppleIdentity = { sub: string; email: string; nonce: string | null };

/** Who a signature-checked identity token's claims say this is, or null for anything off. */
export function appleIdentityFrom(claims: unknown, now = Date.now()): AppleIdentity | null {
  if (!claims || typeof claims !== "object") return null;
  const t = claims as Record<string, unknown>;
  if (t.iss !== APPLE_ISSUER) return null;
  const aud = Array.isArray(t.aud) ? t.aud : [t.aud];
  if (!aud.includes(APPLE_AUDIENCE)) return null;
  if (!(Number(t.exp) * 1000 > now)) return null;
  // Issued in the future is a clock or a forgery; five minutes for the clock.
  if (Number(t.iat) * 1000 > now + 5 * 60 * 1000) return null;
  if (typeof t.sub !== "string" || !t.sub || t.sub.length > 255) return null;
  // Apple sends it as the string "true" in some tokens and a boolean in others.
  if (t.email_verified !== true && t.email_verified !== "true") return null;
  if (typeof t.email !== "string") return null;
  // A "Hide My Email" address (…@privaterelay.appleid.com) is fine: it reaches them.
  const email = t.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return null;
  return { sub: t.sub, email, nonce: typeof t.nonce === "string" ? t.nonce : null };
}

type AppleJwk = JsonWebKey & { kid?: string };

/** Apple's signing keys, kept a day, and fetched again early for a key id not seen yet (Apple rotates them). */
const APPLE_KEYS_TTL_MS = 24 * 60 * 60 * 1000;
/** No more often than this however many unknown key ids arrive, so junk can't make this hammer Apple. */
const APPLE_KEYS_MIN_GAP_MS = 60 * 1000;
let appleKeys: { keys: AppleJwk[]; at: number } | null = null;

/** For tests: start with no keys. */
export function forgetAppleKeys() {
  appleKeys = null;
}

async function appleKey(kid: string, fetcher: Fetcher, now: number): Promise<AppleJwk | null> {
  const fresh = appleKeys && now - appleKeys.at < APPLE_KEYS_TTL_MS;
  const known = fresh ? appleKeys!.keys.find((k) => k.kid === kid) : undefined;
  if (known) return known;
  if (appleKeys && now - appleKeys.at < APPLE_KEYS_MIN_GAP_MS) return null;
  try {
    const res = await fetcher(APPLE_KEYS_URL);
    if (!res.ok) {
      console.error(`signin: Apple's keys answered ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { keys?: unknown };
    appleKeys = { keys: Array.isArray(body.keys) ? (body.keys as AppleJwk[]) : [], at: now };
  } catch (err) {
    console.error("signin: couldn't reach Apple for its keys", err);
    return null;
  }
  return appleKeys.keys.find((k) => k.kid === kid) ?? null;
}

const fromBase64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) =>
    c.charCodeAt(0),
  );

/**
 * An Apple identity token checked: RS256 signature by one of Apple's published
 * keys, then the claims (appleIdentityFrom). Null for anything off; never throws.
 * The nonce is only read here: the caller compares it and spends it.
 */
export async function verifyAppleIdentityToken(
  token: string,
  fetcher: Fetcher = fetch,
  now = Date.now(),
): Promise<AppleIdentity | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [head, body, sig] = parts as [string, string, string];
    const header = JSON.parse(new TextDecoder().decode(fromBase64url(head))) as { alg?: unknown; kid?: unknown };
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    const jwk = await appleKey(header.kid, fetcher, now);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const good = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      fromBase64url(sig),
      new TextEncoder().encode(`${head}.${body}`),
    );
    if (!good) return null;
    return appleIdentityFrom(JSON.parse(new TextDecoder().decode(fromBase64url(body))), now);
  } catch (err) {
    console.error("signin: couldn't check an Apple identity token", err);
    return null;
  }
}

/** The name Apple sends once, the first time someone signs in to the app, as one line. */
export function appleName(full: { givenName?: string | null; familyName?: string | null } | null | undefined) {
  const name = [full?.givenName, full?.familyName]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 80);
  return name || null;
}

/** The account an Apple ID signed in to before, if any. */
export function userForAppleSub(db: D1Database, sub: string) {
  return db.prepare("SELECT id, email FROM users WHERE apple_sub = ?").bind(sub).first<{ id: string; email: string }>();
}

/**
 * Remembers which Apple ID an account signs in with, unless it already has
 * one. Best effort: the unique index refuses a sub that's on another account,
 * and the sign-in goes ahead on the address regardless.
 */
export async function linkAppleSub(db: D1Database, userId: string, sub: string) {
  try {
    await db.prepare("UPDATE users SET apple_sub = ? WHERE id = ? AND apple_sub IS NULL").bind(sub, userId).run();
  } catch (err) {
    console.error("signin: couldn't link an Apple ID", err);
  }
}

/** For the nightly tidy-up: states and codes nobody can use any more. */
export function pruneSignin(db: D1Database, now = Date.now()) {
  return [
    db.prepare("DELETE FROM signin_states WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM signin_codes WHERE expires_at <= ?").bind(now),
  ];
}
