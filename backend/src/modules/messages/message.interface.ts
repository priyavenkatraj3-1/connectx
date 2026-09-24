export type MessageContentType = "text" | "image" | "video" | "audio" | "file";

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  contentType: MessageContentType;
  body: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

/**
 * Contract for sending, retrieving, and reacting to messages. Implemented in
 * a later phase once real-time transport (WebSockets) and the `messages` /
 * `message_reactions` tables are wired up.
 */
export interface MessageService {
  sendMessage(input: {
    conversationId: string;
    senderId: string;
    contentType: MessageContentType;
    body: string | null;
  }): Promise<Message>;
  listMessages(conversationId: string, requestingUserId: string, cursor?: string): Promise<Message[]>;
  deleteMessage(messageId: string, requestingUserId: string): Promise<void>;
  addReaction(messageId: string, userId: string, emoji: string): Promise<void>;
}
