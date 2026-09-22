import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { devlog, logFail } from "./devlog";
import { api, ApiError, type User } from "./api";
import { unregisterPush } from "./push";
import { setLogToken } from "./remoteLog";
import { storage } from "./storage";

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
  /** True right after sign-up, until the "connect Google" step is finished or skipped. */
  onboarding: boolean;
  finishOnboarding: () => void;
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
  const [onboarding, setOnboarding] = useState(false);
  const [hasAccountHere, setHasAccountHere] = useState(false);

  // Server-side logs get tagged with whoever is signed in.
  useEffect(() => setLogToken(token), [token]);

  const clear = useCallback(async () => {
    await storage.remove(TOKEN_KEY);
    setOnboarding(false);
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    (async () => {
      // Before setLoading(false), so the sign-in screen never renders the wrong form first.
      const seen = await storage.get(HAS_ACCOUNT_KEY).catch(logFail("auth: reading hasAccount"));
      setHasAccountHere(seen === "1");
      try {
        const saved = await storage.get(TOKEN_KEY);
        if (!saved) {
          devlog("log", `auth: no saved session (this phone has ${seen === "1" ? "" : "never "}signed in before)`);
          return;
        }
        const { user } = await api.me(saved);
        setToken(saved);
        setUser(user);
        devlog("log", `auth: session restored for ${user.name}`);
      } catch (err) {
        // Expired or revoked session: start signed out. Keep the token on network errors.
        const status = err instanceof ApiError ? err.status : 0;
        devlog(
          "warn",
          `auth: couldn't use the saved session (${status || "no reply"})`,
          err instanceof Error ? err.message : String(err),
        );
        if (status === 401) await storage.remove(TOKEN_KEY).catch(logFail("auth: clearing a dead token"));
      } finally {
        setLoading(false);
      }
    })();
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
      setOnboarding(true);
      await start(session);
    },
    signOut: async () => {
      devlog("log", "auth: signing out");
      // Before the token goes: otherwise the next person to sign in on this
      // phone gets the last one's notifications.
      if (token) {
        await unregisterPush(token);
        await api.logout(token).catch(logFail("auth: api.logout"));
      }
      await clear();
    },
    setUser,
    onboarding,
    finishOnboarding: () => setOnboarding(false),
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
