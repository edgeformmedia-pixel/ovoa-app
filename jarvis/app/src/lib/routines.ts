import * as Calendar from "expo-calendar/legacy";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { api, type Routine } from "./api";
import { savedToken } from "./auth";
import { onPush } from "./background";
import { buzzPattern } from "./buzz";
import * as clip from "./clip";
import { devlog } from "./devlog";
import { createSpeaker } from "./voice";

// The phone's half of routines and medications (server: api/src/routines.ts).
//
// Three jobs:
//
//   Mirror the "Medications" list in Apple Reminders to the server. Apple owns
//   that schedule; what it says wins. Meds added by voice or onboarding are
//   created there, and doses confirmed in OVOA are ticked off there.
//
//   Schedule the next two days of every routine as local notifications, with
//   Done and Snooze buttons. These fire with no network and no server, which is
//   the point: a medication reminder can't depend on a Worker being up. iOS keeps
//   at most 64 pending, so this takes 48 and leaves room for everything else.
//
//   Turn a Done or Snooze tap, and a notification arriving while the app is
//   open, into the right call and the right buzz.

export const MEDS_LIST = "Medications";
const HORIZON_MS = 48 * 3_600_000;
const MAX_SCHEDULED = 48;
const SNOOZE_MIN = 10;
const CATEGORY = "routine";
/** Re-sync on coming back to the app at most this often, unless the server says something changed. */
const RESYNC_MS = 6 * 3_600_000;

const TITLES: Record<Routine["kind"], string> = { med: "Medication", pet: "Pet", habit: "Reminder", custom: "Reminder" };

// ---------- Apple Reminders ----------

async function remindersAllowed(ask: boolean) {
  if (Platform.OS !== "ios") return false;
  const current = await Calendar.getRemindersPermissionsAsync().catch(() => null);
  if (current?.granted) return true;
  if (!ask) return false;
  return (await Calendar.requestRemindersPermissionsAsync().catch(() => null))?.granted ?? false;
}

async function medsList(create: boolean) {
  const lists = await Calendar.getCalendarsAsync(Calendar.EntityTypes.REMINDER);
  const found = lists.find((l) => l.title.trim().toLowerCase() === MEDS_LIST.toLowerCase());
  if (found || !create) return found?.id ?? null;
  // A new list goes in the same account as the default one (iCloud, usually).
  const fallback = lists.find((l) => l.allowsModifications) ?? lists[0];
  if (!fallback) return null;
  const id = await Calendar.createCalendarAsync({
    title: MEDS_LIST,
    entityType: Calendar.EntityTypes.REMINDER,
    sourceId: fallback.source?.id,
    source: fallback.source,
    color: "#22E2FF",
  });
  devlog("agent", `created the "${MEDS_LIST}" list in Reminders`);
  return id;
}

const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();

/**
 * The list, as routines: one per medication title, with every time it has.
 * Only repeating reminders count — a one-off "antibiotic at 8 tomorrow" is a
 * reminder, not a schedule, and turning it into a daily routine would be wrong.
 */
async function readMedsList(listId: string) {
  const reminders = await Calendar.getRemindersAsync([listId], Calendar.ReminderStatus.INCOMPLETE, null, null);
  const byTitle = new Map<string, { ids: string[]; times: number[]; days: number[] }>();
  for (const r of reminders) {
    const due = r.dueDate ? new Date(r.dueDate) : null;
    const rule = r.recurrenceRule;
    if (!due || !rule || (rule.frequency !== Calendar.Frequency.DAILY && rule.frequency !== Calendar.Frequency.WEEKLY)) continue;
    const title = (r.title ?? "").trim();
    if (!title || !r.id) continue;
    const days =
      rule.frequency === Calendar.Frequency.WEEKLY
        ? (rule.daysOfTheWeek?.length ? rule.daysOfTheWeek.map((d) => d.dayOfTheWeek - 1) : [due.getDay()])
        : [];
    const entry = byTitle.get(title) ?? { ids: [], times: [], days: [] };
    entry.ids.push(r.id);
    entry.times.push(minutesOf(due));
    entry.days = [...new Set([...entry.days, ...days])];
    byTitle.set(title, entry);
  }
  // A medication taken twice a day is two reminders; OVOA keeps it as one routine,
  // so its id on this side is every reminder's id, joined.
  return [...byTitle.entries()].map(([title, e]) => ({
    externalId: [...e.ids].sort().join("|"),
    title,
    times: [...new Set(e.times)],
    days: e.days.length === 7 ? [] : e.days,
  }));
}

