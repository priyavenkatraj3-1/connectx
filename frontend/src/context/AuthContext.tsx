import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { clearOfflineDataFor, purgeOfflineDataExcept } from "../lib/offline/storage";
import { ApiError, setSessionEndedHandler } from "../services/apiClient";
import { authService } from "../services/authService";
import type { AuthTokens, AuthUser, LoginPayload, SignupPayload } from "../types/auth";

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
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function readStoredAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredAuth) : null;
  } catch {
    return null;
  }
}

function persistAuth(auth: StoredAuth | null): void {
  if (auth) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/** Seconds-since-epoch expiry of a JWT, or null if the token isn't a readable JWT. */
function tokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Refresh this long before the access token expires. */
const REFRESH_LEAD_MS = 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<StoredAuth | null>(() => readStoredAuth());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedOutReason, setSignedOutReason] = useState<string | null>(null);
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

  // Refresh the access token shortly before it expires (tokens are short-lived; the refresh token rotates).
  useEffect(() => {
    if (!stored) return;
    const exp = tokenExpiry(stored.tokens.accessToken);
    if (exp === null) return;
    const delay = Math.max(0, exp * 1000 - Date.now() - REFRESH_LEAD_MS);
    const timer = setTimeout(() => {
      const refreshToken = stored.tokens.refreshToken;
      authService.refresh(refreshToken).then(
        (result) => {
          if (storedRef.current?.tokens.refreshToken !== refreshToken) return; // signed out/in meanwhile
          const next: StoredAuth = { ...stored, tokens: result.tokens, sessionId: result.session.id };
          setStored(next);
          persistAuth(next);
        },
        (err: unknown) => {
          // A definitive "no" from the server ends the session; network problems just wait for the next attempt.
          if (err instanceof ApiError && err.status === 401) endLocalSession("Your session expired. Please sign in again.");
        }
      );
    }, delay);
    return () => clearTimeout(timer);
  }, [stored, endLocalSession]);

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
    }),
    [stored, isLoading, error, signedOutReason, login, signup, logout, endLocalSession]
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
