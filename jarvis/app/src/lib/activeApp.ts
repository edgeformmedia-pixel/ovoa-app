import { useEffect, useState } from "react";

// The made app open in Talk, if any (api/src/myapps.ts). While one is open,
// every message the phone sends to the assistant names it, and the server has
// the assistant follow that app's instructions for that message.
//
// Kept apart from lib/myApps.ts, and importing nothing, because api.ts reads it
// on every send and myApps.ts imports api.ts.

export type OpenApp = { id: string; name: string; opener: string };

const listeners = new Set<(app: OpenApp | null) => void>();
let current: OpenApp | null = null;

/** Opens a made app in Talk, or closes it with null. */
export function setOpenApp(app: OpenApp | null) {
  current = app;
  listeners.forEach((l) => l(app));
}

/** What rides on /chat: the open app's id, if there is one. */
export const openAppId = () => current?.id;

export function useOpenApp() {
  const [app, setApp] = useState(current);
  useEffect(() => {
    listeners.add(setApp);
    return () => void listeners.delete(setApp);
  }, []);
  return app;
}
