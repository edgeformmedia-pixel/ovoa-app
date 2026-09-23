import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { devlog, logFail } from "./devlog";
import { api, ApiError, whenCodeNeeded, whenSessionDies, type User } from "./api";
import { noteConsentFromUser } from "./consent";
import { firstOpen } from "./firstOpen";
import { unregisterPush } from "./push";
import { setLogToken } from "./remoteLog";
import { setRecordingsOwner } from "./recordings";
import { resetForSignOut } from "./signOut";
import { storage } from "./storage";

/**
 * Signing out tells the server twice (push, then the session), each with the
 * usual one-minute timeout. Offline that was two minutes of a button that did
 * nothing. The phone forgets the session regardless after this long.
 */
const SIGN_OUT_WAIT_MS = 5000;

/** Launched with no network: how long to wait before each retry of the saved session. */
const RESTORE_RETRY_MS = [3000, 10_000, 30_000, 60_000, 120_000];

// Storage key kept from the original app name so existing sign-ins survive.
const TOKEN_KEY = "jarvis.session";
/**
 * Set the first time this phone holds a session, and never cleared — signing
 * out does not make the account stop existing. sign-in.tsx reads it to choose
 * which form to open on: 36 of the 38 devices in device_logs only ever tried to
 * sign in, never once tried to sign up, and left after 4-7 401s (2026-09-21).
 */
const HAS_ACCOUNT_KEY = "ovoa.hasAccount";

/** The signed-in session, for code that runs outside React (a background push, say). */
export const savedToken = () => storage.get(TOKEN_KEY).catch(() => null);

