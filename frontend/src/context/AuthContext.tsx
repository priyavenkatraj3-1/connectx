import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { clearOfflineDataFor, purgeOfflineDataExcept } from "../lib/offline/storage";
import { ApiError, setAccessTokenRefresher, setSessionEndedHandler } from "../services/apiClient";
import { authService } from "../services/authService";
import type { AuthTokens, AuthUser, LoginPayload, SignupPayload } from "../types/auth";
import { isTokenExpiring, tokenExpiry } from "../utils/jwt";

const STORAGE_KEY = "connectx.auth";

interface StoredAuth {
  user: AuthUser;
  tokens: AuthTokens;
  /** Phase 6: this device's server-side session (absent for sessions stored before Phase 6). */
  sessionId?: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  accessToken: string | null;
  /** This device's session ID — lets the device list and `session:revoked` events recognize it. */
  sessionId: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  /** Set when this device was signed out remotely (from another device, or the session expired). */
  signedOutReason: string | null;
  login(payload: LoginPayload): Promise<void>;
  signup(payload: SignupPayload): Promise<void>;
  logout(): Promise<void>;
  /** Drops the local session without calling the server (it already ended server-side). */
  endLocalSession(reason: string): void;
  /**
   * Exchanges the refresh token for a new access token now (concurrent
   * calls share one request). Resolves to the new token, or null if the
   * session couldn't be refreshed — after a definitive 401 it is ended.
   */
  refreshAccessToken(): Promise<string | null>;
  /** Updates the signed-in user's name/picture after a profile change (kept across reloads). */
  updateUser(changes: Partial<Pick<AuthUser, "displayName" | "avatarUrl">>): void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function parseStoredAuth(raw: string | null): StoredAuth | null {
  try {
    return raw ? (JSON.parse(raw) as StoredAuth) : null;
  } catch {
    return null;
  }
}

function readStoredAuth(): StoredAuth | null {
  try {
    return parseStoredAuth(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Same account and same device session (tabs of one browser share it). */
function isSameSession(a: StoredAuth, b: StoredAuth): boolean {
  return a.user.id === b.user.id && a.sessionId === b.sessionId;
}

const REFRESH_LOCK_NAME = "connectx.auth.refresh";

/**
 * Runs `task` while holding a browser-wide lock (Web Locks API), so only one
 * tab refreshes at a time. Without the API, tabs still re-read the shared
 * tokens first and sync via `storage` events, which covers all but truly
 * simultaneous refreshes.
 */
function withCrossTabRefreshLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks?.request ? (locks.request(REFRESH_LOCK_NAME, task) as Promise<T>) : task();
}

function persistAuth(auth: StoredAuth | null): void {
  if (auth) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/** Refresh this long before the access token expires. */
const REFRESH_LEAD_MS = 60_000;
/** After a refresh that failed without a definitive answer (offline, server waking up), try again this soon. */
const REFRESH_RETRY_MS = 15_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<StoredAuth | null>(() => readStoredAuth());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedOutReason, setSignedOutReason] = useState<string | null>(null);
  /** Bumped when a refresh fails on the network, so the refresh timer is re-armed. */
  const [refreshFailures, setRefreshFailures] = useState(0);
  const storedRef = useRef(stored);
  storedRef.current = stored;

  const acceptResult = useCallback((result: { user: AuthUser; tokens: AuthTokens; session?: { id: string } }) => {
    // Offline data from any *other* account that used this browser is removed at sign-in.
    purgeOfflineDataExcept(result.user.id);
    const next: StoredAuth = { user: result.user, tokens: result.tokens, sessionId: result.session?.id };
    setStored(next);
    persistAuth(next);
    setSignedOutReason(null);
  }, []);

  const login = useCallback(
    async (payload: LoginPayload) => {
      setIsLoading(true);
      setError(null);
      try {
        acceptResult(await authService.login(payload));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Login failed");
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [acceptResult]
  );

  const signup = useCallback(
    async (payload: SignupPayload) => {
      setIsLoading(true);
      setError(null);
      try {
        acceptResult(await authService.signup(payload));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Signup failed");
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [acceptResult]
  );

  const endLocalSession = useCallback((reason: string) => {
    const current = storedRef.current;
    if (current) clearOfflineDataFor(current.user.id);
    setStored(null);
    persistAuth(null);
    setSignedOutReason(reason);
  }, []);

  const updateUser = useCallback((changes: Partial<Pick<AuthUser, "displayName" | "avatarUrl">>) => {
    const current = storedRef.current;
    if (!current) return;
    const user = { ...current.user, ...changes };
    if (user.displayName === current.user.displayName && user.avatarUrl === current.user.avatarUrl) return;
    const next: StoredAuth = { ...current, user };
    storedRef.current = next;
    setStored(next);
    persistAuth(next);
  }, []);

  const logout = useCallback(async () => {
    if (stored) {
      await authService.logout(stored.tokens.accessToken).catch(() => undefined);
      clearOfflineDataFor(stored.user.id);
    }
    setStored(null);
    persistAuth(null);
  }, [stored]);

  // The server reports this device's session as ended → sign out here too.
  useEffect(() => {
    setSessionEndedHandler(() => endLocalSession("This device was signed out. Please sign in again."));
    return () => setSessionEndedHandler(null);
  }, [endLocalSession]);

  /** Uses tokens another tab already obtained for this same session. */
  const adoptSharedTokens = useCallback((shared: StoredAuth) => {
    storedRef.current = shared;
    setStored(shared);
  }, []);

  // One refresh at a time, across every tab: the refresh token rotates and
  // tabs share it through localStorage, so presenting a copy another tab has
  // already rotated is treated by the server as reuse (token theft) and ends
  // the session everywhere. Within a tab, concurrent callers share one request.
  const refreshInFlight = useRef<Promise<string | null> | null>(null);
  const refreshAccessToken = useCallback((): Promise<string | null> => {
    if (refreshInFlight.current) return refreshInFlight.current;
    if (!storedRef.current) return Promise.resolve(null);
    const request = withCrossTabRefreshLock(async () => {
      const current = storedRef.current;
      if (!current) return null;
      // Inside the lock, the stored copy is the latest: another tab may have rotated the tokens while we waited.
      const shared = readStoredAuth();
      let base = current;
      if (shared && isSameSession(shared, current) && shared.tokens.refreshToken !== current.tokens.refreshToken) {
        adoptSharedTokens(shared);
        if (!isTokenExpiring(shared.tokens.accessToken, REFRESH_LEAD_MS)) return shared.tokens.accessToken;
        base = shared;
      }
      const refreshToken = base.tokens.refreshToken;
      try {
        const result = await authService.refresh(refreshToken);
        const latest = storedRef.current;
        if (latest?.tokens.refreshToken !== refreshToken) return latest?.tokens.accessToken ?? null; // signed out/in meanwhile
        const next: StoredAuth = { ...latest, tokens: result.tokens, sessionId: result.session.id };
        storedRef.current = next;
        setStored(next);
        persistAuth(next);
        setRefreshFailures(0);
        return result.tokens.accessToken;
      } catch (err) {
        // A definitive "no" from the server ends the session; network problems are retried shortly.
        if (err instanceof ApiError && err.status === 401) endLocalSession("Your session expired. Please sign in again.");
        else setRefreshFailures((n) => n + 1);
        return null;
      }
    }).finally(() => {
      refreshInFlight.current = null;
    });
    refreshInFlight.current = request;
    return request;
  }, [endLocalSession, adoptSharedTokens]);

  // Another tab refreshed this session's tokens: use them, so this tab never
  // presents the rotated-out refresh token. Sign-ins of other accounts are ignored.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      const current = storedRef.current;
      const shared = parseStoredAuth(event.newValue);
      if (current && shared && isSameSession(shared, current) && shared.tokens.refreshToken !== current.tokens.refreshToken) {
        adoptSharedTokens(shared);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [adoptSharedTokens]);

  // Requests rejected for an expired access token refresh it and retry once (see apiClient).
  useEffect(() => {
    setAccessTokenRefresher(refreshAccessToken);
    return () => setAccessTokenRefresher(null);
  }, [refreshAccessToken]);

  // Refresh the access token shortly before it expires (tokens are short-lived; the refresh token rotates).
  // A refresh that failed on the network is retried after REFRESH_RETRY_MS rather than never.
  useEffect(() => {
    if (!stored) return;
    const exp = tokenExpiry(stored.tokens.accessToken);
    if (exp === null) return;
    const dueIn = exp * 1000 - Date.now() - REFRESH_LEAD_MS;
    const delay = refreshFailures > 0 && dueIn <= 0 ? REFRESH_RETRY_MS : Math.max(0, dueIn);
    // Re-checked when it fires: another caller may have refreshed the token in the meantime.
    const timer = setTimeout(() => {
      if (isTokenExpiring(storedRef.current?.tokens.accessToken ?? "", REFRESH_LEAD_MS)) void refreshAccessToken();
    }, delay);
    return () => clearTimeout(timer);
  }, [stored, refreshAccessToken, refreshFailures]);

  // Timers don't run while the computer sleeps and are throttled in background
  // tabs, so the access token can expire unnoticed. Check again on wake-up.
  useEffect(() => {
    if (!stored) return;
    const checkExpiry = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (isTokenExpiring(storedRef.current?.tokens.accessToken ?? "", REFRESH_LEAD_MS)) void refreshAccessToken();
    };
    window.addEventListener("focus", checkExpiry);
    window.addEventListener("online", checkExpiry);
    document.addEventListener("visibilitychange", checkExpiry);
    return () => {
      window.removeEventListener("focus", checkExpiry);
      window.removeEventListener("online", checkExpiry);
      document.removeEventListener("visibilitychange", checkExpiry);
    };
  }, [stored, refreshAccessToken]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: stored?.user ?? null,
      accessToken: stored?.tokens.accessToken ?? null,
      sessionId: stored?.sessionId ?? null,
      isAuthenticated: Boolean(stored),
      isLoading,
      error,
      signedOutReason,
      login,
      signup,
      logout,
      endLocalSession,
      refreshAccessToken,
      updateUser,
    }),
    [stored, isLoading, error, signedOutReason, login, signup, logout, endLocalSession, refreshAccessToken, updateUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
