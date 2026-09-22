// Workers caps PBKDF2 at 100k iterations.
const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A session in daily use is pushed back out to the full month, at most one
// write a day. See touchSession.
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashPassword(password: string, saltHex = randomHex(16)) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = Uint8Array.from(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return { hash: toHex(bits), salt: saltHex };
}

export async function verifyPassword(password: string, saltHex: string, expectedHex: string) {
  const { hash } = await hashPassword(password, saltHex);
  const a = enc.encode(hash);
  const b = enc.encode(expectedHex);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

async function sha256(value: string) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}

export type SessionKind = "app" | "siri";

export async function createSession(
  db: D1Database,
  userId: string,
  { kind = "app", ttlMs = SESSION_TTL_MS }: { kind?: SessionKind; ttlMs?: number } = {},
) {
  const token = randomHex(32);
  const now = Date.now();
  await db
    .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, kind) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(token), userId, now, now + ttlMs, kind)
    .run();
  return token;
}

export async function sessionForToken(db: D1Database, token: string) {
  const tokenHash = await sha256(token);
  const row = await db
    .prepare("SELECT user_id, kind, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(tokenHash, Date.now())
    .first<{ user_id: string; kind: SessionKind; expires_at: number }>();
  return row && { userId: row.user_id, kind: row.kind, tokenHash, expiresAt: row.expires_at };
}

/**
 * Keeps a phone signed in while it is being used. Until now a session simply
 * died 30 days after sign-in however much the app was used in between, and put
 * the person back on a sign-in screen that 36 of 38 devices never got past
 * (device_logs, 2026-09-21). Siri keys have their own five-year life; left alone.
 */
export async function touchSession(
  db: D1Database,
  session: { tokenHash: string; kind: SessionKind; expiresAt: number },
) {
  if (session.kind !== "app") return;
  const now = Date.now();
  if (session.expiresAt > now + SESSION_TTL_MS - SESSION_RENEW_AFTER_MS) return;
  await db
    .prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?")
    .bind(now + SESSION_TTL_MS, session.tokenHash)
    .run();
}

export async function deleteOtherSessions(db: D1Database, userId: string, keepToken: string) {
  await db
    .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
    .bind(userId, await sha256(keepToken))
    .run();
}

export async function deleteSession(db: D1Database, token: string) {
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}
