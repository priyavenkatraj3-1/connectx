import type { AuthResult, AuthTokens, DevicePayload, LoginPayload, SignupPayload } from "../types/auth";
import { apiRequest } from "./apiClient";

/** A human-readable name for this browser ("Chrome on Windows"), shown in Settings → Devices. */
export function describeThisDevice(): DevicePayload {
  if (typeof navigator === "undefined") return { platform: "web" };
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad/.test(ua)
        ? "iOS"
        : /Mac OS X/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  const name = browser && os ? `${browser} on ${os}` : (browser ?? os ?? undefined);
  return name ? { name, platform: "web" } : { platform: "web" };
}

export const authService = {
  signup(payload: SignupPayload): Promise<AuthResult> {
    return apiRequest<AuthResult>("/auth/signup", { method: "POST", body: { ...payload, device: describeThisDevice() } });
  },

  login(payload: LoginPayload): Promise<AuthResult> {
    return apiRequest<AuthResult>("/auth/login", { method: "POST", body: { ...payload, device: describeThisDevice() } });
  },

  /** Exchanges the refresh token for a new pair (the refresh token rotates on every use). */
  refresh(refreshToken: string): Promise<{ tokens: AuthTokens; session: { id: string } }> {
    return apiRequest("/auth/refresh", { method: "POST", body: { refreshToken } });
  },

  logout(accessToken: string): Promise<void> {
    return apiRequest<void>("/auth/logout", { method: "POST", accessToken });
  },
};
