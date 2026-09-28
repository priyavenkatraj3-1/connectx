import type { MessageDTO, MessagePage, SendMessageParams } from "./messages.types";

export type MessageContentType = "text" | "image" | "video" | "audio" | "file";

/**
 * Contract for sending and retrieving messages, implemented by
 * MessagesService for direct (Phase 2) and group (Phase 3) conversations,
 * including replies, @mentions, attachments, and author-only edit/delete.
 * Reactions remain a later phase.
 */
export interface MessageService {
  sendMessage(input: SendMessageParams): Promise<MessageDTO>;
  listMessages(conversationId: string, requestingUserId: string, before?: string, limit?: number): Promise<MessagePage>;
  editMessage(input: {
    conversationId: string;
    messageId: string;
    userId: string;
    body: string;
    mentionedUserIds?: string[];
  }): Promise<MessageDTO>;
  deleteMessage(input: { conversationId: string; messageId: string; userId: string }): Promise<void>;
  markRead(conversationId: string, userId: string, upToMessageId: string): Promise<void>;
}
