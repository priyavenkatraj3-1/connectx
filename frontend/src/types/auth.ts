export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  /** Your profile picture. Not part of sign-in responses: filled in from your profile once the app loads. */
  avatarUrl?: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  user: AuthUser;
  tokens: AuthTokens;
  /** Phase 6: this sign-in's server-side session (one per device). */
  session?: { id: string };
}

export interface DevicePayload {
  name?: string;
  platform?: "web" | "ios" | "android" | "desktop";
}

export interface SignupPayload {
  email: string;
  password: string;
  displayName: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}
