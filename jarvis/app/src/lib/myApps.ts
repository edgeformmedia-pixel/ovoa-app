import { useCallback, useEffect, useState } from "react";
import { api, type AppDraft, type MyApp } from "./api";
import { setOpenApp } from "./activeApp";
import { logFail } from "./devlog";
import { onSignOut } from "./signOut";

// The apps this person made (Apps → Create), kept on the server so they follow
// them to a new phone. Read once and shared, so the Apps screen and Create
// agree without asking twice.

const listeners = new Set<(apps: MyApp[]) => void>();
let current: MyApp[] | null = null;

function publish(apps: MyApp[]) {
  current = apps;
  listeners.forEach((l) => l(apps));
}

onSignOut("made apps", () => {
  current = null;
  setOpenApp(null);
});

export const myApps = {
  refresh: async (token: string) => publish((await api.myApps(token)).apps),
  save: async (token: string, draft: AppDraft) => {
    const { app } = await api.saveApp(token, draft);
    publish([...(current ?? []), app]);
    return app;
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
    return () => void listeners.delete(setApps);
  }, [refresh]);
  return apps;
}
