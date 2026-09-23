import { AppState } from "react-native";
import { installedAddons } from "./addons";
import { request } from "./api";
import { devlog } from "./devlog";
import { onSignOut } from "./signOut";
import { storage } from "./storage";

// Food, as the Calorie add-on sees it (api/src/food.ts).
//
// OVOA notes food from what's said in Talk, for everyone on Base, with nothing
// installed. Calorie is the screen for it, and installing it is also how OVOA
// learns to say numbers and ask what's in things: the tracking level lives on
// the server (profile.food_detail), because a turn is answered there.
//
// So installing and removing Calorie tell the server (calorieToggled), and the
// server can install it too: an eating goal in setup, or "be more exact" said
// out loud, sets a level, and the next time the app opens it adds Calorie to
// the menu (startCalorieSync). Removing it is only ever done on the phone.

export const CALORIE_ID = "calorie";

/** quick never asks, normal asks when it matters, strict asks for the details. */
export type FoodLevel = "quick" | "normal" | "strict";

export type FoodSettings = {
  /** Null when Calorie isn't set up: food is noted quietly and no number is said. */
  level: FoodLevel | null;
  /** They picked a level, so the first open doesn't ask. */
  chosen: boolean;
  target: { kcal: number | null; protein: number | null };
};

export type FoodEntry = {
  id: string;
  ts: number;
  name: string;
  grams: number | null;
  kcal: number;
  protein: number | null;
  /** "clamped" when OVOA had to correct its own estimate. */
  estimated: string;
};

export type FoodDay = { day: string; kcal: number; protein: number; entries: number };

/** GET /food: everything the Calorie screen shows. Numbers are plain and whole. */
export type FoodScreen = FoodSettings & {
  today: FoodDay & { entries: FoodEntry[] };
  /** The last 14 days that have anything in them, newest first (today included). */
  days: FoodDay[];
  /** Eaten twice or more in the last 14 days, most first. */
  top: { name: string; times: number }[];
  /** Grams a day, over whole days with protein noted. Null until there are any. */
  proteinAvg: number | null;
};

export const foodApi = {
  screen: (token: string) => request<FoodScreen>("/food", token),
  settings: (token: string) => request<FoodSettings>("/food/settings", token),
  set: (token: string, patch: { installed?: boolean; level?: FoodLevel; kcal?: number | null; protein?: number | null }) =>
    request<FoodSettings>("/food/settings", token, { method: "PUT", body: JSON.stringify(patch) }),
  amend: (token: string, id: string, change: { grams?: number; kcal?: number; fraction?: number }) =>
    request<{ after: number }>(`/food/log/${encodeURIComponent(id)}`, token, { method: "PATCH", body: JSON.stringify(change) }),
  remove: (token: string, id: string) => request<{ ok: true }>(`/food/log/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
};

/**
 * Calorie was taken off while the server couldn't be told (offline, a
 * timeout). Until it has been, the next sync tells it again instead of seeing
 * the level still set and putting Calorie back.
 */
const REMOVAL_PENDING_KEY = "ovoa.calorieRemovalPending";
onSignOut("calorie removal", () => storage.remove(REMOVAL_PENDING_KEY));

/**
 * Calorie was added or taken off on this phone. Adding turns tracking on at the
 * level they last chose (or normal); taking it off goes back to noting quietly.
 * A failed add is sent again by the screen when it's opened; a failed removal
 * by the next sync (REMOVAL_PENDING_KEY).
 */
export async function calorieToggled(token: string | null, installed: boolean) {
  if (!token) return;
  if (installed) await storage.remove(REMOVAL_PENDING_KEY).catch(() => {});
  try {
    await foodApi.set(token, { installed });
  } catch (err) {
    devlog("err", "calorie: couldn't tell the server", String(err));
    if (!installed) await storage.set(REMOVAL_PENDING_KEY, "1").catch(() => {});
  }
}

/** Adds Calorie to this phone when the server says a level is set and it isn't here yet. */
async function syncCalorie(token: string) {
  try {
    // A removal the server never heard about: tell it now, and don't add Calorie back meanwhile.
    if ((await storage.get(REMOVAL_PENDING_KEY).catch(() => null)) === "1") {
      await foodApi.set(token, { installed: false });
      await storage.remove(REMOVAL_PENDING_KEY);
      devlog("log", "calorie: told the server it was removed");
      return;
    }
    const s = await foodApi.settings(token);
    if (!s.level) return;
    const ids = await installedAddons.get();
    if (!ids.includes(CALORIE_ID)) {
      await installedAddons.install(CALORIE_ID);
      devlog("log", `calorie: installed because the server has it at ${s.level}`);
    }
  } catch (err) {
    devlog("err", "calorie: couldn't check the server", String(err));
  }
}

/** Checks now and each time the app comes back to the front. Returns a stop function. */
export function startCalorieSync(token: string) {
  void syncCalorie(token);
  const app = AppState.addEventListener("change", (s) => {
    if (s === "active") void syncCalorie(token);
  });
  return () => app.remove();
}
