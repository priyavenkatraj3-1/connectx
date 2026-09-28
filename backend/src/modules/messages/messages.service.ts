import type { MessageService } from "./message.interface";
import { AppError } from "../../middleware/errorHandler";
import { broadcast } from "../../realtime/broadcast";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import type { ConversationsRepository } from "../conversations/conversations.repository";
import type { ActiveMembership } from "../conversations/conversations.types";
import type { MediaRepository } from "../media/media.repository";
import type { StorageProvider } from "../media/storage/storage-provider.interface";
import { aggregateStatus, AttachmentUnavailableError, type MessagesRepository } from "./messages.repository";
import type { MessageDTO, MessagePage, MessageStatus, SendMessageParams } from "./messages.types";

/** Attachment kind → messages.content_type (the Phase 1 CHECK constraint has no 'document'). */
const CONTENT_TYPE_BY_KIND = {
  image: "image",
  video: "video",
  audio: "audio",
  document: "file",
  file: "file",
} as const;

export class MessagesService implements MessageService {
  constructor(
    private readonly messagesRepository: MessagesRepository,
    private readonly conversationsRepository: ConversationsRepository,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly mediaRepository: MediaRepository,
    private readonly storage: StorageProvider
  ) {}

  private async requireMembership(conversationId: string, userId: string): Promise<ActiveMembership> {
    const membership = await this.conversationsRepository.getActiveMembership(conversationId, userId);
    if (!membership) {
      throw new AppError("You do not have access to this conversation", 403);
    }
    return membership;
  }

  /** Mentioned users must be active members of the conversation. The sender mentioning themselves is silently dropped. */
  private normalizeMentions(
    mentionedUserIds: string[] | undefined,
    senderId: string,
    members: ActiveMembership[]
  ): string[] {
    const unique = [...new Set(mentionedUserIds ?? [])].filter((id) => id !== senderId);
    const memberIds = new Set(members.map((member) => member.userId));
    if (unique.some((id) => !memberIds.has(id))) {
      throw new AppError("Mentioned users must be members of this conversation", 400);
    }
    return unique;
  }

  async sendMessage(input: SendMessageParams): Promise<MessageDTO> {
    const conversation = await this.conversationsRepository.getById(input.conversationId);
    if (!conversation) throw new AppError("Conversation not found", 404);
    await this.requireMembership(input.conversationId, input.senderId);
    const members = await this.conversationsRepository.getActiveMembers(input.conversationId);

    const body = input.body && input.body.length > 0 ? input.body : null;

    let replyToMessageId: string | null = null;
    if (input.replyToMessageId) {
      const original = await this.messagesRepository.findRecordById(input.replyToMessageId);
      if (
        !original ||
        original.conversationId !== input.conversationId ||
        !(await this.messagesRepository.isVisibleTo(original.id, input.senderId))
      ) {
        throw new AppError("The message you are replying to is not available", 400);
      }
      replyToMessageId = original.id;
    }

    const mentionedUserIds = this.normalizeMentions(input.mentionedUserIds, input.senderId, members);

    let contentType = "text";
    if (input.attachmentId) {
      const attachment = await this.mediaRepository.findById(input.attachmentId);
      if (!attachment || attachment.uploaderId !== input.senderId) {
        throw new AppError("Attachment not found", 404);
      }
      if (attachment.conversationId !== input.conversationId) {
        throw new AppError("Attachment belongs to a different conversation", 400);
      }
      if (attachment.messageId !== null) {
        throw new AppError("Attachment has already been sent", 409);
      }
      contentType = CONTENT_TYPE_BY_KIND[attachment.kind];
    } else if (!body) {
      throw new AppError("Message cannot be empty", 400);
    }

    let messageId: string;
    try {
      messageId = await this.messagesRepository.create({
        conversationId: input.conversationId,
        senderId: input.senderId,
        contentType,
        body,
        replyToMessageId,
        mentionedUserIds,
        attachmentId: input.attachmentId ?? null,
      });
    } catch (err) {
      if (err instanceof AttachmentUnavailableError) throw new AppError("Attachment has already been sent", 409);
      throw err;
    }
    await this.conversationsRepository.touchUpdatedAt(input.conversationId);

    const recipientIds = members.map((member) => member.userId).filter((id) => id !== input.senderId);
    const onlineRecipientIds = recipientIds.filter((id) => this.realtimeGateway.isUserOnline(id));
    for (const recipientId of onlineRecipientIds) {
      await this.messagesRepository.markDelivered(messageId, recipientId);
    }

    const message = (await this.messagesRepository.findById(messageId, members))!;

    if (conversation.type === "direct") {
      // Phase 2 protocol, unchanged: one delivered event per online recipient.
      for (const recipientId of onlineRecipientIds) {
        this.realtimeGateway.sendToUser(input.senderId, {
          type: "message:delivered",
          conversationId: input.conversationId,
          messageId,
          userId: recipientId,
        });
      }
    } else if (message.status !== "sent") {
      this.realtimeGateway.sendToUser(input.senderId, {
        type: "message:status",
        conversationId: input.conversationId,
        messageIds: [messageId],
        status: message.status,
      });
    }

    broadcast(this.realtimeGateway, recipientIds, { type: "message:new", conversationId: input.conversationId, message });
    // Echo to the sender's own other connections (multi-tab/multi-device sync).
    this.realtimeGateway.sendToUser(input.senderId, { type: "message:new", conversationId: input.conversationId, message });

    return message;
  }

