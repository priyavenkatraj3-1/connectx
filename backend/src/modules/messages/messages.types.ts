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
  /**
   * The sender's idempotency key (Phase 6 offline outbox), echoed back so a
   * client can match a queued message to the one the server stored. A
   * random UUID chosen by the sender; carries no content.
   */
  clientMessageId: string | null;
  /** Emoji reactions, one per person, in the order each emoji was first used. */
  reactions: MessageReactionSummary[];
  /** Set when this message is a reply to a status (a snapshot: the status itself may have expired since). */
  statusReply: StatusReplyReference | null;
}

export interface StatusReplyReference {
  statusId: string;
  type: "text" | "image" | "video";
  /** The status text or caption, shortened; null for media without a caption. */
  preview: string | null;
}

/** One emoji on a message: how many people chose it and who (members can see each other in the chat anyway). */
export interface MessageReactionSummary {
  emoji: string;
  count: number;
  userIds: string[];
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
  /** Idempotency key: re-sending with the same key returns the original message instead of a duplicate. */
  clientMessageId?: string | null;
  /** Server-set only (StatusRepliesService), never taken from a request body. */
  statusReply?: StatusReplyReference | null;
}
