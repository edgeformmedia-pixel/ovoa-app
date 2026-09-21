import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { buzzPattern, isBuzzPattern } from "./buzz";
import * as clip from "./clip";
import { devlog } from "./devlog";

// What the server can ask the phone to do without the user looking.
//
// A silent push carries only data: { type: "buzz", ... } and so on. iOS hands it
// to this task when the app is suspended in the background, and to the ordinary
// listener when it is open; either way it lands in handlePush, once. iOS won't
// wake an app the user swiped away, and rations wakes for one it thinks is idle,
// so everything sent this way has a fallback on the server's side.
//
// defineTask has to run in the global scope of the bundle, before React mounts:
// iOS may start the app just to run it. That is why the root layout imports this
// file for its side effect.

export const BACKGROUND_PUSH_TASK = "ovoa-background-push";

export type PushPayload = { type: string; id?: string } & Record<string, unknown>;

/** `shown`: iOS already put this on screen as a notification, so the phone has been told. */
type Handler = (payload: PushPayload, shown: boolean) => Promise<void> | void;
const handlers = new Map<string, Handler>();

/** Lets another module (the command queue, say) take a push type. */
export function onPush(type: string, handler: Handler) {
  handlers.set(type, handler);
}

onPush("buzz", async (p, shown) => {
  // The server sent a visible notification because it thought there was no band.
  // If there really isn't one, that notification was the buzz; don't add a second.
  if (shown && !clip.isLinked()) return;
  const pattern = isBuzzPattern(p.pattern) ? p.pattern : "ack";
  await buzzPattern(pattern, typeof p.reason === "string" ? p.reason : "");
});

/** Ids already handled, so one push arriving by both routes runs once. */
const seen: string[] = [];

export async function handlePush(payload: PushPayload, via: string, shown = false) {
  if (payload.id) {
    if (seen.includes(payload.id)) return;
    seen.push(payload.id);
    if (seen.length > 50) seen.shift();
  }
  const handler = handlers.get(payload.type);
  devlog("push", `${payload.type} (${via})${handler ? "" : " — nothing handles this"}`, payload);
  try {
    await handler?.(payload, shown);
  } catch (err) {
    devlog("err", `push ${payload.type} failed`, String(err));
  }
}

/**
 * Finds our `{ type, ... }` inside whatever shape the push arrived in. The task
 * gets the raw APNs payload, which nests it differently from the listener and
 * sometimes as a JSON string, so this looks rather than assumes.
 */
export function pushPayload(raw: unknown, depth = 0): PushPayload | null {
  if (depth > 4 || raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return pushPayload(JSON.parse(raw), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type === "string" && obj.type !== "") return obj as PushPayload;
  for (const key of ["body", "data", "dataString", "payload"]) {
    const found = pushPayload(obj[key], depth + 1);
    if (found) return found;
  }
  return null;
}

TaskManager.defineTask<Notifications.NotificationTaskPayload>(BACKGROUND_PUSH_TASK, async ({ data, error }) => {
  if (error) {
    devlog("err", "background push task error", String(error));
    return;
  }
  const payload = pushPayload(data);
  if (payload) await handlePush(payload, "background");
});

/** Registers the task with iOS. Safe to call on every launch. */
export async function registerBackgroundPush() {
  try {
    await Notifications.registerTaskAsync(BACKGROUND_PUSH_TASK);
  } catch (err) {
    // Expo Go has no background notifications; the foreground path still works.
    devlog("warn", "background push task not registered", String(err));
  }
}

// The foreground half: the same payloads while the app is open.
Notifications.addNotificationReceivedListener((notification) => {
  const payload = pushPayload(notification.request.content.data);
  const { title, body } = notification.request.content;
  if (payload) void handlePush(payload, "foreground", !!(title || body));
});
