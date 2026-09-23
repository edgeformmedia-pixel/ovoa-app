import { useEffect, useState } from "react";
import { logFail } from "./devlog";
import { onSignOut } from "./signOut";
import { storage } from "./storage";

// Whether the quick tour of the menu has been seen (components/Tour.tsx).
//
// It comes up once, the first time the signed-in app opens: straight after the
// setup conversation for someone new, and on the first open of this version for
// everyone else, because the menu they knew is gone. Settings can bring it back.

const KEY = "ovoa.tour.v1";
const listeners = new Set<(seen: boolean) => void>();
let current: boolean | null = null;

function publish(seen: boolean) {
  current = seen;
  listeners.forEach((l) => l(seen));
  storage.set(KEY, seen ? "1" : "0").catch(logFail("tour: saving"));
}

export const tourPref = {
  get: async () => {
    if (current === null) current = (await storage.get(KEY).catch(() => null)) === "1";
    return current;
  },
  done: () => publish(true),
  replay: () => publish(false),
};

// Someone new on this phone gets the tour too.
onSignOut("tour", async () => {
  current = null;
  await storage.remove(KEY);
});

/** Null until storage has answered, so the tour never flashes up for someone who has seen it. */
export function useTourSeen() {
  const [seen, setSeen] = useState<boolean | null>(current);
  useEffect(() => {
    tourPref.get().then(setSeen);
    listeners.add(setSeen);
    return () => void listeners.delete(setSeen);
  }, []);
  return seen;
}
