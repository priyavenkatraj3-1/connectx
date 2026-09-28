import type { MessageDTO, MessagePage, SendMessageOptions } from "../types/message";
import { apiRequest, buildQueryString } from "./apiClient";

export const messageService = {
  list(accessToken: string, conversationId: string, before?: string): Promise<MessagePage> {
    return apiRequest<MessagePage>(`/messages/${conversationId}${buildQueryString({ before })}`, { accessToken });
  },

  /**
   * Sends a message. `body` may be empty when `extras.attachmentId` is set
   * (a media message without a caption). The Phase 2 call shape
   * `send(token, conversationId, body)` is unchanged.
   */
  async send(
    accessToken: string,
    conversationId: string,
    body: string,
    extras?: Omit<SendMessageOptions, "body">
  ): Promise<MessageDTO> {
    const payload: SendMessageOptions = { ...extras };
    if (body) payload.body = body;
    const { message } = await apiRequest<{ message: MessageDTO }>(`/messages/${conversationId}`, {
      method: "POST",
      body: payload,
      accessToken,
    });
    return message;
  },

  async edit(
    accessToken: string,
    conversationId: string,
    messageId: string,
    body: string,
    mentionedUserIds?: string[]
  ): Promise<MessageDTO> {
    const { message } = await apiRequest<{ message: MessageDTO }>(`/messages/${conversationId}/${messageId}`, {
      method: "PATCH",
      body: { body, mentionedUserIds },
      accessToken,
    });
    return message;
  },

  remove(accessToken: string, conversationId: string, messageId: string): Promise<void> {
    return apiRequest<void>(`/messages/${conversationId}/${messageId}`, { method: "DELETE", accessToken });
  },

  markRead(accessToken: string, conversationId: string, upToMessageId: string): Promise<void> {
    return apiRequest<void>(`/messages/${conversationId}/read`, {
      method: "POST",
      body: { upToMessageId },
      accessToken,
    });
  },
};