/** Creates a medication's reminders: one repeating reminder per time of day. */
async function createInList(listId: string, r: { title: string; times: number[]; days: number[] }) {
  const ids: string[] = [];
  for (const t of r.times) {
    const due = new Date();
    due.setHours(Math.floor(t / 60), t % 60, 0, 0);
    if (due.getTime() < Date.now()) due.setDate(due.getDate() + 1);
    const id = await Calendar.createReminderAsync(listId, {
      title: r.title,
      dueDate: due,
      startDate: due,
      alarms: [{ relativeOffset: 0 }],
      recurrenceRule: r.days.length
        ? {
            frequency: Calendar.Frequency.WEEKLY,
            daysOfTheWeek: r.days.map((d) => ({ dayOfTheWeek: (d + 1) as Calendar.DayOfTheWeek })),
          }
        : { frequency: Calendar.Frequency.DAILY },
    });
    ids.push(id);
  }
  return ids.sort().join("|");
}

/**
 * Ticks off the reminder for a dose confirmed in OVOA: whichever of the
 * medication's reminders is at that time of day and hasn't already moved on.
 */
async function tickOff(externalId: string, dueAt: number) {
  const want = minutesOf(new Date(dueAt));
  for (const id of externalId.split("|")) {
    const r = await Calendar.getReminderAsync(id).catch(() => null);
    if (!r?.dueDate || r.completed) continue;
    const due = new Date(r.dueDate);
    // Already on to a later occurrence (ticked off in Reminders itself, say): leave it.
    if (minutesOf(due) !== want || due.getTime() > dueAt + 12 * 3_600_000) continue;
    await Calendar.updateReminderAsync(id, { completed: true, completionDate: new Date() });
    return true;
  }
  return false;
}

// ---------- Local notifications ----------

async function ensureCategory() {
  await Notifications.setNotificationCategoryAsync(CATEGORY, [
    { identifier: "done", buttonTitle: "Done", options: { opensAppToForeground: false } },
    { identifier: "snooze", buttonTitle: `Snooze ${SNOOZE_MIN} min`, options: { opensAppToForeground: false } },
  ]).catch((err) => devlog("err", "couldn't register the Done/Snooze buttons", String(err)));
}

/** Every occurrence in the next two days, worked out on the phone's own clock. */
function upcoming(r: Routine, from: number, to: number) {
  const out: number[] = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  for (let i = 0; i < 4; i++) {
    const d = new Date(day);
    d.setDate(day.getDate() + i);
    if (r.days.length && !r.days.includes(d.getDay())) continue;
    for (const t of r.times) {
      const at = new Date(d);
      at.setHours(Math.floor(t / 60), t % 60, 0, 0);
      if (at.getTime() > from && at.getTime() < to) out.push(at.getTime());
    }
  }
  return out;
}

async function scheduleLocal(token: string, routines: Routine[]) {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync().catch(() => []);
  await Promise.all(
    scheduled
      .filter((n) => (n.content.data as { type?: string } | undefined)?.type === "routine")
      .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {})),
  );

  const now = Date.now();
  const doneToday = new Set(routines.flatMap((r) => r.today.filter((e) => e.status === "done").map((e) => `${r.id}:${e.due_at}`)));
  const all = routines
    .flatMap((r) => upcoming(r, now, now + HORIZON_MS).map((dueAt) => ({ r, dueAt })))
    .filter(({ r, dueAt }) => !doneToday.has(`${r.id}:${dueAt}`))
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, MAX_SCHEDULED);

  for (const { r, dueAt } of all) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: TITLES[r.kind],
        body: r.title,
        categoryIdentifier: CATEGORY,
        sound: r.kind === "med" ? "default" : undefined,
        interruptionLevel: r.kind === "med" ? "timeSensitive" : "active",
        data: { type: "routine", routineId: r.id, dueAt, kind: r.kind, title: r.title },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(dueAt) },
    }).catch((err) => devlog("err", `couldn't schedule ${r.title}`, String(err)));
  }
  await api.routinesScheduled(token).catch(() => {});
  devlog("agent", `scheduled ${all.length} routine notification${all.length === 1 ? "" : "s"}`);
}

