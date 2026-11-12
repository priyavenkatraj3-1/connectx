import type { ContactProfile, OwnProfile, ProfileUpdateInput, PublicProfile } from "../types/user";
import { API_BASE_URL, ApiError, apiRequest, buildQueryString, NetworkError, refreshAfterUnauthorized, reportUnauthorized } from "./apiClient";

export const userService = {
  getMe(accessToken: string): Promise<OwnProfile> {
    return apiRequest<OwnProfile>("/users/me", { accessToken });
  },

  updateMe(accessToken: string, updates: ProfileUpdateInput): Promise<OwnProfile> {
    return apiRequest<OwnProfile>("/users/me", { method: "PATCH", body: updates, accessToken });
  },

  getPublicProfile(accessToken: string, userId: string): Promise<ContactProfile> {
    return apiRequest<ContactProfile>(`/users/${userId}`, { accessToken });
  },

  /**
   * Replaces your profile picture with `image` (sent as raw bytes; the
   * server checks the type from the bytes). Abort with `signal` to cancel.
   * Retries once with a refreshed token if the access token had expired.
   */
  async uploadAvatar(accessToken: string, image: Blob, signal?: AbortSignal): Promise<OwnProfile> {
    const send = async (token: string): Promise<OwnProfile> => {
      let response: Response;
      try {
        response = await fetch(`${API_BASE_URL}/users/me/avatar`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": image.type || "application/octet-stream" },
          body: image,
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw new ApiError("Upload cancelled", 0);
        throw new NetworkError(err instanceof Error && err.message ? `Network error: ${err.message}` : undefined);
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const code = typeof data?.error?.code === "string" ? (data.error.code as string) : undefined;
        reportUnauthorized(response.status, code);
        throw new ApiError(data?.error?.message ?? "Couldn't upload your picture. Please try again.", response.status, code);
      }
      return data as OwnProfile;
    };
    try {
      return await send(accessToken);
    } catch (err) {
      if (!(err instanceof ApiError) || signal?.aborted) throw err;
      const refreshed = await refreshAfterUnauthorized(err.status, err.code, accessToken);
      if (!refreshed) throw err;
      return send(refreshed);
    }
  },

  removeAvatar(accessToken: string): Promise<OwnProfile> {
    return apiRequest<OwnProfile>("/users/me/avatar", { method: "DELETE", accessToken });
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
