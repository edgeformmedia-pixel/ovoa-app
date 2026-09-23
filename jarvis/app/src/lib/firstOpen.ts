import { useEffect, useSyncExternalStore } from "react";
import { logFail } from "./devlog";
import { onSignOut } from "./signOut";
import { storage } from "./storage";

// The steps between signing up and the app itself (app/_layout.tsx), and the
// ones someone put off.
//
// After sign-up: the emailed code (app/verify-email.tsx), then the phone's
// permissions (app/permissions.tsx), then, on the free plan, the tour. Someone
// with Base agrees to AI first (app/consent.tsx) and then has the setup
// conversation (app/onboarding.tsx) before the tour.
//
// What this file keeps, on this phone, so a step isn't asked twice:
//   - that the permissions step is still to come: set at sign-up and kept until
//     it's done, so quitting the app half-way doesn't skip it;
//   - who said "Not now" to the code screen: only an account from before codes,
//     which the server doesn't hold (a new one can't skip it);
//   - who said "Not now" to the consent screen: AI then shows "Agree to use AI",
//     and setup waits until they do.
// All of it goes when someone signs out: the next person gets their own.

const PERMISSIONS_KEY = "ovoa.firstOpen.permissions";
const CODE_LATER_KEY = "ovoa.firstOpen.codeLater";
const CONSENT_LATER_KEY = "ovoa.firstOpen.consentLater";

type State = {
  /** Storage has been read: nothing here is known before that. */
  loaded: boolean;
  /** The permissions step is still to come (a sign-up on this phone). */
  permissions: boolean;
  /** The user id that put the code off. */
  codeLater: string | null;
  /** The user id that put consent off. */
  consentLater: string | null;
};

let state: State = { loaded: false, permissions: false, codeLater: null, consentLater: null };
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function load() {
  loading ??= (async () => {
    const read = (key: string) => storage.get(key).catch(() => null);
    const [permissions, codeLater, consentLater] = await Promise.all([read(PERMISSIONS_KEY), read(CODE_LATER_KEY), read(CONSENT_LATER_KEY)]);
    set({ loaded: true, permissions: permissions === "1", codeLater, consentLater });
  })();
  return loading;
}

const keep = (key: string, value: string | null) =>
  (value === null ? storage.remove(key) : storage.set(key, value)).catch(logFail(`firstOpen: saving ${key}`));

export const firstOpen = {
  /** An account was just made on this phone: the permissions step comes after the code. */
  signedUp: () => {
    set({ permissions: true });
    void keep(PERMISSIONS_KEY, "1");
  },
  permissionsDone: () => {
    set({ permissions: false });
    void keep(PERMISSIONS_KEY, null);
  },
  /** An account from before codes chose "Not now" on the code screen. */
  codeLater: (userId: string) => {
    set({ codeLater: userId });
    void keep(CODE_LATER_KEY, userId);
  },
  /** They chose "Not now" on the consent screen: it isn't put in front of them again by itself. */
  consentLater: (userId: string) => {
    set({ consentLater: userId });
    void keep(CONSENT_LATER_KEY, userId);
  },
};

onSignOut("first open", async () => {
  set({ permissions: false, codeLater: null, consentLater: null });
  await Promise.all([storage.remove(PERMISSIONS_KEY), storage.remove(CODE_LATER_KEY), storage.remove(CONSENT_LATER_KEY)]);
});

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const read = () => state;

export function useFirstOpen() {
  useEffect(() => void load(), []);
  return useSyncExternalStore(subscribe, read, read);
}
