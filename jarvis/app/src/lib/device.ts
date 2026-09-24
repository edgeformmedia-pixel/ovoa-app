import Constants from "expo-constants";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { api, serverOut } from "./api";
import * as clip from "./clip";
import { devlog } from "./devlog";
import { healthStatus, onHealthStatus } from "./healthSync";

// Telling the server what this phone has.
//
// The server decides how to reach the user — a silent buzz for the band, a
// notification without one — and it can't see the band, the Health permission
// or the location setting. So the app reports them: on launch, when the app
// comes forward, when the clip links or unlinks, and every few minutes while
// it's linked. That last one is what lets the server notice the app was killed:
// a band that stopped reporting is treated as gone (capabilities.ts, 15 min).

const HEARTBEAT_MS = 5 * 60_000;

const build = `${Constants.expoConfig?.version ?? "?"} ${Platform.OS} ${__DEV__ ? "dev" : "release"}`;

async function locationLevel(): Promise<"none" | "when_in_use" | "always"> {
  try {
    const bg = await Location.getBackgroundPermissionsAsync();
    if (bg.granted) return "always";
    const fg = await Location.getForegroundPermissionsAsync();
    return fg.granted ? "when_in_use" : "none";
  } catch {
    return "none";
  }
}

/**
 * What Apple Health comes to, from the last sync (healthSync.ts): readable,
 * something besides OVOA writing heart rate to it (a watch), and last night's
 * sleep. "health" was "the app isn't Expo Go" until 2026-09-23, so the server
 * was told every installed phone could read Health, whether or not reading was
 * allowed or anything was there.
 */
function healthFacts() {
  const s = healthStatus();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  // For the morning's readiness line, for accounts whose days don't reach the
  // server (no AI consent: extras.ts readiness reads health_days first). The
  // server keeps the last value sent (capabilities.ts COALESCE) and the
  // five-minute heartbeat makes it look fresh, so an old night must be
  // overwritten, not left out: 0 when the last sync found no night or ran
  // before midnight, which readiness skips (review, 2026-09-23). Left out only
  // when Health can't be read at all.
  const fresh = s.lastSyncAt !== null && s.lastSyncAt >= midnight.getTime();
  const sleepHours = s.reads !== "ok" ? undefined : fresh && s.lastNightSleepMin ? Math.round(s.lastNightSleepMin / 6) / 10 : 0;
  return { health: s.reads === "ok", watchHr: s.heartSources.length > 0, sleepHours };
}

/** The Health facts last reported, so a sync that changes none of them doesn't send a report. */
let reportedHealth = "";

export async function reportDeviceState(token: string) {
  try {
    const notifications = (await Notifications.getPermissionsAsync().catch(() => null))?.status;
    const health = healthFacts();
    await api.reportDevice(token, {
      bandLinked: clip.isLinked(),
      notifications: notifications === "granted" || notifications === "denied" ? notifications : "undetermined",
      location: await locationLevel(),
      buzzOption: clip.getBuzzOption(),
      build,
      ...health,
    });
    reportedHealth = JSON.stringify(health);
  } catch (err) {
    // Down for maintenance or no connection: api.ts said so once for the whole
    // outage, and the heartbeat is itself the retry that finds out it's over.
    // Logging it here too wrote an error every five minutes through the move
    // (device_logs, 2026-09-23 15:50-16:05).
    if (serverOut()) return;
    devlog("err", "couldn't report the phone's state", String(err));
  }
}

/** Starts reporting for a signed-in session. Returns a stop function. */
export function startDeviceReports(token: string) {
  void reportDeviceState(token);
  const offLink = clip.onLinkChange(() => void reportDeviceState(token));
  const app = AppState.addEventListener("change", (s) => {
    if (s === "active") void reportDeviceState(token);
  });
  // Health's facts are known only after a sync, which is usually after launch's report.
  const offHealth = onHealthStatus(() => {
    if (JSON.stringify(healthFacts()) !== reportedHealth) void reportDeviceState(token);
  });
  // Only while linked: the heartbeat exists to keep "the band is there" fresh.
  const beat = setInterval(() => {
    if (clip.isLinked()) void reportDeviceState(token);
  }, HEARTBEAT_MS);
  return () => {
    offLink();
    app.remove();
    offHealth();
    clearInterval(beat);
  };
}
