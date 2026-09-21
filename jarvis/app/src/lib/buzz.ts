import * as Notifications from "expo-notifications";
import * as clip from "./clip";
import { devlog } from "./devlog";

// Buzzing the band on purpose: reminders, the agent, a server test.
//
// The ES100 freezes when it gets commands in quick succession (device_logs,
// 2026-09), so every patterned buzz goes through one queue that keeps them at
// least 30 s apart and drops a pattern that is already waiting. The single taps
// a band turn gives ("heard you") stay direct calls to clip.buzz: they answer a
// button press, and the queue leaves room for them by spacing itself from the
// clip's own last-buzz time.
//
// No band, or not linked right now: the same nudge goes to the phone as a local
// notification instead. That is the standalone rule — a buzz is never just lost.

export type BuzzPattern = "ack" | "double" | "reminder" | "meds" | "urgent";

const GAP_MS = 30_000;

/** How many vibrations each pattern is. The clip's own count argument does the spacing between them. */
const COUNTS: Record<BuzzPattern, number> = { ack: 1, double: 2, reminder: 2, meds: 3, urgent: 3 };

const TITLES: Record<BuzzPattern, string> = {
  ack: "OVOA",
  double: "OVOA",
  reminder: "Reminder",
  meds: "Medication",
  urgent: "OVOA — now",
};

type Waiting = { pattern: BuzzPattern; reason: string };
let waiting: Waiting[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export type BuzzOutcome = "buzzed" | "queued" | "dropped" | "notified";

/**
 * Buzzes the band with a pattern, or tells the phone instead. `reason` is what
 * the notification says when there's no band, and what goes in the log.
 */
export async function buzzPattern(pattern: BuzzPattern, reason = ""): Promise<BuzzOutcome> {
  if (!clip.isLinked()) {
    await notifyInstead(pattern, reason);
    return "notified";
  }
  if (waiting.some((w) => w.pattern === pattern)) {
    devlog("ble", `buzz ${pattern}: already waiting, dropped`, reason);
    return "dropped";
  }
  const wait = GAP_MS - (Date.now() - clip.lastBuzzAt());
  if (wait <= 0 && !waiting.length) {
    await fire({ pattern, reason });
    return "buzzed";
  }
  waiting.push({ pattern, reason });
  devlog("ble", `buzz ${pattern}: queued, ${Math.ceil(Math.max(wait, 0) / 1000)} s to go`, reason);
  schedule();
  return "queued";
}

function schedule() {
  if (timer || !waiting.length) return;
  const wait = Math.max(0, GAP_MS - (Date.now() - clip.lastBuzzAt()));
  timer = setTimeout(async () => {
    timer = null;
    const next = waiting.shift();
    if (next) {
      // The band may have gone while this waited: the phone gets it instead.
      if (clip.isLinked()) await fire(next);
      else await notifyInstead(next.pattern, next.reason);
    }
    schedule();
  }, wait);
}

async function fire({ pattern, reason }: Waiting) {
  const ok = await clip.buzz(COUNTS[pattern]);
  devlog("ble", `buzz ${pattern}: ${ok ? "sent" : "failed, notifying instead"}`, reason);
  if (!ok) await notifyInstead(pattern, reason);
}

async function notifyInstead(pattern: BuzzPattern, reason: string) {
  devlog("push", `buzz ${pattern}: no band, showing a notification`, reason);
  await Notifications.scheduleNotificationAsync({
    content: { title: TITLES[pattern], body: reason || "OVOA wanted your attention.", data: { type: "buzz-fallback" } },
    trigger: null,
  }).catch((err) => devlog("err", "couldn't show the buzz notification", String(err)));
}

export const isBuzzPattern = (value: unknown): value is BuzzPattern =>
  typeof value === "string" && value in COUNTS;
