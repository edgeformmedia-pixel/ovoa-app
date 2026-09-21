import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type User } from "./api";
import { unregisterPush } from "./push";
import { setLogToken } from "./remoteLog";
import { storage } from "./storage";

// Storage key kept from the original app name so existing sign-ins survive.
const TOKEN_KEY = "jarvis.session";

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
  /** Forget the session locally (e.g. after deleting the account). */
  clear: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [onboarding, setOnboarding] = useState(false);

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
      try {
        const saved = await storage.get(TOKEN_KEY);
        if (!saved) return;
        const { user } = await api.me(saved);
        setToken(saved);
        setUser(user);
      } catch (err) {
        // Expired or revoked session: start signed out. Keep the token on network errors.
        if (err instanceof ApiError && err.status === 401) await storage.remove(TOKEN_KEY);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const start = async ({ token, user }: { token: string; user: User }) => {
    await storage.set(TOKEN_KEY, token);
    setToken(token);
    setUser(user);
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
      // Before the token goes: otherwise the next person to sign in on this
      // phone gets the last one's notifications.
      if (token) {
        await unregisterPush(token);
        await api.logout(token).catch(() => {});
      }
      await clear();
    },
    setUser,
    onboarding,
    finishOnboarding: () => setOnboarding(false),
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
