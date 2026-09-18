import * as Calendar from "expo-calendar/legacy";
import { Platform } from "react-native";

/** The iPhone's Calendar and Reminders apps. Uses the legacy API because the new one isn't in Expo Go. */

const onlyOnPhone = () => {
  if (Platform.OS === "web") throw new Error("Calendar and Reminders only work in the iPhone app.");
};

async function calendarAccess() {
  onlyOnPhone();
  const { granted } = await Calendar.requestCalendarPermissionsAsync();
  if (!granted) throw new Error("OVOA doesn't have access to Calendar. Allow it in iPhone Settings → OVOA.");
}

async function remindersAccess() {
  onlyOnPhone();
  const { granted } = await Calendar.requestRemindersPermissionsAsync();
  if (!granted) throw new Error("OVOA doesn't have access to Reminders. Allow it in iPhone Settings → OVOA.");
}

const isDateOnly = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** "2026-09-18T15:00" is local time; "2026-09-18" is local midnight. */
export function localDate(s: string) {
  const d = isDateOnly(s) ? new Date(`${s}T00:00:00`) : new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Couldn't understand the time "${s}"`);
  return d;
}

const addHours = (d: Date, h: number) => new Date(d.getTime() + h * 3600_000);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);

/** Local time without an offset, which is what the assistant reads and writes. */
function localIso(value: string | Date) {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- Events ----------

export async function listEvents({ start, end, query }: { start: string; end: string; query?: string }) {
  await calendarAccess();
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const events = await Calendar.getEventsAsync(
    calendars.map((c) => c.id),
    localDate(start),
    isDateOnly(end) ? addDays(localDate(end), 1) : localDate(end),
  );
  const names = new Map(calendars.map((c) => [c.id, c.title]));
  const q = query?.toLowerCase();
  return events
    .filter((e) => !q || e.title.toLowerCase().includes(q))
    .slice(0, 100)
    .map((e) => ({
      id: e.id,
      title: e.title,
      start: localIso(e.startDate),
      end: localIso(e.endDate),
      allDay: e.allDay,
      location: e.location || undefined,
      notes: e.notes ? e.notes.slice(0, 300) : undefined,
      calendar: names.get(e.calendarId),
    }));
}

type EventArgs = {
  title?: string;
  start?: string;
  end?: string;
  location?: string;
  notes?: string;
  alertMinutes?: number;
};

function eventTimes(a: EventArgs) {
  if (!a.start) return {};
  const allDay = isDateOnly(a.start);
  const startDate = localDate(a.start);
  const endDate = a.end
    ? localDate(a.end)
    : allDay
      ? startDate
      : addHours(startDate, 1);
  if (endDate < startDate) throw new Error("The event ends before it starts.");
  return { startDate, endDate, allDay };
}

export async function createEvent(a: EventArgs & { title: string; start: string }) {
  await calendarAccess();
  const calendar = await Calendar.getDefaultCalendarAsync();
  await Calendar.createEventAsync(calendar.id, {
    title: a.title,
    ...eventTimes(a),
    location: a.location,
    notes: a.notes,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    alarms: a.alertMinutes != null ? [{ relativeOffset: -a.alertMinutes }] : undefined,
  });
  return `added "${a.title}" to your calendar`;
}

export async function updateEvent(a: EventArgs & { eventId: string; eventTitle: string }) {
  await calendarAccess();
  const current = await Calendar.getEventAsync(a.eventId);
  let times = eventTimes(a);
  if (!a.start && a.end) {
    // Only the end changes.
    times = { startDate: new Date(current.startDate), endDate: localDate(a.end), allDay: current.allDay };
  }
  await Calendar.updateEventAsync(a.eventId, {
    ...(a.title && { title: a.title }),
    ...times,
    ...(a.location && { location: a.location }),
    ...(a.notes && { notes: a.notes }),
  });
  return `updated "${a.title ?? current.title}"`;
}

export async function deleteEvent(a: { eventId: string; eventTitle: string }) {
  await calendarAccess();
  await Calendar.deleteEventAsync(a.eventId);
  return `deleted "${a.eventTitle}" from your calendar`;
}

// ---------- Reminders ----------

export async function listReminders({ includeCompleted }: { includeCompleted?: boolean }) {
  await remindersAccess();
  const lists = await Calendar.getCalendarsAsync(Calendar.EntityTypes.REMINDER);
  const ids = lists.map((l) => l.id);
  const names = new Map(lists.map((l) => [l.id, l.title]));
  const open = await Calendar.getRemindersAsync(ids, Calendar.ReminderStatus.INCOMPLETE, null, null);
  const done = includeCompleted
    ? await Calendar.getRemindersAsync(ids, Calendar.ReminderStatus.COMPLETED, addDays(new Date(), -7), new Date())
    : [];
  return [...open, ...done].slice(0, 100).map((r) => ({
    id: r.id,
    title: r.title,
    due: r.dueDate ? localIso(r.dueDate) : undefined,
    completed: !!r.completed,
    notes: r.notes ? r.notes.slice(0, 300) : undefined,
    list: r.calendarId ? names.get(r.calendarId) : undefined,
  }));
}

export async function createReminder(a: { title: string; due?: string; notes?: string }) {
  await remindersAccess();
  const due = a.due ? localDate(a.due) : undefined;
  await Calendar.createReminderAsync(null, {
    title: a.title,
    notes: a.notes,
    dueDate: due,
    startDate: due,
    // Alert at the due time unless it's a whole day.
    alarms: due && !isDateOnly(a.due!) ? [{ relativeOffset: 0 }] : undefined,
  });
  return `added reminder "${a.title}"`;
}

export async function completeReminder(a: { reminderId: string; reminderTitle: string }) {
  await remindersAccess();
  await Calendar.updateReminderAsync(a.reminderId, { completed: true, completionDate: new Date() });
  return `marked "${a.reminderTitle}" as done`;
}
