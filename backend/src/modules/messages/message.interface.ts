import type { MessageDTO, MessagePage } from "./messages.types";

export type MessageContentType = "text" | "image" | "video" | "audio" | "file";

/**
 * Contract for sending and retrieving messages, implemented for real in
 * Phase 2 by MessagesService (direct conversations only). Reactions remain
 * a later phase.
 */
export interface MessageService {
  sendMessage(input: { conversationId: string; senderId: string; body: string }): Promise<MessageDTO>;
  listMessages(conversationId: string, requestingUserId: string, before?: string, limit?: number): Promise<MessagePage>;
  markRead(conversationId: string, userId: string, upToMessageId: string): Promise<void>;
}
