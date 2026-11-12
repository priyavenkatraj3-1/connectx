import type { MessageDTO, MessagePage, MessageReactionSummary, SendMessageOptions } from "../types/message";
import { apiRequest, buildQueryString, generateUuid, NetworkError } from "./apiClient";

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
    // Phase 6: every send carries an idempotency key. If the network drops
    // mid-request, the NetworkError carries the key so the offline outbox
    // can retry with it — the server then returns the original message
    // instead of posting a duplicate.
    const payload: SendMessageOptions = { ...extras, clientMessageId: extras?.clientMessageId ?? generateUuid() };
    if (body) payload.body = body;
    try {
      const { message } = await apiRequest<{ message: MessageDTO }>(`/messages/${conversationId}`, {
        method: "POST",
        body: payload,
        accessToken,
      });
      return message;
    } catch (err) {
      if (err instanceof NetworkError) throw new NetworkError(err.message, payload.clientMessageId);
      throw err;
    }
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

  /** Messages in this chat containing `query` (case-insensitive), newest first (at most 30). */
  async search(accessToken: string, conversationId: string, query: string): Promise<MessageDTO[]> {
    const { results } = await apiRequest<{ results: MessageDTO[] }>(`/messages/${conversationId}/search${buildQueryString({ q: query })}`, {
      accessToken,
    });
    return results;
  },

  /** Sets your reaction (replacing any previous one), or removes it with `null`. Resolves to the message's reactions. */
  async react(accessToken: string, conversationId: string, messageId: string, emoji: string | null): Promise<MessageReactionSummary[]> {
    const { reactions } = await apiRequest<{ reactions: MessageReactionSummary[] }>(`/messages/${conversationId}/${messageId}/reaction`, {
      method: emoji ? "PUT" : "DELETE",
      body: emoji ? { emoji } : undefined,
      accessToken,
    });
    return reactions;
  },

  markRead(accessToken: string, conversationId: string, upToMessageId: string): Promise<void> {
    return apiRequest<void>(`/messages/${conversationId}/read`, {
      method: "POST",
      body: { upToMessageId },
      accessToken,
    });
  },
};
