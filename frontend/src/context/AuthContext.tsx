import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { authService } from "../services/authService";
import type { AuthTokens, AuthUser, LoginPayload, SignupPayload } from "../types/auth";

const STORAGE_KEY = "connectx.auth";

interface StoredAuth {
  user: AuthUser;
  tokens: AuthTokens;
}

interface AuthContextValue {
  user: AuthUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login(payload: LoginPayload): Promise<void>;
  signup(payload: SignupPayload): Promise<void>;
  logout(): Promise<void>;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<StoredAuth | null>(() => readStoredAuth());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (payload: LoginPayload) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await authService.login(payload);
      const next: StoredAuth = { user: result.user, tokens: result.tokens };
      setStored(next);
      persistAuth(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const signup = useCallback(async (payload: SignupPayload) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await authService.signup(payload);
      const next: StoredAuth = { user: result.user, tokens: result.tokens };
      setStored(next);
      persistAuth(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed");
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    if (stored) {
      await authService.logout(stored.tokens.accessToken).catch(() => undefined);
    }
    setStored(null);
    persistAuth(null);
  }, [stored]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: stored?.user ?? null,
      accessToken: stored?.tokens.accessToken ?? null,
      isAuthenticated: Boolean(stored),
      isLoading,
      error,
      login,
      signup,
      logout,
    }),
    [stored, isLoading, error, login, signup, logout]
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
