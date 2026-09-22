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

export type Session = { userId: string; kind: SessionKind; tokenHash: string; expiresAt: number };

// ---------- Session cache ----------
//
// Every request used to start with a database read to find out whose token it
// was, before anything else could happen. A spoken reply is one /chat and then
// one /voice/speak per sentence, and a phone posts /logs every few seconds, so
// most of those reads were asking about a token this isolate had seen a moment
// ago. Kept in memory for a short while instead.
//
// The price is that a session ended somewhere else (signed out on another
// isolate, password changed) still works here for up to SESSION_CACHE_MS. Every
// path that ends a session also drops it here, so on the isolate that did it
// the change is immediate.

const SESSION_CACHE_MS = 60_000;
const SESSION_CACHE_MAX = 5_000;
const sessionCache = new Map<string, { session: Session; at: number }>();

function cacheSession(session: Session) {
  // Re-inserted so the Map's order is oldest first, for the eviction below.
  sessionCache.delete(session.tokenHash);
  sessionCache.set(session.tokenHash, { session, at: Date.now() });
  if (sessionCache.size > SESSION_CACHE_MAX) {
    const oldest = sessionCache.keys().next().value;
    if (oldest !== undefined) sessionCache.delete(oldest);
  }
}

/** Drops every cached session of one account, or all but `keepHash`. */
function forgetCachedSessions(userId: string, keepHash?: string, kind?: SessionKind) {
  for (const [hash, { session }] of sessionCache) {
    if (session.userId === userId && hash !== keepHash && (!kind || session.kind === kind)) sessionCache.delete(hash);
  }
}

export async function sessionForToken(db: D1Database, token: string): Promise<Session | null> {
  const tokenHash = await sha256(token);
  const now = Date.now();
  const hit = sessionCache.get(tokenHash);
  if (hit && now - hit.at < SESSION_CACHE_MS && hit.session.expiresAt > now) return hit.session;
  sessionCache.delete(tokenHash);
  const row = await db
    .prepare("SELECT user_id, kind, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(tokenHash, now)
    .first<{ user_id: string; kind: SessionKind; expires_at: number }>();
  if (!row) return null;
  const session: Session = { userId: row.user_id, kind: row.kind, tokenHash, expiresAt: row.expires_at };
  cacheSession(session);
  return session;
}

/**
 * Keeps a phone signed in while it is being used. Until now a session simply
 * died 30 days after sign-in however much the app was used in between, and put
 * the person back on a sign-in screen that 36 of 38 devices never got past
 * (device_logs, 2026-09-21). Siri keys have their own five-year life; left alone.
 */
export async function touchSession(db: D1Database, session: Session) {
  if (session.kind !== "app") return;
  const now = Date.now();
  if (session.expiresAt > now + SESSION_TTL_MS - SESSION_RENEW_AFTER_MS) return;
  const expiresAt = now + SESSION_TTL_MS;
  await db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(expiresAt, session.tokenHash).run();
  // The cached copy too, or this isolate would renew it again on every request.
  const hit = sessionCache.get(session.tokenHash);
  if (hit) hit.session = { ...hit.session, expiresAt };
}

export async function deleteOtherSessions(db: D1Database, userId: string, keepToken: string) {
  const keepHash = await sha256(keepToken);
  await db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(userId, keepHash).run();
  forgetCachedSessions(userId, keepHash);
}

export async function deleteSession(db: D1Database, token: string) {
  const tokenHash = await sha256(token);
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  sessionCache.delete(tokenHash);
}

/** Ends every session of one account, or every one of a kind (its Siri key). */
export async function deleteSessions(db: D1Database, userId: string, kind?: SessionKind) {
  await (kind
    ? db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = ?").bind(userId, kind)
    : db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId)
  ).run();
  forgetCachedSessions(userId, undefined, kind);
}
