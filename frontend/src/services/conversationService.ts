import type { ConversationSummary } from "../types/conversation";
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

  async createDirect(accessToken: string, otherUserId: string): Promise<ConversationRef> {
    const { conversation } = await apiRequest<{ conversation: ConversationRef }>("/conversations/direct", {
      method: "POST",
      body: { userId: otherUserId },
      accessToken,
    });
    return conversation;
  },
};
