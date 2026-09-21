import Constants from "expo-constants";
import * as Location from "expo-location";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { api } from "./api";
import * as clip from "./clip";
import { devlog } from "./devlog";
import { healthAvailable } from "./health";

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
    });
  } catch (err) {
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
