import type { AttachmentDTO } from "../media/media.types";

export type MessageStatus = "sent" | "delivered" | "read";

export interface MessageSender {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Compact preview of the message being replied to. */
export interface ReplyPreview {
  id: string;
  senderId: string;
  senderDisplayName: string;
  /** Null when the original was deleted or has no text (media without caption). */
  body: string | null;
  contentType: string;
  deleted: boolean;
}

export interface MessageMention {
  userId: string;
  displayName: string;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  senderId: string;
  sender: MessageSender;
  contentType: string;
  body: string | null;
  /**
   * Aggregate receipt status from the sender's point of view: "delivered"
   * / "read" only once *every* recipient who was a member when the message
   * was sent has reached that state. For direct conversations (one
   * recipient) this is identical to the Phase 2 behavior.
   */
  status: MessageStatus;
  createdAt: Date;
  editedAt: Date | null;
  replyTo: ReplyPreview | null;
  mentions: MessageMention[];
  attachment: AttachmentDTO | null;
}

export interface MessagePage {
  items: MessageDTO[];
  hasMore: boolean;
}

export interface SendMessageParams {
  conversationId: string;
  senderId: string;
  body?: string | null;
  replyToMessageId?: string | null;
  mentionedUserIds?: string[];
  attachmentId?: string | null;
}
