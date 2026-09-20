import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { api } from "./api";
import { devlog } from "./devlog";
import { storage } from "./storage";

// Letting the agent reach the phone.
//
// Everything the agent decides is already saved on the server before this is
// involved, so a phone that can't be reached loses nothing — the note is
// waiting in the app on next open. That is deliberate: push is the fast path,
// not the record.
//
// Two things to know about where this does and doesn't work:
//
//   Expo Go can't receive remote notifications on recent SDKs. Push only works
//   in the built app (the Codemagic build), so in Expo Go this registers
//   nothing and says so in the log rather than failing.
//
//   getExpoPushTokenAsync needs an Expo project id. It comes from app.json
//   (extra.eas.projectId) and is written there by `eas init`. Without it there
//   is no token to register, which is a setup step rather than a bug, so it is
//   reported plainly instead of being swallowed.

const TOKEN_KEY = "ovoa.pushToken";

/** Notifications arriving while the app is open still show. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
});

export type PushSetup =
  | { ok: true; token: string }
  | { ok: false; reason: "expo-go" | "no-project-id" | "denied" | "failed"; detail?: string };

const projectId = () =>
  (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
  (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId;

/** Human-readable, for Settings and the Journal banner. */
export const pushProblem = (reason: Exclude<PushSetup, { ok: true }>["reason"], detail?: string) =>
  ({
    "expo-go": "Expo Go can't receive notifications — they work in the installed app.",
    "no-project-id": "Needs an Expo project id: run `eas init` in jarvis/app.",
    denied: "Notifications are turned off for OVOA in iOS Settings.",
    failed: detail ? `Couldn't register: ${detail.slice(0, 140)}` : "Couldn't register for notifications.",
  })[reason];

/**
 * Registers this phone with the server so the agent can reach it. Safe to call
 * on every launch: the token is stable and the server replaces the row.
 *
 * There is no check for Expo Go or for a simulator up front. `executionEnvironment`
 * reports Expo Go and a dev-client build identically, so it can't tell them
 * apart, and `Constants.isDevice` is gone in SDK 57. Asking for the token and
 * reading the error that comes back is both shorter and more accurate.
 */
export async function registerForPush(token: string): Promise<PushSetup> {
  const id = projectId();
  if (!id) {
    devlog("err", "push: no Expo project id in app.json (extra.eas.projectId)");
    return { ok: false, reason: "no-project-id" };
  }

  try {
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") ({ status } = await Notifications.requestPermissionsAsync());
    if (status !== "granted") {
      devlog("push", "notifications declined");
      return { ok: false, reason: "denied" };
    }

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "OVOA",
        importance: Notifications.AndroidImportance.DEFAULT,
        lightColor: "#22E2FF",
      });
    }

    const { data: pushToken } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    // Only tell the server when it's new: this runs on every launch.
    const known = await storage.get(TOKEN_KEY).catch(() => null);
    if (known !== pushToken) {
      await api.registerPush(token, pushToken, Platform.OS);
      await storage.set(TOKEN_KEY, pushToken).catch(() => {});
      devlog("push", "registered with the server");
    }
    return { ok: true, token: pushToken };
  } catch (err) {
    const detail = String(err);
    devlog("err", "push registration failed", detail);
    // Remote push was taken out of Expo Go in SDK 53, so this is the common case
    // in development and is worth naming rather than showing as a raw error.
    if (/Expo Go/i.test(detail)) return { ok: false, reason: "expo-go" };
    return { ok: false, reason: "failed", detail };
  }
}

/** On sign-out, so the next person on this phone doesn't get their notes. */
export async function unregisterPush(token: string) {
  const known = await storage.get(TOKEN_KEY).catch(() => null);
  if (!known) return;
  await api.unregisterPush(token, known).catch(() => {});
  await storage.remove(TOKEN_KEY).catch(() => {});
}

/** Clears the little red number on the app icon. */
export const clearBadge = () => Notifications.setBadgeCountAsync(0).catch(() => {});

/** Fires when the user taps a notification. Returns an unsubscribe. */
export function onNotificationTapped(handler: (data: Record<string, unknown>) => void) {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    handler((response.notification.request.content.data ?? {}) as Record<string, unknown>);
  });
  return () => sub.remove();
}
