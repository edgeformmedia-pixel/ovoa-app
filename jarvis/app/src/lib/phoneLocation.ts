import * as Location from "expo-location";
import { devlog } from "./devlog";

// Where the user is.
//
// The pendant has no GPS and never will — everything it knows, it knows because
// somebody said it out loud nearby. The phone does, and half the questions
// people ask out loud are really questions about where they are: what the
// weather will do, whether the place is still open, how long this will take.
// Without this the assistant has to ask, which is a strange thing to be asked
// by something sitting in your pocket.
//
// Only ever in reply to a question. There is no background tracking here, no
// history, and nothing is stored: the fix is taken, answered with, and dropped.

/** A fix older than this is refetched rather than reused. */
const MAX_AGE_MS = 60_000;
/** Beyond this, answer with whatever the last fix was rather than hanging. */
const TIMEOUT_MS = 8_000;

export type Place = {
  latitude: number;
  longitude: number;
  /** Metres. Worth passing on: a 3 km fix shouldn't be read out as a street. */
  accuracy: number | null;
  place?: string;
  at: string;
};

/** A readable place name, when one can be worked out. Failure is not an error. */
async function describe(latitude: number, longitude: number) {
  try {
    const [found] = await Location.reverseGeocodeAsync({ latitude, longitude });
    if (!found) return undefined;
    // Street and city, skipping whatever the geocoder couldn't fill in.
    const line = [found.name ?? found.street, found.city ?? found.subregion, found.region]
      .filter(Boolean)
      // "1 Infinite Loop, Cupertino, Cupertino" reads badly.
      .filter((part, i, all) => all.indexOf(part) === i)
      .join(", ");
    return line || undefined;
  } catch (err) {
    devlog("warn", "couldn't name the place", String(err));
    return undefined;
  }
}

/**
 * The phone's current position, for a question the assistant is answering now.
 * Asks for permission if it hasn't been granted, because the only way this runs
 * is that the user asked something that needs it.
 */
export async function whereAmI(): Promise<Place | { error: string }> {
  const { granted } = await Location.requestForegroundPermissionsAsync();
  if (!granted) return { error: "The user hasn't allowed OVOA to use their location. Ask them where they are instead." };

  let position: Location.LocationObject | null = null;
  try {
    position = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
    ]);
  } catch (err) {
    devlog("err", "location failed", String(err));
  }

  // A fix indoors can take a while; the last known one is usually close enough
  // for "what's the weather" and much better than nothing.
  if (!position) {
    position = await Location.getLastKnownPositionAsync({ maxAge: MAX_AGE_MS }).catch(() => null);
  }
  if (!position) return { error: "Couldn't get a location fix. Ask them where they are." };

  const { latitude, longitude, accuracy } = position.coords;
  return {
    latitude: Number(latitude.toFixed(5)),
    longitude: Number(longitude.toFixed(5)),
    accuracy: accuracy === null || accuracy === undefined ? null : Math.round(accuracy),
    place: await describe(latitude, longitude),
    at: new Date(position.timestamp).toISOString(),
  };
}
