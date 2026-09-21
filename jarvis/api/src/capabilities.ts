import { z } from "zod";

// What this user has, so every feature can pick its path instead of failing.
//
// The rule (docs/feature-plan.md, "Standalone rule"): a feature declares what it
// needs and what improves it, and degrades when the improvement is missing. No
// band means a phone notification instead of a buzz. No Google means the
// phone's own Reminders. No watch means asking instead of detecting. This is the
// one place those facts are read, so the branches agree with each other.

/** A band last reported longer ago than this is treated as gone: the app was probably killed. */
export const BAND_FRESH_MS = 15 * 60_000;

export type Capabilities = {
  /** A clip is linked and the app said so recently enough to trust. */
  band: boolean;
  /** At least one Google account connected. */
  google: boolean;
  /** Apple Health is readable on the phone. */
  health: boolean;
  /** Something writes heart rate to Health (a watch). The ES100 has no heart-rate sensor. */
  watchHr: boolean;
  locationAlways: boolean;
  /** Dev-only capture of everything, for the [AL] experiments. Never on for anyone else. */
  ambient: boolean;
  /** The phone can be reached by push at all. */
  push: boolean;
};

export const deviceStateSchema = z.object({
  bandLinked: z.boolean(),
  notifications: z.enum(["granted", "denied", "undetermined"]).optional(),
  health: z.boolean().optional(),
  watchHr: z.boolean().optional(),
  location: z.enum(["none", "when_in_use", "always"]).optional(),
  buzzOption: z.number().int().min(1).max(3).optional(),
  build: z.string().max(64).optional(),
});

export async function saveDeviceState(db: D1Database, userId: string, s: z.infer<typeof deviceStateSchema>) {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO device_state (user_id, band_linked, band_seen_at, notifications, health, watch_hr, location, buzz_option, app_build, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         band_linked = excluded.band_linked,
         band_seen_at = COALESCE(excluded.band_seen_at, device_state.band_seen_at),
         notifications = COALESCE(excluded.notifications, device_state.notifications),
         health = excluded.health,
         watch_hr = excluded.watch_hr,
         location = COALESCE(excluded.location, device_state.location),
         buzz_option = COALESCE(excluded.buzz_option, device_state.buzz_option),
         app_build = COALESCE(excluded.app_build, device_state.app_build),
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      Number(s.bandLinked),
      s.bandLinked ? now : null,
      s.notifications ?? null,
      Number(!!s.health),
      Number(!!s.watchHr),
      s.location ?? null,
      s.buzzOption ?? null,
      s.build ?? null,
      now,
    )
    .run();
}

export async function capabilities(db: D1Database, userId: string): Promise<Capabilities> {
  const [device, google, push, settings] = await Promise.all([
    db
      .prepare("SELECT band_linked, band_seen_at, health, watch_hr, location FROM device_state WHERE user_id = ?")
      .bind(userId)
      .first<{ band_linked: number; band_seen_at: number | null; health: number; watch_hr: number; location: string | null }>(),
    db.prepare("SELECT 1 FROM google_accounts WHERE user_id = ? LIMIT 1").bind(userId).first(),
    db.prepare("SELECT 1 FROM push_tokens WHERE user_id = ? AND fail_count < 3 LIMIT 1").bind(userId).first(),
    db.prepare("SELECT capture_everything FROM settings WHERE user_id = ?").bind(userId).first<{ capture_everything: number }>(),
  ]);
  return {
    band: !!device?.band_linked && !!device.band_seen_at && Date.now() - device.band_seen_at < BAND_FRESH_MS,
    google: !!google,
    health: !!device?.health,
    watchHr: !!device?.watch_hr,
    locationAlways: device?.location === "always",
    ambient: !!settings?.capture_everything,
    push: !!push,
  };
}
