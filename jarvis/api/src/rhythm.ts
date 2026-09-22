import { dailyRollup, logAction } from "./actionlog";
import { sendBuzz } from "./buzz";
import { validTimeZone } from "./google/assistant";
import { googleAccessToken, listGoogleAccounts } from "./google/oauth";
import { toolsByName } from "./google/tools";
import { generateText } from "./llm";
import { readiness, triageInbox } from "./extras";
import { distanceM } from "./location";
import { getProfile } from "./onboarding";
import { push } from "./push";
import { addDays, atLocalTime, buckets, clock, clockFromMinutes, dayRange, localMinutes, localWeekday } from "./time";
import { moneyBriefLine } from "./money";
import { listTodos } from "./todos";
import type { Env } from "./types";
import { inSlice, type Slice } from "./sweep";

// The daily rhythm (F18-F22). See migrations/0024_rhythm.sql.
//
// Each of these works with whatever the user has. The brief with no Google
// account reads routines and the list; with no location it skips the weather.
// The commute alert needs a calendar event with an address and some idea where
// they are, and quietly does nothing without both.

const DEFAULT_WAKE = 7 * 60;
const DEFAULT_SLEEP = 23 * 60;
/** The brief goes out once they seem to be up, and at the latest this long after their wake time. */
const BRIEF_LATEST_MIN = 60;
const WIND_DOWN_LEAD_MIN = 30;
/** How early to say "leave now" on top of the travel time. */
const LEAVE_BUFFER_MIN = 10;
/** How often a person's calendar is looked at for new places to get to. */
const COMMUTE_LOOK_MS = 30 * 60_000;
/** Leaving home twice in this long gets one checklist, not two. */
const CHECKLIST_GAP_MS = 30 * 60_000;
/** A usual thing counts as usual at this share of the days it could have happened. */
const EXPECT_SHARE = 0.8;
/** Public, keyless: OpenStreetMap's geocoder and OSRM's demo router. Enough for one person's calendar. */
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OSRM = "https://router.project-osrm.org/route/v1/driving";
const UA = "OVOA personal assistant (jarvis-api.edgeformmedia.workers.dev)";

async function mark(db: D1Database, userId: string, kind: string, day: string) {
  const res = await db.prepare("INSERT OR IGNORE INTO daily_marks (user_id, kind, day, at) VALUES (?, ?, ?, ?)").bind(userId, kind, day, Date.now()).run();
  return !!res.meta.changes;
}

/** Where they probably are: the last location point from the last two hours, else home. */
async function whereAbouts(db: D1Database, userId: string) {
  const point = await db
    .prepare("SELECT lat, lng FROM location_points WHERE user_id = ? AND ts > ? ORDER BY ts DESC LIMIT 1")
    .bind(userId, Date.now() - 2 * 3_600_000)
    .first<{ lat: number; lng: number }>();
  if (point) return point;
  return db.prepare("SELECT lat, lng FROM places WHERE user_id = ? AND kind = 'home' LIMIT 1").bind(userId).first<{ lat: number; lng: number }>();
}

// ---------- Weather ----------

const WEATHER_WORDS: Record<number, string> = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "foggy", 48: "foggy",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 80: "showers", 81: "showers", 82: "heavy showers",
  95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with hail",
};

/** Today's weather from Open-Meteo (no key). Null without a location, or if it doesn't answer. */
export async function weatherToday(lat: number, lng: number, timeZone: string) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=${encodeURIComponent(timeZone)}&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const d = ((await res.json()) as { daily?: Record<string, number[]> }).daily;
    if (!d) return null;
    return {
      summary: WEATHER_WORDS[d.weather_code?.[0]] ?? "mixed",
      highC: Math.round(d.temperature_2m_max?.[0]),
      lowC: Math.round(d.temperature_2m_min?.[0]),
      rainChance: d.precipitation_probability_max?.[0] ?? null,
    };
  } catch {
    return null;
  }
}

// ---------- Calendar (Google, when connected) ----------

