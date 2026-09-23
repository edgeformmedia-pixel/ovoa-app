import { Hono } from "hono";
import { z } from "zod";
import { logAction } from "./actionlog";
import { validTimeZone } from "./google/assistant";
import type { CallTool, ToolSpec } from "./llm";
import { push } from "./push";
import { buckets, clock, dayRange, localMinutes, localWeekday } from "./time";
import type { Env, Vars } from "./types";

// The location timeline (F10). See migrations/0020_location.sql.
//
// Points become visits as they arrive; visits become places once a night. The
// phone does the geocoding (its own, free, no key) and the geofencing (iOS
// watches up to 20 regions for us), so the server only ever does arithmetic.
//
// Points, visits and place events are deleted after 14 days by the nightly purge
// (retention.ts). Places with a name (theirs, or Home and Work) stay until the
// user removes them; an unnamed one goes once nobody has been there for 14 days.

/** A point this close to the visit in progress extends it. */
export const VISIT_RADIUS_M = 150;
/** A gap longer than this with no points ends a visit, even at the same spot. */
const VISIT_GAP_MS = 45 * 60_000;
/** Shorter than this is passing through, not a visit. */
export const MIN_VISIT_MS = 5 * 60_000;
/** Visits within this of each other are the same place. */
const CLUSTER_M = 100;
/** Seen on this many different days before it's worth calling a place. */
const PLACE_DAYS = 3;
/** Points and visits are kept this long (retention.ts purges them); named places are kept for good. */
export const LOCATION_RETAIN_DAYS = 14;
/** iOS watches at most 20 regions per app. */
export const MAX_GEOFENCES = 20;

export type Point = { ts: number; lat: number; lng: number; accuracy?: number | null; speed?: number | null };
export type Visit = { id: string; lat: number; lng: number; arrived: number; left_at: number; points: number; place_id: string | null };
export type Place = {
  id: string;
  name: string | null;
  kind: "home" | "work" | "gym" | "other";
  lat: number;
  lng: number;
  radius: number;
  address: string | null;
  visit_count: number;
};

/** Metres between two points on the Earth. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Folds new points into visits. `open` is the latest visit, if any. Returns the
 * visits that changed or were started, the open one last. Pure, so the rules
 * can be tested without a database.
 */
export function foldPoints(open: Visit | null, points: Point[], newId: () => string) {
  const changed = new Map<string, Visit>();
  let current = open ? { ...open } : null;
  for (const p of [...points].sort((a, b) => a.ts - b.ts)) {
    // Very inaccurate fixes (cell towers) move the centre around without meaning anything.
    if (p.accuracy != null && p.accuracy > 250) continue;
    if (current && p.ts >= current.left_at && p.ts - current.left_at <= VISIT_GAP_MS && distanceM(current, p) <= VISIT_RADIUS_M) {
      const n = current.points + 1;
      current = {
        ...current,
        lat: current.lat + (p.lat - current.lat) / n,
        lng: current.lng + (p.lng - current.lng) / n,
        left_at: p.ts,
        points: n,
      };
    } else if (!current || p.ts > current.left_at) {
      current = { id: newId(), lat: p.lat, lng: p.lng, arrived: p.ts, left_at: p.ts, points: 1, place_id: null };
    } else {
      continue; // Older than the visit in progress: already accounted for.
    }
    changed.set(current.id, current);
  }
  return [...changed.values()];
}

