// Whether someone has the OVOA iPhone app, for ovoa.ai/account's "Get the app"
// card. The app sends x-ovoa-app: <version> on every request (app/src/lib/api.ts);
// the first one each day per person is written to users.app_seen_at. Builds from
// before the header are still seen through their push token, which only a phone
// registers.

const DAY_MS = 24 * 3_600_000;
// Per isolate, so a busy phone costs one write a day, not one per request.
const written = new Map<string, number>();

export async function noteAppSeen(db: D1Database, userId: string, version: string) {
  const now = Date.now();
  if (now - (written.get(userId) ?? 0) < DAY_MS) return;
  written.set(userId, now);
  await db
    .prepare("UPDATE users SET app_seen_at = ?, app_version = ? WHERE id = ?")
    .bind(now, version.slice(0, 32) || null, userId)
    .run();
}

export type AppState = { installed: boolean; lastSeenAt: number | null; version: string | null };

export async function appState(db: D1Database, userId: string): Promise<AppState> {
  const [user, push] = await Promise.all([
    db.prepare("SELECT app_seen_at, app_version FROM users WHERE id = ?").bind(userId)
      .first<{ app_seen_at: number | null; app_version: string | null }>(),
    db.prepare("SELECT MAX(COALESCE(last_ok_at, created_at)) AS at FROM push_tokens WHERE user_id = ? AND fail_count < 3")
      .bind(userId).first<{ at: number | null }>(),
  ]);
  const seen = user?.app_seen_at ?? null;
  const pushed = push?.at ?? null;
  const lastSeenAt = seen || pushed ? Math.max(seen ?? 0, pushed ?? 0) : null;
  return { installed: lastSeenAt !== null, lastSeenAt, version: user?.app_version ?? null };
}
