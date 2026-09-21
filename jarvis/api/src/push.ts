import type { Env } from "./types";

// Expo push notifications: the only way an agent that works while the app is
// closed can say anything. Without this the whole agent is a tree falling in a
// forest, so it is deliberately forgiving — a failed push never fails the run
// that produced it, because the note is already saved and the app will show it
// on next open regardless.

const EXPO_SEND = "https://exp.host/--/api/v2/push/send";
/** Expo accepts 100 messages per request. */
const CHUNK = 100;
/** A token that has failed this many times in a row is assumed gone. */
const MAX_FAILS = 3;

export type PushMessage = {
  title: string;
  body: string;
  /** Opens the right screen when tapped. */
  data?: Record<string, unknown>;
  /** High-urgency notes interrupt; everything else arrives quietly. */
  urgent?: boolean;
};

/**
 * A push nobody sees: it wakes the app's background task with `data` and shows
 * nothing. iOS decides whether to deliver it at all — never to an app the user
 * swiped away, and sparingly to one it thinks is idle — so anything sent this
 * way must also be safe to miss, with a queue or a visible fallback behind it.
 */
export type SilentPush = { silent: true; data: Record<string, unknown> };

type ExpoTicket = { status: "ok" | "error"; id?: string; details?: { error?: string } };

export async function registerPushToken(db: D1Database, userId: string, token: string, platform?: string) {
  // The same token can move between accounts on a shared phone, so the row is
  // replaced rather than ignored.
  await db
    .prepare(
      `INSERT INTO push_tokens (token, user_id, platform, created_at, fail_count)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, fail_count = 0`,
    )
    .bind(token, userId, platform ?? null, Date.now())
    .run();
}

export async function forgetPushToken(db: D1Database, userId: string, token: string) {
  await db.prepare("DELETE FROM push_tokens WHERE token = ? AND user_id = ?").bind(token, userId).run();
}

async function tokensFor(db: D1Database, userId: string) {
  const { results } = await db
    .prepare("SELECT token FROM push_tokens WHERE user_id = ? AND fail_count < ?")
    .bind(userId, MAX_FAILS)
    .all<{ token: string }>();
  return results.map((r) => r.token);
}

/**
 * Sends one notification to every device the user has. Returns how many were
 * accepted; zero is normal and not an error (no app installed yet, notifications
 * declined, phone reinstalled).
 */
export async function push(env: Env, userId: string, message: PushMessage | SilentPush): Promise<number> {
  const tokens = await tokensFor(env.DB, userId);
  if (!tokens.length) return 0;

  let accepted = 0;
  const dead: string[] = [];
  const failed: string[] = [];

  for (let i = 0; i < tokens.length; i += CHUNK) {
    const batch = tokens.slice(i, i + CHUNK);
    const body = batch.map((to) =>
      "silent" in message
        ? // Data only, no title or body: that is what makes it content-available on iOS.
          { to, data: message.data, _contentAvailable: true, priority: "high" }
        : {
            to,
            title: message.title,
            body: message.body,
            sound: message.urgent ? "default" : null,
            // Urgent notes wake the screen; the rest wait for the user to look.
            priority: message.urgent ? "high" : "normal",
            ...(message.urgent && { interruptionLevel: "time-sensitive" }),
            ...(message.data && { data: message.data }),
          },
    );

    let tickets: ExpoTicket[];
    try {
      const res = await fetch(EXPO_SEND, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error(`push: Expo ${res.status}`, (await res.text()).slice(0, 300));
        failed.push(...batch);
        continue;
      }
      tickets = ((await res.json()) as { data?: ExpoTicket[] }).data ?? [];
    } catch (err) {
      console.error("push: send failed", err);
      failed.push(...batch);
      continue;
    }

    tickets.forEach((ticket, n) => {
      const token = batch[n];
      if (ticket.status === "ok") {
        accepted++;
        return;
      }
      // The app was deleted or the token was re-issued: stop trying entirely.
      if (ticket.details?.error === "DeviceNotRegistered") dead.push(token);
      else failed.push(token);
    });
  }

  const db = env.DB;
  const now = Date.now();
  const writes: D1PreparedStatement[] = [];
  const ok = tokens.filter((t) => !dead.includes(t) && !failed.includes(t));
  if (ok.length) {
    writes.push(
      db
        .prepare(`UPDATE push_tokens SET last_ok_at = ?, fail_count = 0 WHERE token IN (${ok.map(() => "?").join(",")})`)
        .bind(now, ...ok),
    );
  }
  if (dead.length) {
    writes.push(db.prepare(`DELETE FROM push_tokens WHERE token IN (${dead.map(() => "?").join(",")})`).bind(...dead));
  }
  if (failed.length) {
    writes.push(
      db
        .prepare(`UPDATE push_tokens SET fail_count = fail_count + 1 WHERE token IN (${failed.map(() => "?").join(",")})`)
        .bind(...failed),
    );
  }
  if (writes.length) await db.batch(writes);

  return accepted;
}
