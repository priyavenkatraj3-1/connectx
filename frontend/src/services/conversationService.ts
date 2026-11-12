import type { ChatPreferences, ConversationSummary, MuteOption } from "../types/conversation";
import { apiRequest } from "./apiClient";

interface ConversationRef {
  id: string;
}

export const conversationService = {
  async list(accessToken: string): Promise<ConversationSummary[]> {
    const { conversations } = await apiRequest<{ conversations: ConversationSummary[] }>("/conversations", {
      accessToken,
    });
    return conversations;
  },

  /** Your own pin/archive/mute settings for a chat. */
  async updatePreferences(
    accessToken: string,
    conversationId: string,
    changes: { pinned?: boolean; archived?: boolean; mute?: MuteOption }
  ): Promise<ChatPreferences> {
    const { preferences } = await apiRequest<{ preferences: ChatPreferences }>(`/conversations/${conversationId}/preferences`, {
      method: "PATCH",
      body: changes,
      accessToken,
    });
    return preferences;
  },

  async createDirect(accessToken: string, otherUserId: string): Promise<ConversationRef> {
    const { conversation } = await apiRequest<{ conversation: ConversationRef }>("/conversations/direct", {
      method: "POST",
      body: { userId: otherUserId },
      accessToken,
    });
    return conversation;
  },
};
