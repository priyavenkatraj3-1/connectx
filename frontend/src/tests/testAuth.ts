import type { AuthTokens, AuthUser } from "../types/auth";

const STORAGE_KEY = "connectx.auth";

/** Seeds localStorage with a signed-in session in the same shape AuthContext reads, for tests that need an authenticated user without hitting the network. */
export function seedAuthenticatedSession(overrides: Partial<AuthUser> = {}): { user: AuthUser; tokens: AuthTokens } {
  const user: AuthUser = {
    id: overrides.id ?? "user-1",
    email: overrides.email ?? "test@example.com",
    displayName: overrides.displayName ?? "Test User",
  };
  const tokens: AuthTokens = { accessToken: "test-access-token", refreshToken: "test-refresh-token" };
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ user, tokens }));
  return { user, tokens };
}
