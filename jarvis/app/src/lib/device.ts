import Constants from "expo-constants";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { api, serverOut } from "./api";
import * as clip from "./clip";
import { devlog } from "./devlog";
import { healthAvailable, todayHealth } from "./health";

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

let sleepRead = { at: 0, hours: undefined as number | undefined };

/** Read from Health at most once an hour: the heartbeat is every five minutes, and sleep doesn't change that fast. */
async function lastNightSleep() {
  if (!healthAvailable) return undefined;
  if (Date.now() - sleepRead.at > 3_600_000) {
    sleepRead = { at: Date.now(), hours: (await todayHealth().catch(() => null))?.sleepHours ?? undefined };
  }
  return sleepRead.hours;
}

export async function reportDeviceState(token: string) {
  try {
    const notifications = (await Notifications.getPermissionsAsync().catch(() => null))?.status;
    await api.reportDevice(token, {
      bandLinked: clip.isLinked(),
      notifications: notifications === "granted" || notifications === "denied" ? notifications : "undetermined",
      health: healthAvailable,
      location: await locationLevel(),
      buzzOption: clip.getBuzzOption(),
      build,
      // Last night's sleep, for the morning's readiness line. Only the phone can read it.
      sleepHours: await lastNightSleep(),
    });
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
  // Only while linked: the heartbeat exists to keep "the band is there" fresh.
  const beat = setInterval(() => {
    if (clip.isLinked()) void reportDeviceState(token);
  }, HEARTBEAT_MS);
  return () => {
    offLink();
    app.remove();
    clearInterval(beat);
  };
}
