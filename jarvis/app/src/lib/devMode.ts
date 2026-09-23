import { useEffect, useState } from "react";
import { useAuth } from "./auth";
import { onSignOut } from "./signOut";
import { storage } from "./storage";

// Dev mode: the developer's screens and switches (Dev tools, the Logs panel on
// Talk, the Developer group in the menu, Live listen). Off by default, so a
// tester sees OVOA the way someone who just downloaded it would; on by default
// only for a development account (/me's devTools, DEV_EMAILS on the server).
// Settings turns it on or off on this phone either way, and that choice wins
// over the default until someone signs out. It only hides things on this phone:
// the server still treats a development account as one (no daily limit, the
// engine picker).

const KEY = "ovoa.devMode";
/** What this phone chose in Settings: on, off, or null when it never chose (the account decides). */
type Choice = boolean | null;
const listeners = new Set<(choice: Choice) => void>();
/** Read once, then kept, so every screen agrees without waiting on storage. Undefined until read. */
let current: Choice | undefined;

export const devModePref = {
  /** "1" and "0" are choices made in Settings; anything else means this phone never chose. */
  get: async (): Promise<Choice> => {
    if (current === undefined) {
      const raw = await storage.get(KEY).catch(() => null);
      current = raw === "1" ? true : raw === "0" ? false : null;
    }
    return current;
  },
  set: async (on: boolean) => {
    current = on;
    listeners.forEach((l) => l(on));
    await storage.set(KEY, on ? "1" : "0");
  },
};

// Someone else signing in on this phone starts from their own account's default.
onSignOut("dev mode", async () => {
  current = null;
  listeners.forEach((l) => l(null));
  await storage.remove(KEY);
});

/** Whether dev mode is on: this phone's choice, or else whether the account is a development one. */
export function useDevMode() {
  const { user } = useAuth();
  const [choice, setChoice] = useState<Choice>(current ?? null);
  useEffect(() => {
    devModePref.get().then(setChoice);
    listeners.add(setChoice);
    return () => void listeners.delete(setChoice);
  }, []);
  return choice ?? !!user?.devTools;
}