type AuthState = {
  loading: boolean;
  token: string | null;
  user: User | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name: string) => Promise<void>;
  signOut: () => Promise<void>;
  setUser: (user: User) => void;
  /** Reads GET /me again: after the code is typed, consent is given, or the server said either is missing. */
  refreshUser: () => Promise<void>;
  /**
   * True right after sign-up, until the first-open permissions step is done
   * (app/permissions.tsx). Connect Google isn't part of first open any more:
   * it's in Settings.
   */
  onboarding: boolean;
  finishOnboarding: () => void;
  /** When sign-up's own code went out, so the code screen counts down from it instead of asking again. */
  codeSentAt: number | null;
  /** This phone has been signed in before, so "Sign in" is the likelier form. */
  hasAccountHere: boolean;
  /** Forget the session locally (e.g. after deleting the account). */
  clear: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [onboarding, setOnboardingState] = useState(false);
  const [hasAccountHere, setHasAccountHere] = useState(false);
  const [codeSentAt, setCodeSentAt] = useState<number | null>(null);
  /** A new account on this phone: the permissions step is kept for it, even across a restart (lib/firstOpen.ts). */
  const setOnboarding = useCallback((on: boolean) => {
    setOnboardingState(on);
    if (on) firstOpen.signedUp();
  }, []);

  // Server-side logs get tagged with whoever is signed in, and recordings are theirs.
  useEffect(() => setLogToken(token), [token]);
  useEffect(() => setRecordingsOwner(user?.id ?? null), [user?.id]);
  // Whether they've agreed to AI, for the code outside React that must not send
  // anything to an AI company before they have (lib/consent.ts).
  useEffect(() => noteConsentFromUser(user?.aiConsent, !!user), [user]);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const refreshUser = useCallback(async () => {
    const t = tokenRef.current;
    if (!t) return;
    const { user: fresh } = await api.me(t);
    if (tokenRef.current === t) setUser(fresh);
  }, []);

  // The server said this account's address isn't proven yet (a new account from
  // before this build knew about codes, say): read /me, and the code screen comes up.
  useEffect(() => {
    whenCodeNeeded(() => void refreshUser().catch(logFail("auth: reading /me after needs_verification")));
    return () => whenCodeNeeded(null);
  }, [refreshUser]);

  const clear = useCallback(async () => {
    // Everything this phone keeps for one person goes with their session (signOut.ts).
    await resetForSignOut();
    await storage.remove(TOKEN_KEY);
    setOnboardingState(false);
    setCodeSentAt(null);
    setToken(null);
    setUser(null);
  }, []);

  // The server said the session is gone (expired, revoked, the account deleted
  // elsewhere): sign out here too, once, rather than failing every request.
  useEffect(() => {
    whenSessionDies((dead) => {
      if (dead !== tokenRef.current) return; // a request from an earlier session
      devlog("warn", "auth: the server no longer knows this session; signing out");
      tokenRef.current = null;
      void clear();
    });
    return () => whenSessionDies(null);
  }, [clear]);

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let saved: string | null = null;
    let seen: string | null | void = null;

    /** Tries the saved session. False when it's worth trying again later (no network). */
    const restore = async () => {
      if (!saved || stopped || tokenRef.current) return true;
      try {
        const { user } = await api.me(saved);
        if (stopped || tokenRef.current) return true;
        setToken(saved);
        setUser(user);
        // A restored session never goes through start(), so without this every
        // phone that signed in before this shipped would still open on "Create
        // account" the next time it was signed out.
        if (seen !== "1") {
          setHasAccountHere(true);
          await storage.set(HAS_ACCOUNT_KEY, "1").catch(logFail("auth: remembering this phone has an account"));
        }
        devlog("log", attempt ? `auth: session restored on try ${attempt + 1}` : "auth: session restored");
        return true;
      } catch (err) {
        // Expired or revoked session: start signed out. Keep the token on network errors.
        const status = err instanceof ApiError ? err.status : 0;
        devlog(
          "warn",
          `auth: couldn't use the saved session (${status || "no reply"})`,
          err instanceof Error ? err.message : String(err),
        );
        if (status === 401) {
          saved = null;
          await storage.remove(TOKEN_KEY).catch(logFail("auth: clearing a dead token"));
          return true;
        }
        // Opened with no signal, or the server having a bad minute: the session is
        // probably fine. Keep trying for a while, rather than leave someone who was
        // signed in on the sign-in screen until they quit and reopen the app.
        return false;
      }
    };
    const scheduleRetry = () => {
      if (stopped || attempt >= RESTORE_RETRY_MS.length) return;
      retry = setTimeout(async () => {
        retry = null;
        attempt++;
        if (!(await restore())) scheduleRetry();
      }, RESTORE_RETRY_MS[attempt]);
    };
    // Back in the app while a retry is waiting: try now rather than at the next step.
    const app = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !saved || tokenRef.current || retry === null) return;
      clearTimeout(retry);
      retry = null;
      void restore().then((done) => !done && scheduleRetry());
    });

    (async () => {
      // Before setLoading(false), so the sign-in screen never renders the wrong form first.
      seen = await storage.get(HAS_ACCOUNT_KEY).catch(logFail("auth: reading hasAccount"));
      setHasAccountHere(seen === "1");
      try {
        saved = await storage.get(TOKEN_KEY);
        if (!saved) {
          devlog("log", `auth: no saved session (this phone has ${seen === "1" ? "" : "never "}signed in before)`);
          return;
        }
        if (!(await restore())) scheduleRetry();
      } catch (err) {
        devlog("warn", "auth: couldn't read the saved session", err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      app.remove();
    };
  }, []);

  const start = async ({ token, user }: { token: string; user: User }) => {
    // Signed in the moment the server says so. The keychain write comes after and
    // cannot undo it: setItemAsync rejects when it can't write (Expo SDK 57 docs),
    // and throwing from here threw away an account that had just been created.
    setToken(token);
    setUser(user);
    setHasAccountHere(true);
    await storage.set(TOKEN_KEY, token).catch(logFail("auth: saving the session"));
    await storage.set(HAS_ACCOUNT_KEY, "1").catch(logFail("auth: remembering this phone has an account"));
  };

  const value: AuthState = {
    loading,
    token,
    user,
    signIn: async (email, password) => start(await api.login(email, password)),
    signUp: async (email, password, name) => {
      const session = await api.signup(email, password, name);
      // Then the emailed code (app/verify-email.tsx), then the permissions.
      setCodeSentAt(session.codeSent ? Date.now() : null);
      setOnboarding(true);
      await start(session);
    },
    signOut: async () => {
      devlog("log", "auth: signing out");
      // Before the token goes: otherwise the next person to sign in on this
      // phone gets the last one's notifications. Best effort and bounded: offline,
      // the phone signs out anyway (the server's session expires on its own).
      if (token) {
        const tellServer = (async () => {
          await unregisterPush(token);
          await api.logout(token).catch(logFail("auth: api.logout"));
        })();
        await Promise.race([tellServer, new Promise((r) => setTimeout(r, SIGN_OUT_WAIT_MS))]);
      }
      tokenRef.current = null;
      await clear();
    },
    setUser,
    refreshUser,
    onboarding,
    finishOnboarding: () => setOnboarding(false),
    codeSentAt,
    hasAccountHere,
    clear,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

/** For screens behind the auth guard, where token and user are always set. */
export function useSession() {
  const auth = useAuth();
  return { ...auth, token: auth.token!, user: auth.user! };
}
