import type { OwnProfile, ProfileUpdateInput, PublicProfile } from "../types/user";
import { apiRequest, buildQueryString } from "./apiClient";

export const userService = {
  getMe(accessToken: string): Promise<OwnProfile> {
    return apiRequest<OwnProfile>("/users/me", { accessToken });
  },

  updateMe(accessToken: string, updates: ProfileUpdateInput): Promise<OwnProfile> {
    return apiRequest<OwnProfile>("/users/me", { method: "PATCH", body: updates, accessToken });
  },

  getPublicProfile(accessToken: string, userId: string): Promise<PublicProfile> {
    return apiRequest<PublicProfile>(`/users/${userId}`, { accessToken });
  },

  async search(accessToken: string, query: string): Promise<PublicProfile[]> {
    if (!query.trim()) return [];
    const { results } = await apiRequest<{ results: PublicProfile[] }>(
      `/users/search${buildQueryString({ q: query })}`,
      { accessToken }
    );
    return results;
  },
};
