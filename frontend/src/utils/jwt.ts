/** Seconds-since-epoch expiry of a JWT, or null if the token isn't a readable JWT. Not a signature check. */
export function tokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/** True if the token is a JWT that has expired or will within `leadMs`. Unreadable tokens are left to the server to judge. */
export function isTokenExpiring(token: string, leadMs = 0, now = Date.now()): boolean {
  const exp = tokenExpiry(token);
  return exp !== null && exp * 1000 - now <= leadMs;
}
