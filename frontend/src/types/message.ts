import type { AttachmentDTO } from "./media";

export type MessageStatus = "sent" | "delivered" | "read";

export interface MessageSender {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface ReplyPreview {
  id: string;
  senderId: string;
  senderDisplayName: string;
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
  /** Phase 3 fields below are optional so Phase 2-shaped payloads still type-check. */
  sender?: MessageSender;
  contentType: string;
  body: string | null;
  status: MessageStatus;
  createdAt: string;
  editedAt: string | null;
  replyTo?: ReplyPreview | null;
  mentions?: MessageMention[];
  attachment?: AttachmentDTO | null;
  /** Phase 6: the sender's idempotency key (matches an offline-queued message to the stored one). */
  clientMessageId?: string | null;
  /** Emoji reactions, one per person (optional: absent in older cached/offline copies). */
  reactions?: MessageReactionSummary[];
  /** Set when this message replied to a status — a snapshot, since statuses expire. */
  statusReply?: { statusId: string; type: "text" | "image" | "video"; preview: string | null } | null;
}

export interface MessageReactionSummary {
  emoji: string;
  count: number;
  userIds: string[];
}

export interface MessagePage {
  items: MessageDTO[];
  hasMore: boolean;
}

export interface SendMessageOptions {
  body?: string;
  replyToMessageId?: string;
  mentionedUserIds?: string[];
  attachmentId?: string;
  clientMessageId?: string;
}