async function upcomingEvents(env: Env, userId: string, from: number, to: number, timeZone: string) {
  const accounts = await listGoogleAccounts(env.DB, userId);
  const events: { id: string; title: string; start: string; location?: string; account: string }[] = [];
  for (const a of accounts.filter((a) => a.scopes.some((s) => s.includes("calendar")))) {
    try {
      const ctx = { token: await googleAccessToken(env, userId, a.id), timeZone };
      const list = (await toolsByName.get("calendar_list_events")!.run(ctx, {
        start: new Date(from).toISOString(),
        end: new Date(to).toISOString(),
        maxResults: 15,
      })) as { id: string; title: string; start: string; location?: string }[];
      events.push(...list.map((e) => ({ ...e, account: a.label ?? a.email })));
    } catch (err) {
      console.error("rhythm: couldn't read a calendar", err);
    }
  }
  return events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

// ---------- F18 Morning brief ----------

/** Everything the brief says, gathered; written up by the model, or read plainly if it's unavailable. */
export async function buildMorningBrief(env: Env, userId: string, timeZone: string) {
  const db = env.DB;
  const today = buckets(Date.now(), timeZone).day;
  const [from, to] = dayRange(today, timeZone);
  const spot = await whereAbouts(db, userId);
  const [weather, events, todos, meds, favors, user, inbox, ready, cash] = await Promise.all([
    spot ? weatherToday(spot.lat, spot.lng, timeZone) : null,
    upcomingEvents(env, userId, Date.now(), to, timeZone),
    listTodos(db, userId, today),
    db
      .prepare("SELECT title, times FROM routines WHERE user_id = ? AND active = 1 AND kind = 'med'")
      .bind(userId)
      .all<{ title: string; times: string }>(),
    db
      .prepare(
        "SELECT text, who FROM context_commitments WHERE user_id = ? AND status = 'open' AND origin = 'favor' AND (confidence IS NULL OR confidence >= 0.8) ORDER BY created_at DESC LIMIT 3",
      )
      .bind(userId)
      .all<{ text: string; who: string | null }>(),
    db.prepare("SELECT name FROM users WHERE id = ?").bind(userId).first<{ name: string }>(),
    triageInbox(env, userId).catch(() => []),
    readiness(env, userId, timeZone).catch(() => null),
    // Only when it's actually tight: a daily reading of the bank balance would
    // make the brief something people stop listening to.
    moneyBriefLine(db, userId, timeZone).catch(() => null),
  ]);
  const facts = {
    readiness: ready,
    money: cash,
    importantEmail: inbox,
    name: user?.name ?? null,
    weather: weather && { ...weather, highF: Math.round(weather.highC * 1.8 + 32), lowF: Math.round(weather.lowC * 1.8 + 32) },
    events: events.slice(0, 3).map((e) => `${e.start.includes("T") ? clock(Date.parse(e.start), timeZone) : "all day"} ${e.title}`),
    medsToday: meds.results.map((m) => `${m.title} at ${(JSON.parse(m.times) as number[]).map(clockFromMinutes).join(" and ")}`),
    topOfList: todos.filter((t) => !t.done).slice(0, 3).map((t) => t.text),
    askedOfYou: favors.results.map((f) => (f.who ? `${f.text} (for ${f.who})` : f.text)),
  };
  let text: string;
  try {
    text = (
      await generateText(env, {
        model: env.MEMORY_MODEL,
        fast: true,
        system:
          "Write a morning brief to be read aloud: under 30 seconds, plain spoken sentences, no lists or symbols. Lead with what's most likely to catch them out. Skip anything empty. Temperatures in Fahrenheit.",
        turns: [{ role: "user", text: JSON.stringify(facts) }],
      })
    ).trim();
  } catch {
    text = [
      facts.weather && `It's ${facts.weather.summary} today, ${facts.weather.highF} degrees.`,
      facts.events.length && `First up: ${facts.events.join(", ")}.`,
      facts.medsToday.length && `Meds: ${facts.medsToday.join("; ")}.`,
      facts.topOfList.length && `On your list: ${facts.topOfList.join(", ")}.`,
      facts.money,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return { text: text || "Nothing on today. Enjoy it.", facts };
}

/**
 * Sends the brief once a morning, when they seem to be up: the app opened, or
 * the band started reading heart rate, after half an hour before their wake
 * time; and in any case an hour after it.
 */
async function morningTick(env: Env, u: TickUser) {
  const now = Date.now();
  const wake = u.wake ?? DEFAULT_WAKE;
  const today = buckets(now, u.timeZone).day;
  const wakeAt = atLocalTime(today, wake, u.timeZone);
  if (now < wakeAt - 30 * 60_000 || now > wakeAt + 4 * 3_600_000) return false;
  const up =
    now >= wakeAt + BRIEF_LATEST_MIN * 60_000 ||
    (u.deviceSeen ?? 0) > wakeAt - 30 * 60_000 ||
    !!(await env.DB.prepare("SELECT 1 FROM hr_samples WHERE user_id = ? AND source = 'band' AND ts > ? LIMIT 1")
      .bind(u.userId, wakeAt - 30 * 60_000)
      .first());
  if (!up || !(await mark(env.DB, u.userId, "brief", today))) return false;
  const brief = await buildMorningBrief(env, u.userId, u.timeZone);
  await push(env, u.userId, { title: "Good morning", body: brief.text.slice(0, 180), data: { type: "brief" } });
  await push(env, u.userId, { silent: true, data: { type: "speak", id: crypto.randomUUID(), text: brief.text } });
  await sendBuzz(env, u.userId, "ack", "Morning brief", "system");
  await logAction(env.DB, u.userId, "brief", "Morning brief", "system");
  return true;
}

// ---------- F21 Wind-down ----------

async function windDownTick(env: Env, u: TickUser) {
  const now = Date.now();
  const sleep = u.sleep ?? DEFAULT_SLEEP;
  const today = buckets(now, u.timeZone).day;
  for (const evening of [addDays(today, -1), today]) {
    const bedtime = sleep >= 12 * 60 ? atLocalTime(evening, sleep, u.timeZone) : atLocalTime(addDays(evening, 1), sleep, u.timeZone);
    const at = bedtime - WIND_DOWN_LEAD_MIN * 60_000;
    if (now < at || now > at + 60 * 60_000 || !(await mark(env.DB, u.userId, "winddown", evening))) continue;
    const [rollup, tomorrow] = await Promise.all([
      dailyRollup(env.DB, u.userId, evening, u.timeZone),
      listTodos(env.DB, u.userId, addDays(evening, 1)),
    ]);
    const done = Object.values(rollup.counts).reduce((a, b) => a + b, 0);
    const first = tomorrow.filter((t) => !t.done).slice(0, 2).map((t) => t.text);
    const text = [
      done ? `Today OVOA handled ${done} thing${done === 1 ? "" : "s"} for you.` : "A quiet day.",
      first.length ? `Tomorrow starts with: ${first.join(", ")}.` : "",
      "Time to start winding down.",
    ]
      .filter(Boolean)
      .join(" ");
    await push(env, u.userId, { title: "Winding down", body: text.slice(0, 180), data: { type: "winddown" } });
    await logAction(env.DB, u.userId, "winddown", "Wind-down recap", "system");
    return true;
  }
  return false;
}

// ---------- F19 Leaving home ----------

/** Called from the geofence: leaving home gets a buzz and the checklist. */
export async function leavingHome(env: Env, userId: string) {
  const db = env.DB;
  const recent = await db
    .prepare("SELECT ts FROM action_log WHERE user_id = ? AND kind = 'checklist' AND ts > ? LIMIT 1")
    .bind(userId, Date.now() - CHECKLIST_GAP_MS)
    .first();
  if (recent) return false;
  const profile = await getProfile(db, userId);
  const list = profile.leavingChecklist?.length ? [...profile.leavingChecklist] : ["keys", "wallet", "phone"];
  // A medication due in the next two hours, not yet taken, goes on the list.
  const med = await db
    .prepare(
      `SELECT r.title FROM routines r WHERE r.user_id = ? AND r.kind = 'med' AND r.active = 1 AND r.next_due_at BETWEEN ? AND ?`,
    )
    .bind(userId, Date.now(), Date.now() + 2 * 3_600_000)
    .first<{ title: string }>();
  if (med) list.push(med.title);
  const line = `${list.slice(0, -1).join(", ")}${list.length > 1 ? " and " : ""}${list[list.length - 1]}?`;
  await sendBuzz(env, userId, "double", `Leaving: ${line}`, "system");
  await push(env, userId, { title: "Heading out?", body: line.replace(/^./, (c) => c.toUpperCase()), data: { type: "checklist" } });
  await logAction(db, userId, "checklist", `Leaving home: ${line}`, "system");
  return true;
}

// ---------- F20 Commute ----------

async function geocode(query: string) {
  const res = await fetch(`${NOMINATIM}?format=json&limit=1&q=${encodeURIComponent(query)}`, { headers: { "user-agent": UA } });
  if (!res.ok) return null;
  const [hit] = (await res.json()) as { lat: string; lon: string }[];
  return hit ? { lat: Number(hit.lat), lng: Number(hit.lon) } : null;
}

async function driveSeconds(from: { lat: number; lng: number }, to: { lat: number; lng: number }) {
  const res = await fetch(`${OSRM}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`, { headers: { "user-agent": UA } });
  if (!res.ok) return null;
  const route = ((await res.json()) as { routes?: { duration: number }[] }).routes?.[0];
  return route ? Math.round(route.duration) : null;
}

/**
 * For the next few hours' calendar events that have an address: works out the
 * drive once, and says "leave in 10 minutes" when it's time. Walking distance
 * (under a kilometre) gets nothing.
 */
async function commuteTick(env: Env, u: TickUser) {
  if (!u.google) return 0;
  const db = env.DB;
  const now = Date.now();
  const { results: known } = await db
    .prepare("SELECT event_id, leave_at, notified, title, travel_s, starts_at FROM commute_checks WHERE user_id = ? AND starts_at > ?")
    .bind(u.userId, now)
    .all<{ event_id: string; leave_at: number | null; notified: number; title: string; travel_s: number | null; starts_at: number }>();

  // New events are looked at every half hour at most per user; the rest of the time only the known ones are checked.
  // Claimed per half hour rather than read off commute_checks: that table only
  // gets a row when an upcoming event has a place, so for everyone else "when did
  // we last look" was always "never", and their calendar was fetched every tick.
  if (await mark(db, u.userId, "commute-look", String(Math.floor(now / COMMUTE_LOOK_MS)))) {
    const events = (await upcomingEvents(env, u.userId, now, now + 4 * 3_600_000, u.timeZone)).filter((e) => e.location && e.start.includes("T"));
    const from = await whereAbouts(db, u.userId);
    for (const e of events.slice(0, 3)) {
      if (known.some((k) => k.event_id === e.id)) continue;
      let travel: number | null = null;
      try {
        const to = from ? await geocode(e.location!) : null;
        if (from && to && distanceM(from, to) > 1000) travel = await driveSeconds(from, to);
      } catch (err) {
        console.error("rhythm: couldn't work out the drive", err);
      }
      const starts = Date.parse(e.start);
      await db
        .prepare(
          `INSERT OR REPLACE INTO commute_checks (user_id, event_id, title, starts_at, travel_s, leave_at, notified, checked_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .bind(u.userId, e.id, e.title ?? "your next event", starts, travel, travel ? starts - travel * 1000 : null, now)
        .run();
      if (travel) known.push({ event_id: e.id, leave_at: starts - travel * 1000, notified: 0, title: e.title, travel_s: travel, starts_at: starts });
    }
  }

  let sent = 0;
  for (const k of known) {
    if (k.notified || !k.leave_at || !k.travel_s) continue;
    // Each person is looked at every ten minutes now (sweep.ts), so the window opens
    // a little earlier and the line says how long there really is.
    if (now < k.leave_at - (LEAVE_BUFFER_MIN + 5) * 60_000 || now > k.starts_at) continue;
    const { meta } = await db
      .prepare("UPDATE commute_checks SET notified = 1 WHERE user_id = ? AND event_id = ? AND notified = 0")
      .bind(u.userId, k.event_id)
      .run();
    if (!meta.changes) continue;
    const minutes = Math.round(k.travel_s / 60);
    const left = Math.max(1, Math.round((k.leave_at - now) / 60_000));
    const line = `Leave in ${left} minute${left === 1 ? "" : "s"} for ${k.title} at ${clock(k.starts_at, u.timeZone)} — about ${minutes} min drive.`;
    await sendBuzz(env, u.userId, "double", line, "system");
    await push(env, u.userId, { title: "Time to go soon", body: line, urgent: true, data: { type: "commute" } });
    await logAction(db, u.userId, "commute", line, "system");
    sent++;
  }
  return sent;
}

// ---------- F22 Oddities ----------

type Expectation = {
  kind: "visit" | "workout" | "left_home";
  placeId: string | null;
  what: string;
  windowStart: number;
  windowEnd: number;
  days: number[];
  strength: number;
};

/**
 * What happens on most days it could: for each place (and for workouts), the
 * weekdays it happened on in the last two weeks, and the usual time. Pure.
 */
export function learnExpectations(
  events: { kind: Expectation["kind"]; placeId: string | null; label: string; at: number }[],
  from: number,
  to: number,
  timeZone: string,
): Expectation[] {
  const groups = new Map<string, typeof events>();
  for (const e of events) {
    const key = `${e.kind}|${e.placeId ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const out: Expectation[] = [];
  for (const list of groups.values()) {
    // Weekdays and weekends behave differently; each is judged on its own.
    for (const set of [[1, 2, 3, 4, 5], [0, 6]]) {
      const possible = new Set<string>();
      for (let t = from; t < to; t += 86_400_000) {
        if (set.includes(localWeekday(t, timeZone))) possible.add(buckets(t, timeZone).day);
      }
      const hits = list.filter((e) => set.includes(localWeekday(e.at, timeZone)));
      const days = new Set(hits.map((e) => buckets(e.at, timeZone).day));
      if (possible.size < 3 || days.size / possible.size < EXPECT_SHARE) continue;
      const mins = hits.map((e) => localMinutes(e.at, timeZone)).sort((a, b) => a - b);
      const median = mins[Math.floor(mins.length / 2)];
      out.push({
        kind: list[0].kind,
        placeId: list[0].placeId,
        what: list[0].label,
        windowStart: Math.max(0, median - 30),
        windowEnd: Math.min(24 * 60 - 1, median + 90),
        days: set,
        strength: Math.round((days.size / possible.size) * 100) / 100,
      });
    }
  }
  return out;
}

/** Nightly: relearns each user's expectations from the last two weeks. */
export async function learnAllExpectations(env: Env) {
  const db = env.DB;
  const to = Date.now();
  const from = to - 14 * 86_400_000;
  const { results: users } = await db
    .prepare("SELECT DISTINCT v.user_id, s.time_zone FROM visits v JOIN settings s ON s.user_id = v.user_id WHERE v.arrived > ?")
    .bind(from)
    .all<{ user_id: string; time_zone: string | null }>();
  let learned = 0;
  for (const u of users) {
    const timeZone = validTimeZone(u.time_zone);
    const [{ results: visits }, { results: workouts }] = await Promise.all([
      db
        .prepare(
          `SELECT v.arrived, p.id AS place_id, p.name, p.kind FROM visits v JOIN places p ON p.id = v.place_id
            WHERE v.user_id = ? AND v.arrived > ? AND v.left_at - v.arrived >= 600000 AND p.kind != 'home'`,
        )
        .bind(u.user_id, from)
        .all<{ arrived: number; place_id: string; name: string | null; kind: string }>(),
      db.prepare("SELECT start_at FROM workouts WHERE user_id = ? AND start_at > ?").bind(u.user_id, from).all<{ start_at: number }>(),
    ]);
    const events = [
      ...visits.map((v) => ({ kind: "visit" as const, placeId: v.place_id, label: `going to ${v.name ?? (v.kind === "other" ? "your usual spot" : `the ${v.kind}`)}`, at: v.arrived })),
      ...workouts.map((w) => ({ kind: "workout" as const, placeId: null, label: "working out", at: w.start_at })),
    ];
    const found = learnExpectations(events, from, to, timeZone);
    await db.prepare("DELETE FROM expectations WHERE user_id = ?").bind(u.user_id).run();
    for (const e of found) {
      await db
        .prepare(
          "INSERT INTO expectations (id, user_id, kind, place_id, what, window_start, window_end, days, strength, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(crypto.randomUUID(), u.user_id, e.kind, e.placeId, e.what, e.windowStart, e.windowEnd, JSON.stringify(e.days), e.strength, Date.now())
        .run();
      learned++;
    }
  }
  return learned;
}

/** A usual thing whose window passed today with no sign of it: asked about, once. */
async function oddityTick(env: Env, u: TickUser) {
  const db = env.DB;
  const now = Date.now();
  const today = buckets(now, u.timeZone).day;
  const minute = localMinutes(now, u.timeZone);
  const weekday = localWeekday(now, u.timeZone);
  const { results } = await db
    .prepare("SELECT * FROM expectations WHERE user_id = ? AND (asked_day IS NULL OR asked_day != ?) AND window_end <= ?")
    .bind(u.userId, today, minute)
    .all<{ id: string; kind: string; place_id: string | null; what: string; window_start: number; window_end: number; days: string }>();
  let asked = 0;
  for (const e of results) {
    if (!(JSON.parse(e.days) as number[]).includes(weekday)) continue;
    // Only just passed: an expectation from this morning isn't brought up at night.
    if (minute - e.window_end > 60) continue;
    const start = atLocalTime(today, e.window_start - 60, u.timeZone);
    const happened =
      e.kind === "visit"
        ? await db.prepare("SELECT 1 FROM visits WHERE user_id = ? AND place_id = ? AND left_at > ? LIMIT 1").bind(u.userId, e.place_id, start).first()
        : await db.prepare("SELECT 1 FROM workouts WHERE user_id = ? AND end_at > ? LIMIT 1").bind(u.userId, start).first();
    await db.prepare("UPDATE expectations SET asked_day = ? WHERE id = ?").bind(today, e.id).run();
    if (happened) continue;
    await push(env, u.userId, {
      title: "Different day?",
      body: `You're usually ${e.what} around ${clockFromMinutes(e.window_start + 30)}. Everything alright — or skipping today?`,
      data: { type: "oddity", expectationId: e.id },
    });
    await logAction(db, u.userId, "oddity", `Noticed: not ${e.what} today`, "system", e.id);
    asked++;
  }
  return asked;
}

// ---------- In conversation ----------

export const briefTool = {
  name: "morning_brief",
  description: "Builds the morning brief now — weather, first events, meds, top of the list, what people asked — for 'brief me', 'what's my day look like'.",
  parameters: { type: "object", properties: {} },
};

// ---------- The tick ----------

type TickUser = {
  userId: string;
  timeZone: string;
  wake: number | null;
  sleep: number | null;
  deviceSeen: number | null;
  google: boolean;
};

/** Every two minutes, for everyone the phone can reach. */
export async function rhythmTick(env: Env, slice?: Slice) {
  const { results } = await env.DB.prepare(
    `SELECT s.user_id, s.time_zone, p.wake_time, p.sleep_time, d.updated_at AS device_seen,
            EXISTS (SELECT 1 FROM google_accounts g WHERE g.user_id = s.user_id) AS google
       FROM settings s
       LEFT JOIN profile p ON p.user_id = s.user_id
       LEFT JOIN device_state d ON d.user_id = s.user_id
      WHERE EXISTS (SELECT 1 FROM push_tokens t WHERE t.user_id = s.user_id)`,
  ).all<{ user_id: string; time_zone: string | null; wake_time: number | null; sleep_time: number | null; device_seen: number | null; google: number }>();
  const counts = { briefs: 0, windDowns: 0, commutes: 0, oddities: 0 };
  for (const r of results) {
    if (!inSlice(r.user_id, slice)) continue;
    const u: TickUser = {
      userId: r.user_id,
      timeZone: validTimeZone(r.time_zone),
      wake: r.wake_time,
      sleep: r.sleep_time,
      deviceSeen: r.device_seen,
      google: !!r.google,
    };
    try {
      if (await morningTick(env, u)) counts.briefs++;
      if (await windDownTick(env, u)) counts.windDowns++;
      counts.commutes += await commuteTick(env, u);
      counts.oddities += await oddityTick(env, u);
    } catch (err) {
      console.error(`rhythm: tick failed for ${r.user_id}`, err);
    }
  }
  return counts;
}
