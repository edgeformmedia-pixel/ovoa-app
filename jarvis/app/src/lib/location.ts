import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { AppState, Platform } from "react-native";
import { api } from "./api";
import { savedToken } from "./auth";
import { devlog, logFail } from "./devlog";
import { storage } from "./storage";

// The location timeline, the phone's half (server: api/src/location.ts).
//
// Off until the user turns it on in Settings, and only with "Always" location:
// the point is to know where they were while the phone was in a pocket. Points
// go up in batches; the server turns them into visits and places. The phone
// does the two things only it can do for free: naming a spot (iOS's own
// reverse geocoder) and watching up to 20 places for arrivals and departures.
//
// Both tasks are defined here at load, because iOS starts the app in the
// background to run them; the root layout imports this file for that reason.

const LOCATION_TASK = "ovoa-location";
const GEOFENCE_TASK = "ovoa-geofence";
const PREF = "ovoa.locationTimeline";
const MAX_GEOFENCES = 20;

/** Points that couldn't be sent yet (no network): sent with the next batch. */
let pending: { ts: number; lat: number; lng: number; accuracy: number | null; speed: number | null }[] = [];

async function send(points: typeof pending) {
  const token = await savedToken();
  if (!token) return;
  pending = [...pending, ...points].slice(-500);
  try {
    await api.sendLocations(token, pending);
    pending = [];
  } catch (err) {
    devlog("warn", `location: ${pending.length} points waiting to send`, String(err));
  }
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    // kCLErrorLocationUnknown (code 0) is iOS saying "not yet" -- a tunnel, a cold
    // GPS -- and it fixes itself. It isn't worth a line in the error log.
    const why = String(error.message ?? error);
    const transient = /Code=0\b/.test(why) || /kCLErrorDomain.*\(null\)/.test(why);
    return devlog(transient ? "log" : "err", "location task error", why);
  }
  if (!data?.locations?.length) return;
  devlog("log", `location task: ${data.locations.length} point(s)`);
  await send(
    data.locations.map((l) => ({
      ts: Math.round(l.timestamp),
      lat: l.coords.latitude,
      lng: l.coords.longitude,
      accuracy: l.coords.accuracy ?? null,
      speed: l.coords.speed ?? null,
    })),
  );
});

TaskManager.defineTask<{ eventType: Location.GeofencingEventType; region: Location.LocationRegion }>(
  GEOFENCE_TASK,
  async ({ data, error }) => {
    if (error || !data?.region?.identifier) return;
    const token = await savedToken();
    if (!token) return;
    const kind = data.eventType === Location.GeofencingEventType.Enter ? "enter" : "exit";
    await api.placeEvent(token, data.region.identifier, kind).catch((err) => devlog("err", "geofence event failed", String(err)));
    devlog("agent", `place ${kind}: ${data.region.identifier}`);
  },
);

export const timelinePref = {
  get: async () => (await storage.get(PREF).catch(() => null)) === "1",
  set: (on: boolean) => storage.set(PREF, on ? "1" : "0"),
};

/**
 * Turns the timeline on: asks for location while in use, then Always (iOS asks
 * in two steps), and starts the background updates. Returns why not, if not.
 */
export async function enableTimeline(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (Platform.OS !== "ios") return { ok: false, reason: "The location timeline is iPhone-only for now." };
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return { ok: false, reason: "Location is off for OVOA. Allow it in iPhone Settings → OVOA → Location." };
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (!bg.granted) {
    return { ok: false, reason: 'It needs location set to "Always" to know where you were with the app closed. Change it in iPhone Settings → OVOA → Location.' };
  }
  await timelinePref.set(true);
  await startUpdates();
  return { ok: true };
}

export async function disableTimeline() {
  await timelinePref.set(false);
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK).catch(logFail("location: Location.stopLocationUpdatesAsync"));
  }
  if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false)) {
    await Location.stopGeofencingAsync(GEOFENCE_TASK).catch(logFail("location: Location.stopGeofencingAsync"));
  }
}

async function startUpdates() {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false)) return;
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    // A hundred metres is plenty to tell home from work, and much kinder to the battery than GPS.
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 75,
    // Held and delivered in batches rather than point by point.
    deferredUpdatesInterval: 5 * 60_000,
    deferredUpdatesDistance: 200,
    pausesUpdatesAutomatically: true,
    activityType: Location.ActivityType.Other,
    showsBackgroundLocationIndicator: false,
  });
  devlog("agent", "location timeline started");
}

/**
 * Names the places the server found (with the phone's own geocoder) and
 * watches the most visited twenty for arrivals and departures.
 */
export async function syncPlaces(token: string) {
  try {
    const { places } = await api.places(token);
    for (const p of places.filter((p) => !p.address).slice(0, 5)) {
      const [hit] = await Location.reverseGeocodeAsync({ latitude: p.lat, longitude: p.lng }).catch(() => []);
      const address = hit ? [hit.name ?? hit.street, hit.city].filter(Boolean).join(", ") : null;
      if (address) await api.placeAddress(token, p.id, address).catch(logFail("location: api.placeAddress"));
    }
    const regions = places.slice(0, MAX_GEOFENCES).map((p) => ({
      identifier: p.id,
      latitude: p.lat,
      longitude: p.lng,
      radius: Math.max(100, p.radius),
      notifyOnEnter: true,
      notifyOnExit: true,
    }));
    if (regions.length) await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
  } catch (err) {
    devlog("err", "couldn't sync places", String(err));
  }
}

/** While signed in: keeps updates running if the timeline is on, and places in step. */
export function startLocationTimeline(token: string) {
  const check = async () => {
    if (!(await timelinePref.get())) return;
    const bg = await Location.getBackgroundPermissionsAsync().catch(() => null);
    if (!bg?.granted) return;
    await startUpdates().catch((err) => devlog("err", "couldn't start the location timeline", String(err)));
    await syncPlaces(token);
    if (pending.length) await send([]);
  };
  void check();
  const sub = AppState.addEventListener("change", (s) => {
    if (s === "active") void check();
  });
  return () => sub.remove();
}