  async listMessages(
    conversationId: string,
    requestingUserId: string,
    before?: string,
    limit?: number
  ): Promise<MessagePage> {
    await this.requireMembership(conversationId, requestingUserId);
    const members = await this.conversationsRepository.getActiveMembers(conversationId);
    return this.messagesRepository.listByConversation(conversationId, requestingUserId, members, before, limit);
  }

  /** Loads a message for an author-only mutation, enforcing conversation membership and authorship. */
  private async requireOwnMessage(conversationId: string, messageId: string, userId: string) {
    await this.requireMembership(conversationId, userId);
    const message = await this.messagesRepository.findRecordById(messageId);
    if (!message || message.conversationId !== conversationId || message.deletedAt !== null) {
      throw new AppError("Message not found", 404);
    }
    if (message.senderId !== userId) {
      throw new AppError("You can only modify your own messages", 403);
    }
    return message;
  }

  async editMessage(input: {
    conversationId: string;
    messageId: string;
    userId: string;
    body: string;
    mentionedUserIds?: string[];
  }): Promise<MessageDTO> {
    const existing = await this.requireOwnMessage(input.conversationId, input.messageId, input.userId);
    const members = await this.conversationsRepository.getActiveMembers(input.conversationId);

    const body = input.body.length > 0 ? input.body : null;
    if (!body && existing.contentType === "text") {
      throw new AppError("Message cannot be empty", 400);
    }
    const mentionedUserIds = this.normalizeMentions(input.mentionedUserIds, input.userId, members);

    await this.messagesRepository.updateBody(input.messageId, body, mentionedUserIds);
    const message = (await this.messagesRepository.findById(input.messageId, members))!;

    broadcast(
      this.realtimeGateway,
      members.map((member) => member.userId),
      { type: "message:updated", conversationId: input.conversationId, message }
    );
    return message;
  }

  async deleteMessage(input: { conversationId: string; messageId: string; userId: string }): Promise<void> {
    await this.requireOwnMessage(input.conversationId, input.messageId, input.userId);

    const storageKeys = await this.messagesRepository.softDelete(input.messageId);
    // Metadata is already gone; stored bytes are removed best-effort (an
    // orphaned file is unreachable through the API either way).
    await Promise.all(storageKeys.map((key) => this.storage.delete(key).catch(() => undefined)));

    const memberIds = await this.conversationsRepository.getAllMemberIds(input.conversationId);
    broadcast(this.realtimeGateway, memberIds, {
      type: "message:deleted",
      conversationId: input.conversationId,
      messageId: input.messageId,
    });
  }

  async markRead(conversationId: string, userId: string, upToMessageId: string): Promise<void> {
    // Enforced here (not only in the HTTP middleware) because the WebSocket
    // gateway calls this directly for client-sent `message:read` events.
    await this.requireMembership(conversationId, userId);

    const target = await this.messagesRepository.findRecordById(upToMessageId);
    if (!target || target.conversationId !== conversationId) {
      throw new AppError("Message not found in this conversation", 400);
    }

    const conversation = (await this.conversationsRepository.getById(conversationId))!;
    const previousLastRead = await this.conversationsRepository.getLastReadMessageId(conversationId, userId);

    await this.conversationsRepository.updateLastRead(conversationId, userId, upToMessageId);
    await this.messagesRepository.markReadUpTo(conversationId, userId, upToMessageId);

    if (conversation.type === "direct") {
      const otherUserId = await this.conversationsRepository.getOtherMemberId(conversationId, userId);
      if (otherUserId) {
        this.realtimeGateway.sendToUser(otherUserId, {
          type: "message:read",
          conversationId,
          userId,
          upToMessageId,
        });
      }
    } else {
      await this.notifyGroupReadProgress(conversationId, userId, upToMessageId, previousLastRead);
    }

    // Keep the reader's other tabs/devices in sync.
    const unreadCount = await this.conversationsRepository.getUnreadCountForMember(conversationId, userId);
    this.realtimeGateway.sendToUser(userId, { type: "conversation:unread", conversationId, unreadCount });
  }

  /**
   * After a group member reads, tell each sender which of their messages
   * are now read by *everyone*. Only messages in the newly-read range are
   * considered, so repeated reads don't re-announce old messages.
   */
  private async notifyGroupReadProgress(
    conversationId: string,
    readerId: string,
    upToMessageId: string,
    previousLastRead: string | null
  ): Promise<void> {
    const affected = await this.messagesRepository.listIdsInRange(conversationId, readerId, upToMessageId, previousLastRead);
    if (affected.length === 0) return;

    const members = await this.conversationsRepository.getActiveMembers(conversationId);
    const receipts = await this.messagesRepository.getReceipts(affected.map((m) => m.id));

    const readIdsBySender = new Map<string, string[]>();
    for (const message of affected) {
      const status: MessageStatus = aggregateStatus(message, members, receipts.get(message.id));
      if (status !== "read") continue;
      const list = readIdsBySender.get(message.senderId) ?? [];
      list.push(message.id);
      readIdsBySender.set(message.senderId, list);
    }

    for (const [senderId, messageIds] of readIdsBySender) {
      this.realtimeGateway.sendToUser(senderId, { type: "message:status", conversationId, messageIds, status: "read" });
    }
  }
}
