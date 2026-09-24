import type { MessageDTO, MessagePage } from "../types/message";
import { apiRequest, buildQueryString } from "./apiClient";

export const messageService = {
  list(accessToken: string, conversationId: string, before?: string): Promise<MessagePage> {
    return apiRequest<MessagePage>(`/messages/${conversationId}${buildQueryString({ before })}`, { accessToken });
  },

  async send(accessToken: string, conversationId: string, body: string): Promise<MessageDTO> {
    const { message } = await apiRequest<{ message: MessageDTO }>(`/messages/${conversationId}`, {
      method: "POST",
      body: { body },
      accessToken,
    });
    return message;
  },

  markRead(accessToken: string, conversationId: string, upToMessageId: string): Promise<void> {
    return apiRequest<void>(`/messages/${conversationId}/read`, {
      method: "POST",
      body: { upToMessageId },
      accessToken,
    });
  },
};
