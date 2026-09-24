import type { AuthResult, LoginPayload, SignupPayload } from "../types/auth";
import { apiRequest } from "./apiClient";

export const authService = {
  signup(payload: SignupPayload): Promise<AuthResult> {
    return apiRequest<AuthResult>("/auth/signup", { method: "POST", body: payload });
  },

  login(payload: LoginPayload): Promise<AuthResult> {
    return apiRequest<AuthResult>("/auth/login", { method: "POST", body: payload });
  },

  logout(accessToken: string): Promise<void> {
    return apiRequest<void>("/auth/logout", { method: "POST", accessToken });
  },
};
