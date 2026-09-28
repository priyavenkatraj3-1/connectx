import type { CreateGroupPayload, GroupDetails, UpdateGroupPayload } from "../types/group";
import { apiRequest } from "./apiClient";

export const groupService = {
  create(accessToken: string, payload: CreateGroupPayload): Promise<GroupDetails> {
    return apiRequest<GroupDetails>("/groups", { method: "POST", body: payload, accessToken });
  },

  get(accessToken: string, groupId: string): Promise<GroupDetails> {
    return apiRequest<GroupDetails>(`/groups/${groupId}`, { accessToken });
  },

  update(accessToken: string, groupId: string, payload: UpdateGroupPayload): Promise<GroupDetails> {
    return apiRequest<GroupDetails>(`/groups/${groupId}`, { method: "PATCH", body: payload, accessToken });
  },

  addMembers(accessToken: string, groupId: string, userIds: string[]): Promise<GroupDetails> {
    return apiRequest<GroupDetails>(`/groups/${groupId}/members`, { method: "POST", body: { userIds }, accessToken });
  },

  removeMember(accessToken: string, groupId: string, userId: string): Promise<GroupDetails> {
    return apiRequest<GroupDetails>(`/groups/${groupId}/members/${userId}`, { method: "DELETE", accessToken });
  },

  changeRole(accessToken: string, groupId: string, userId: string, role: "admin" | "member"): Promise<GroupDetails> {
    return apiRequest<GroupDetails>(`/groups/${groupId}/members/${userId}/role`, {
      method: "PATCH",
      body: { role },
      accessToken,
    });
  },

  leave(accessToken: string, groupId: string): Promise<{ newOwnerId: string | null }> {
    return apiRequest<{ newOwnerId: string | null }>(`/groups/${groupId}/leave`, { method: "POST", accessToken });
  },
};
