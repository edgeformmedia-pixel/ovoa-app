import { useCallback, useEffect, useState } from "react";
import { api, type AppDraft, type AppOp, type MyApp } from "./api";
import { setOpenApp } from "./activeApp";
import { applyLocal } from "./appKit";
import { logFail } from "./devlog";
import { onSignOut } from "./signOut";

// The apps this person made (Apps → Create), kept on the server so they follow
// them to a new phone. Read once and shared, so the Apps screen, the menu, an
// app's own screen and its editor all agree without asking twice.

const listeners = new Set<(apps: MyApp[]) => void>();
let current: MyApp[] | null = null;

function publish(apps: MyApp[]) {
  current = apps;
  listeners.forEach((l) => l(apps));
}

/** One app swapped for its newer copy. */
const put = (app: MyApp) => publish((current ?? []).map((a) => (a.id === app.id ? app : a)));

onSignOut("made apps", () => {
  current = null;
  setOpenApp(null);
});

/** Taps on one app's screen go to the server one after another, so they land in the order they were made. */
const queues = new Map<string, Promise<unknown>>();

export const myApps = {
  refresh: async (token: string) => publish((await api.myApps(token)).apps),
  save: async (token: string, draft: AppDraft) => {
    const { app } = await api.saveApp(token, draft);
    publish([...(current ?? []), app]);
    return app;
  },
  update: async (token: string, id: string, draft: AppDraft) => {
    const { app } = await api.updateApp(token, id, draft);
    put(app);
    return app;
  },
  /**
   * A tap on the app's screen: shown at once, then the server's copy replaces
   * it. If the server refuses, the screen goes back to what the server has.
   */
  change: (token: string, id: string, op: AppOp) => {
    const app = current?.find((a) => a.id === id);
    if (app) put({ ...app, state: applyLocal(app.blocks, app.state, op) });
    const run = (queues.get(id) ?? Promise.resolve()).then(async () => {
      try {
        put((await api.appOp(token, id, op)).app);
      } catch (err) {
        await myApps.refresh(token).catch(logFail("myApps: refresh after a failed change"));
        throw err;
      }
    });
    queues.set(
      id,
      run.catch(() => {}),
    );
    return run;
  },
  remove: async (token: string, id: string) => {
    await api.deleteApp(token, id);
    setOpenApp(null);
    publish((current ?? []).filter((a) => a.id !== id));
  },
};

/** The apps they made, oldest first. Empty until the server has answered. */
export function useMyApps(token: string | null, enabled = true) {
  const [apps, setApps] = useState<MyApp[]>(current ?? []);
  const refresh = useCallback(() => {
    if (token && enabled) void myApps.refresh(token).catch(logFail("myApps: refresh"));
  }, [token, enabled]);
  useEffect(() => {
    listeners.add(setApps);
    if (current === null) refresh();
    else setApps(current);
    return () => void listeners.delete(setApps);
  }, [refresh]);
  return apps;
}

/** One app, kept current. Undefined while the list is loading; null once it's known to be gone. */
export function useMyApp(token: string | null, id: string | undefined) {
  const apps = useMyApps(token);
  const [loaded, setLoaded] = useState(current !== null);
  useEffect(() => {
    if (current !== null) return setLoaded(true);
    const l = () => setLoaded(true);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const app = apps.find((a) => a.id === id);
  return app ?? (loaded ? null : undefined);
}