// ---------- Sync ----------

let lastSync = 0;
let syncing: Promise<void> | null = null;

/**
 * Reads Reminders, tells the server, does what it asks back, and reschedules
 * the notifications. `ask`: allowed to show the Reminders permission prompt
 * (onboarding); otherwise a phone without the permission just skips Apple and
 * schedules from the server's list.
 */
export function syncRoutines(token: string, { ask = false } = {}) {
  syncing ??= (async () => {
    try {
      await ensureCategory();
      let routines: Routine[];
      if (await remindersAllowed(ask)) {
        const listId = await medsList(false);
        const items = listId ? await readMedsList(listId) : [];
        const res = await api.syncRoutines(token, items);
        routines = res.routines;

        if (res.toCreate.length) {
          const target = listId ?? (await medsList(true));
          if (target) {
            for (const r of res.toCreate) {
              const externalId = await createInList(target, r).catch((err) => {
                devlog("err", `couldn't add ${r.title} to Reminders`, String(err));
                return null;
              });
              if (externalId) await api.routineExternal(token, r.id, externalId).catch(() => {});
            }
          }
        }

        const written: string[] = [];
        for (const w of res.toWriteBack) {
          if (await tickOff(w.externalId, w.dueAt).catch(() => false)) written.push(w.eventId);
          else written.push(w.eventId); // Already moved on there: nothing left to tick.
        }
        if (written.length) await api.routinesWrittenBack(token, written).catch(() => {});
      } else {
        routines = (await api.routines(token)).routines;
      }
      await scheduleLocal(token, routines);
      lastSync = Date.now();
    } catch (err) {
      devlog("err", "routine sync failed", String(err));
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/** Keeps routines in step while signed in: now, on coming back after a while, and when the server says so. */
export function startRoutineSync(token: string) {
  void syncRoutines(token);
  const app = AppState.addEventListener("change", (s) => {
    if (s === "active" && Date.now() - lastSync > RESYNC_MS) void syncRoutines(token);
  });
  return () => app.remove();
}

// ---------- Taps and arrivals ----------

type RoutineData = { type?: string; routineId?: string; dueAt?: number; eventId?: string; kind?: string; title?: string };

async function respond(action: string, data: RoutineData) {
  if (data.type !== "routine" || !data.routineId) return;
  const token = await savedToken();
  if (!token) return;
  const at = { dueAt: typeof data.dueAt === "number" ? data.dueAt : undefined, eventId: data.eventId };
  if (action === "done") {
    await api.confirmRoutine(token, data.routineId, { ...at, via: "notification" }).catch((err) =>
      devlog("err", "couldn't record the dose", String(err)),
    );
  } else if (action === "snooze") {
    await api.snoozeRoutine(token, data.routineId, { ...at, minutes: SNOOZE_MIN }).catch(() => {});
    // The phone's own copy too, so it comes back even offline.
    await Notifications.scheduleNotificationAsync({
      content: {
        title: data.kind === "med" ? "Medication" : "Reminder",
        body: `${data.title ?? "Reminder"} (snoozed)`,
        categoryIdentifier: CATEGORY,
        data: { ...data, type: "routine" },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: SNOOZE_MIN * 60 },
    }).catch(() => {});
  }
  devlog("push", `routine ${action}`, data);
}

// Registered at load, not in a component: tapping Done on a locked phone can
// start the app in the background just to handle it.
Notifications.addNotificationResponseReceivedListener((response) => {
  void respond(response.actionIdentifier, (response.notification.request.content.data ?? {}) as RoutineData);
});

// A routine notification arriving while the app is alive: tap the wrist too.
onPush("routine", async (p) => {
  if (!clip.isLinked()) return;
  const title = typeof p.title === "string" ? p.title : "Reminder";
  await buzzPattern(p.kind === "med" ? "meds" : "reminder", title);
});

// The server changed a routine (added by voice, say): catch up now rather than in six hours.
onPush("routines-changed", async () => {
  const token = await savedToken();
  if (token) await syncRoutines(token);
});

// An hour unconfirmed: the server asks for it to be said out loud.
onPush("speak", async (p) => {
  const token = await savedToken();
  if (!token || typeof p.text !== "string") return;
  await createSpeaker(token)
    .speak(p.text)
    .catch((err) => devlog("err", "couldn't say the follow-up", String(err)));
});