/** The place a spot belongs to, if any: the nearest one within its radius. */
export function placeFor(spot: { lat: number; lng: number }, places: Place[]) {
  let best: Place | null = null;
  let bestD = Infinity;
  for (const p of places) {
    const d = distanceM(spot, p);
    if (d <= Math.max(p.radius, CLUSTER_M) && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/**
 * Groups visits that keep happening at the same spot. Returns clusters seen on
 * at least PLACE_DAYS different days, with a guess at what they are: mostly
 * overnight is home, mostly weekday working hours is work.
 */
export function findPlaces(visits: Visit[], timeZone: string) {
  const clusters: { lat: number; lng: number; visits: Visit[] }[] = [];
  for (const v of visits) {
    if (v.left_at - v.arrived < 10 * 60_000) continue;
    const c = clusters.find((c) => distanceM(c, v) <= CLUSTER_M);
    if (c) {
      c.visits.push(v);
      const n = c.visits.length;
      c.lat += (v.lat - c.lat) / n;
      c.lng += (v.lng - c.lng) / n;
    } else {
      clusters.push({ lat: v.lat, lng: v.lng, visits: [v] });
    }
  }
  return clusters
    .filter((c) => new Set(c.visits.map((v) => buckets(v.arrived, timeZone).day)).size >= PLACE_DAYS)
    .map((c) => ({ lat: c.lat, lng: c.lng, visits: c.visits.length, kind: guessKind(c.visits, timeZone) }));
}

/** Samples each visit every 15 minutes and asks what time of the week they mostly fall in. */
export function guessKind(visits: Visit[], timeZone: string): Place["kind"] {
  let night = 0;
  let work = 0;
  let total = 0;
  for (const v of visits) {
    for (let t = v.arrived; t <= v.left_at; t += 15 * 60_000) {
      const m = localMinutes(t, timeZone);
      const d = localWeekday(t, timeZone);
      total++;
      if (m >= 22 * 60 || m < 6 * 60) night++;
      else if (d >= 1 && d <= 5 && m >= 9 * 60 && m < 17 * 60) work++;
    }
  }
  if (!total) return "other";
  if (night / total > 0.4) return "home";
  if (work / total > 0.6) return "work";
  return "other";
}

// ---------- Storage ----------

async function listPlaces(db: D1Database, userId: string) {
  const { results } = await db
    .prepare("SELECT id, name, kind, lat, lng, radius, address, visit_count FROM places WHERE user_id = ? ORDER BY visit_count DESC")
    .bind(userId)
    .all<Place>();
  return results;
}

/** New points from the phone: stored, and folded into visits. */
export async function ingestPoints(db: D1Database, userId: string, points: Point[]) {
  if (!points.length) return 0;
  await db.batch(
    points.map((p) =>
      db
        .prepare("INSERT INTO location_points (user_id, ts, lat, lng, accuracy, speed) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(userId, p.ts, p.lat, p.lng, p.accuracy ?? null, p.speed ?? null),
    ),
  );
  const [open, places] = await Promise.all([
    db.prepare("SELECT * FROM visits WHERE user_id = ? ORDER BY left_at DESC LIMIT 1").bind(userId).first<Visit>(),
    listPlaces(db, userId),
  ]);
  const changed = foldPoints(open, points, () => crypto.randomUUID());
  await noticeParking(db, userId, points).catch((err) => console.error("location: parking check failed", err));
  await db.batch(
    changed.map((v) => {
      const place = placeFor(v, places);
      return db
        .prepare(
          `INSERT INTO visits (id, user_id, lat, lng, arrived, left_at, points, place_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET lat = excluded.lat, lng = excluded.lng, left_at = excluded.left_at,
             points = excluded.points, place_id = COALESCE(excluded.place_id, visits.place_id)`,
        )
        .bind(v.id, userId, v.lat, v.lng, v.arrived, v.left_at, v.points, place?.id ?? null);
    }),
  );
  return changed.length;
}

/** Driving speed, in metres a second: about 25 km/h. */
const DRIVING_MS = 7;

/**
 * Where the car is (F31): the first point where they came to a stop after
 * driving, remembered as an object called "car" so "where did I park?" works.
 * A stop within 150 m of home isn't worth remembering.
 */
async function noticeParking(db: D1Database, userId: string, points: Point[]) {
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const drove = sorted.findIndex((p) => (p.speed ?? 0) >= DRIVING_MS);
  if (drove < 0) return;
  const stop = sorted.slice(drove).find((p, i, rest) => (p.speed ?? 0) < 1 && rest.slice(i).every((q) => q.ts - p.ts > 3 * 60_000 || (q.speed ?? 0) < 1.5));
  if (!stop) return;
  const home = await db.prepare("SELECT lat, lng FROM places WHERE user_id = ? AND kind = 'home'").bind(userId).first<{ lat: number; lng: number }>();
  if (home && distanceM(home, stop) < 150) return;
  const places = await listPlaces(db, userId);
  const place = placeFor(stop, places);
  const { saveObject } = await import("./people");
  await saveObject(db, userId, "car", place?.name ? `at ${place.name}` : `parked near ${stop.lat.toFixed(5)}, ${stop.lng.toFixed(5)}`, {
    lat: stop.lat,
    lng: stop.lng,
    placeId: place?.id ?? null,
  });
}

/**
 * Nightly: finds spots visited on three or more days that aren't places yet, and
 * makes them places. Home and work are named on the spot; anything else waits
 * for the user, who is asked once.
 */
export async function learnPlaces(env: Env, userId: string, timeZone: string) {
  const db = env.DB;
  const since = Date.now() - LOCATION_RETAIN_DAYS * 86_400_000;
  const [{ results: visits }, places] = await Promise.all([
    db.prepare("SELECT * FROM visits WHERE user_id = ? AND arrived > ? AND place_id IS NULL").bind(userId, since).all<Visit>(),
    listPlaces(db, userId),
  ]);
  let made = 0;
  for (const found of findPlaces(visits, timeZone)) {
    if (placeFor(found, places)) continue;
    const taken = places.some((p) => p.kind === found.kind);
    const kind = found.kind !== "other" && !taken ? found.kind : "other";
    const id = crypto.randomUUID();
    const name = kind === "home" ? "Home" : kind === "work" ? "Work" : null;
    await db
      .prepare("INSERT INTO places (id, user_id, name, kind, lat, lng, visit_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, userId, name, kind, found.lat, found.lng, found.visits, Date.now())
      .run();
    places.push({ id, name, kind, lat: found.lat, lng: found.lng, radius: 100, address: null, visit_count: found.visits });
    made++;
  }
  // Every visit gets its place, now that there may be new ones; counts follow.
  for (const v of visits) {
    const place = placeFor(v, places);
    if (place) await db.prepare("UPDATE visits SET place_id = ? WHERE id = ?").bind(place.id, v.id).run();
  }
  await db
    .prepare(
      // Visits expire after 14 days, so the count only ever grows: it's how often, ever, not lately.
      `UPDATE places SET visit_count = MAX(visit_count, (SELECT COUNT(*) FROM visits v WHERE v.place_id = places.id AND v.left_at - v.arrived >= ?))
        WHERE user_id = ?`,
    )
    .bind(MIN_VISIT_MS, userId)
    .run();
  return made;
}

/** Asks about one unnamed place, once, when the phone has found its address. */
export async function askAboutPlaces(env: Env, userId: string) {
  const place = await env.DB.prepare(
    "SELECT id, address, visit_count FROM places WHERE user_id = ? AND name IS NULL AND asked_at IS NULL AND address IS NOT NULL ORDER BY visit_count DESC LIMIT 1",
  )
    .bind(userId)
    .first<{ id: string; address: string; visit_count: number }>();
  if (!place) return false;
  await env.DB.prepare("UPDATE places SET asked_at = ? WHERE id = ?").bind(Date.now(), place.id).run();
  await push(env, userId, {
    title: "What's this place?",
    body: `You've been near ${place.address} a few times. Tell OVOA what it is — "that's the gym" — and it'll remember.`,
    data: { type: "place-question", placeId: place.id },
  });
  return true;
}

/** Nightly, for everyone with location on: learn places, and ask about new ones. */
export async function locationNightly(env: Env) {
  const db = env.DB;
  const cutoff = Date.now() - LOCATION_RETAIN_DAYS * 86_400_000;
  const { results } = await db
    .prepare(
      `SELECT DISTINCT v.user_id, s.time_zone FROM visits v JOIN settings s ON s.user_id = v.user_id WHERE v.left_at > ?`,
    )
    .bind(cutoff)
    .all<{ user_id: string; time_zone: string | null }>();
  let made = 0;
  for (const u of results) {
    try {
      made += await learnPlaces(env, u.user_id, validTimeZone(u.time_zone));
      await askAboutPlaces(env, u.user_id);
    } catch (err) {
      console.error(`location: nightly failed for ${u.user_id}`, err);
    }
  }
  // Old points, visits and place events go in the nightly purge (retention.ts), after this.
  return made;
}

/**
 * The phone crossed a geofence. Arriving somewhere fires any note that was left
 * for that place ("remind me at the pharmacy"); both directions are recorded
 * for the leaving-home checklist.
 */
export async function placeEvent(env: Env, userId: string, placeId: string, kind: "enter" | "exit", ts: number) {
  const db = env.DB;
  const place = await db.prepare("SELECT id, name, kind FROM places WHERE id = ? AND user_id = ?").bind(placeId, userId).first<{
    id: string;
    name: string | null;
    kind: string;
  }>();
  if (!place) return null;
  await db
    .prepare("INSERT INTO place_events (id, user_id, place_id, kind, ts) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, placeId, kind, ts)
    .run();
  let reminded = 0;
  if (kind === "enter") {
    const names = [place.name, place.kind !== "other" ? place.kind : null].filter(Boolean) as string[];
    const { results } = await db
      .prepare(
        `SELECT id, text FROM notes WHERE user_id = ? AND done = 0 AND reminded_at IS NULL AND
           (place_id = ? ${names.map(() => "OR lower(place) LIKE ?").join(" ")})`,
      )
      .bind(userId, placeId, ...names.map((n) => `%${n.toLowerCase()}%`))
      .all<{ id: string; text: string }>();
    for (const n of results) {
      await db.prepare("UPDATE notes SET reminded_at = ? WHERE id = ?").bind(Date.now(), n.id).run();
      await push(env, userId, { title: `At ${place.name ?? "this place"}`, body: n.text.slice(0, 180), data: { type: "note", noteId: n.id } });
      await logAction(db, userId, "reminder_fired", `Reminded at ${place.name ?? "a place"}: ${n.text.slice(0, 100)}`, "system", n.id);
      reminded++;
    }
  }
  // Leaving home: the checklist (rhythm.ts). Imported here on use, as rhythm.ts imports this file.
  if (kind === "exit" && place.kind === "home") {
    const { leavingHome } = await import("./rhythm");
    await leavingHome(env, userId).catch((err) => console.error("rhythm: checklist failed", err));
  }
  return { place: place.name, kind: place.kind, reminded };
}

// ---------- Routes ----------

export const location = new Hono<{ Bindings: Env; Variables: Vars }>();

const pointsSchema = z.object({
  points: z
    .array(
      z.object({
        // iOS sends fractions of a millisecond; rounded below (they were all refused, 2026-09-21).
        ts: z.number().positive(),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        accuracy: z.number().nullish(),
        speed: z.number().nullish(),
      }),
    )
    // An empty batch is the background task waking with nothing new, not a bad
    // request: it was answered with a 400 the app then logged as an error.
    .max(500),
});

location.post("/locations", async (c) => {
  const parsed = pointsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid points" }, 400);
  if (!parsed.data.points.length) return c.json({ visits: 0 });
  const points = parsed.data.points.map((p) => ({ ...p, ts: Math.round(p.ts) }));
  return c.json({ visits: await ingestPoints(c.env.DB, c.var.userId, points) });
});

location.get("/places", async (c) => c.json({ places: await listPlaces(c.env.DB, c.var.userId) }));

location.post("/places/:id/address", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { address?: unknown } | null;
  if (typeof body?.address !== "string") return c.json({ error: "address is required" }, 400);
  await c.env.DB.prepare("UPDATE places SET address = ? WHERE id = ? AND user_id = ?")
    .bind(body.address.slice(0, 200), c.req.param("id"), c.var.userId)
    .run();
  return c.json({ ok: true });
});

location.patch("/places/:id", async (c) => {
  const parsed = z
    .object({ name: z.string().trim().min(1).max(60).optional(), kind: z.enum(["home", "work", "gym", "other"]).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid place" }, 400);
  const { meta } = await c.env.DB.prepare("UPDATE places SET name = COALESCE(?, name), kind = COALESCE(?, kind) WHERE id = ? AND user_id = ?")
    .bind(parsed.data.name ?? null, parsed.data.kind ?? null, c.req.param("id"), c.var.userId)
    .run();
  return meta.changes ? c.json({ ok: true }) : c.json({ error: "No such place" }, 404);
});

location.delete("/places/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM places WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.var.userId).run();
  return c.json({ ok: true });
});

location.post("/places/event", async (c) => {
  const parsed = z
    .object({ placeId: z.string().max(64), kind: z.enum(["enter", "exit"]), ts: z.number().int().positive().optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid event" }, 400);
  const res = await placeEvent(c.env, c.var.userId, parsed.data.placeId, parsed.data.kind, parsed.data.ts ?? Date.now());
  return res ? c.json(res) : c.json({ error: "No such place" }, 404);
});

/** "Forget where I've been": points and visits go; named places stay unless deleted one by one. */
location.delete("/locations", async (c) => {
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM location_points WHERE user_id = ?").bind(c.var.userId),
    c.env.DB.prepare("DELETE FROM visits WHERE user_id = ?").bind(c.var.userId),
  ]);
  return c.json({ ok: true });
});

// ---------- In conversation ----------

const TOOLS: ToolSpec[] = [
  {
    name: "location_timeline",
    description: "Where they were on a day in the last 14 days: each stop of five minutes or more, with the place's name or address and the times. For 'where was I Tuesday', 'when did I get to work'.",
    parameters: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD; leave out for today." } } },
  },
  {
    name: "place_list",
    description: "The places OVOA has learned (home, work, the gym, unnamed ones), with ids for renaming. Named places are kept; an unnamed one goes after 14 days without a visit.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "place_rename",
    description: "Names a place, or says what kind it is: 'that's the gym', 'call it Mum's'. Get the id from place_list.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" }, kind: { type: "string", enum: ["home", "work", "gym", "other"] } },
      required: ["id"],
    },
  },
];

const NAMES = new Set(TOOLS.map((t) => t.name));
export const isLocationTool = (name: string) => NAMES.has(name);

export function locationAssistant(env: Env, userId: string, timeZone: string) {
  const db = env.DB;
  const callTool: CallTool = async (name, args) => {
    if (name === "location_timeline") {
      const day = typeof args.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : buckets(Date.now(), timeZone).day;
      const [from, to] = dayRange(day, timeZone);
      const { results } = await db
        .prepare(
          `SELECT v.arrived, v.left_at, p.name, p.address, p.kind FROM visits v LEFT JOIN places p ON p.id = v.place_id
            WHERE v.user_id = ? AND v.left_at >= ? AND v.arrived < ? AND v.left_at - v.arrived >= ? ORDER BY v.arrived`,
        )
        .bind(userId, from, to, MIN_VISIT_MS)
        .all<{ arrived: number; left_at: number; name: string | null; address: string | null; kind: string | null }>();
      if (!results.length) {
        return { date: day, stops: 0, note: "No location for that day. Location history only goes back 14 days, and only while the timeline is on." };
      }
      return {
        date: day,
        stops: results.map((v) => ({
          where: v.name ?? v.address ?? "somewhere unnamed",
          from: clock(v.arrived, timeZone),
          to: clock(v.left_at, timeZone),
          minutes: Math.round((v.left_at - v.arrived) / 60_000),
        })),
      };
    }
    if (name === "place_list") {
      const places = await listPlaces(db, userId);
      return places.length
        ? { places: places.map((p) => ({ id: p.id, name: p.name, kind: p.kind, address: p.address, visits: p.visit_count })) }
        : { places: 0, note: "No places learned yet. It takes a few days of the timeline being on." };
    }
    if (name === "place_rename") {
      const kind = ["home", "work", "gym", "other"].includes(String(args.kind)) ? String(args.kind) : null;
      const newName = String(args.name ?? "").trim().slice(0, 60) || null;
      if (!newName && !kind) return { error: "name or kind is required" };
      const { meta } = await db
        .prepare("UPDATE places SET name = COALESCE(?, name), kind = COALESCE(?, kind) WHERE id = ? AND user_id = ?")
        .bind(newName, kind, String(args.id ?? ""), userId)
        .run();
      return meta.changes ? { renamed: true } : { error: "No such place" };
    }
    return { error: `Unknown tool ${name}` };
  };
  return {
    tools: TOOLS,
    callTool,
    prompt: "With the location timeline on, OVOA learns their places and remembers where they went for 14 days. Use location_timeline for where they were; place_rename when they tell you what a place is.",
  };
}
