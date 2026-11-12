import type {
  CreateStatusInput,
  OwnStatusDTO,
  StatusDTO,
  StatusListResponse,
  StatusPrivacy,
  StatusViewerDTO,
} from "../types/status";
import { apiRequest } from "./apiClient";

/** Status / stories API. Privacy and expiry are enforced by the server; this client only displays what it's given. */
export const statusService = {
  list(accessToken: string): Promise<StatusListResponse> {
    return apiRequest<StatusListResponse>("/statuses", { accessToken });
  },

  async create(accessToken: string, input: CreateStatusInput): Promise<OwnStatusDTO> {
    const { status } = await apiRequest<{ status: OwnStatusDTO }>("/statuses", { method: "POST", body: input, accessToken });
    return status;
  },

  async get(accessToken: string, statusId: string): Promise<StatusDTO> {
    const { status } = await apiRequest<{ status: StatusDTO }>(`/statuses/${statusId}`, { accessToken });
    return status;
  },

  async markViewed(accessToken: string, statusId: string): Promise<void> {
    await apiRequest(`/statuses/${statusId}/view`, { method: "POST", accessToken });
  },

  /** Replies to someone's status; it arrives as a direct message to them. */
  async reply(accessToken: string, statusId: string, body: string): Promise<{ conversationId: string }> {
    const { conversationId } = await apiRequest<{ conversationId: string }>(`/statuses/${statusId}/reply`, {
      method: "POST",
      body: { body },
      accessToken,
    });
    return { conversationId };
  },

  async viewers(accessToken: string, statusId: string): Promise<StatusViewerDTO[]> {
    const { viewers } = await apiRequest<{ viewers: StatusViewerDTO[] }>(`/statuses/${statusId}/viewers`, { accessToken });
    return viewers;
  },

  remove(accessToken: string, statusId: string): Promise<void> {
    return apiRequest<void>(`/statuses/${statusId}`, { method: "DELETE", accessToken });
  },

  async getPrivacy(accessToken: string): Promise<StatusPrivacy> {
    const { privacy } = await apiRequest<{ privacy: StatusPrivacy }>("/statuses/privacy", { accessToken });
    return privacy;
  },

  async updatePrivacy(accessToken: string, privacy: StatusPrivacy): Promise<StatusPrivacy> {
    const { privacy: saved } = await apiRequest<{ privacy: StatusPrivacy }>("/statuses/privacy", {
      method: "PUT",
      body: privacy,
      accessToken,
    });
    return saved;
  },
};
