import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { api } from "./api";
import { devlog, logFail } from "./devlog";
import { onSignOut } from "./signOut";
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

/**
 * Registered in this launch already. Once a launch, whatever is saved: the server
 * forgets a token Expo reports dead (api/src/push.ts), and a phone that only
 * registered when its token changed never came back from that.
 */
let registeredThisLaunch = false;

/** A short tag for a session, so "registered for this sign-in" can be remembered without keeping the session twice. */
function sessionTag(apiToken: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < apiToken.length; i++) {
    h ^= apiToken.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// The saved registration names the push token only; this phone's next account
// must register it again under their own name.
onSignOut("push registration", () => {
  registeredThisLaunch = false;
  return storage.remove(TOKEN_KEY);
});

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
  | { ok: false; reason: "expo-go" | "no-project-id" | "denied" | "not-asked" | "failed"; detail?: string };

const projectId = () =>
  (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
  (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId;

/** Human-readable, for Settings and the Journal banner. */
export const pushProblem = (reason: Exclude<PushSetup, { ok: true }>["reason"], detail?: string) =>
  ({
    "expo-go": "Expo Go can't receive notifications — they work in the installed app.",
    "no-project-id": "Needs an Expo project id: run `eas init` in jarvis/app.",
    denied: "Notifications are turned off for OVOA in iOS Settings.",
    "not-asked": "Notifications aren't on for OVOA yet. They're asked for the first time something needs them.",
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
 *
 * `ask` false: registers only if notifications are already allowed, and shows
 * no prompt. That's the launch (lib/agent.tsx): "Not now" on the permissions
 * screen means not now, so the prompt waits for the permissions screen itself
 * or for the first thing that needs a notification (notificationsNeeded).
 */
export async function registerForPush(token: string, { ask = true }: { ask?: boolean } = {}): Promise<PushSetup> {
  const id = projectId();
  if (!id) {
    devlog("err", "push: no Expo project id in app.json (extra.eas.projectId)");
    return { ok: false, reason: "no-project-id" };
  }

  try {
    let { status } = await Notifications.getPermissionsAsync();
    if (status === "undetermined" && !ask) return { ok: false, reason: "not-asked" };
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
    // Told to the server when the token or the account is new, and once a launch.
    // Keyed on the token alone, a second account on this phone never registered,
    // and the first account's notifications kept arriving here.
    const saved = `${pushToken}|${sessionTag(token)}`;
    const known = await storage.get(TOKEN_KEY).catch(() => null);
    if (known !== saved || !registeredThisLaunch) {
      await api.registerPush(token, pushToken, Platform.OS);
      await storage.set(TOKEN_KEY, saved).catch(logFail("push: storage.set"));
      registeredThisLaunch = true;
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

let needing: Promise<void> | null = null;

/**
 * Something is being scheduled that only a notification can deliver (a dose,
 * an alarm's fallback). If notifications were never asked about, they're
 * asked for now, in the foreground, and the phone is registered for push on a
 * yes. Nothing when they've been answered either way. Never throws.
 */
export function notificationsNeeded(token: string) {
  needing ??= (async () => {
    try {
      if (AppState.currentState !== "active") return;
      const { status } = await Notifications.getPermissionsAsync();
      if (status === "undetermined") await registerForPush(token);
    } catch (err) {
      devlog("err", "notifications: couldn't ask", String(err));
    }
  })().finally(() => {
    needing = null;
  });
  return needing;
}

/** On sign-out, so the next person on this phone doesn't get their notes. */
export async function unregisterPush(token: string) {
  const known = await storage.get(TOKEN_KEY).catch(() => null);
  if (!known) return;
  // Saved as "token|session" since multi-account; plain token before.
  await api.unregisterPush(token, known.split("|")[0]).catch(logFail("push: api.unregisterPush"));
  await storage.remove(TOKEN_KEY).catch(logFail("push: storage.remove"));
}

/** Clears the little red number on the app icon. */
export const clearBadge = () => Notifications.setBadgeCountAsync(0).catch(logFail("push: Notifications.setBadgeCountAsync"));

/** Fires when the user taps a notification. Returns an unsubscribe. */
export function onNotificationTapped(handler: (data: Record<string, unknown>) => void) {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    handler((response.notification.request.content.data ?? {}) as Record<string, unknown>);
  });
  return () => sub.remove();
}
