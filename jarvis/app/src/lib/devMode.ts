import { useEffect, useState } from "react";
import { storage } from "./storage";

// Dev mode: the developer's screens and switches (Dev tools, the Logs panel on
// Talk, the Developer group in the menu, Live listen, Ask Claude). On by
// default, because everyone on TestFlight today is building or testing OVOA;
// turned off in Settings it shows the app the way someone who just downloaded
// it would see it. It only hides things on this phone: the server still treats
// a development account as one (no daily limit, the engine picker).

const KEY = "ovoa.devMode";
const listeners = new Set<(on: boolean) => void>();
/** Read once, then kept, so every screen agrees without waiting on storage. */
let current: boolean | null = null;

export const devModePref = {
  /** Anything but an explicit "0" is on: a phone that never chose gets dev mode. */
  get: async () => {
    if (current === null) current = (await storage.get(KEY).catch(() => null)) !== "0";
    return current;
  },
  set: async (on: boolean) => {
    current = on;
    listeners.forEach((l) => l(on));
    await storage.set(KEY, on ? "1" : "0");
  },
};

/** Whether dev mode is on. Starts as on (the default) until storage says otherwise. */
export function useDevMode() {
  const [on, setOn] = useState(current ?? true);
  useEffect(() => {
    devModePref.get().then(setOn);
    listeners.add(setOn);
    return () => void listeners.delete(setOn);
  }, []);
  return on;
}
