import type { DatabaseClient } from "../../db/pool";
import { generateId } from "../../utils/id";
import type { ActiveMembership } from "../conversations/conversations.types";
import type { MediaRepository } from "../media/media.repository";
import { toAttachmentDTO } from "../media/media.types";
import type { MessageDTO, MessageMention, MessagePage, MessageStatus, ReplyPreview } from "./messages.types";

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_display_name: string;
  sender_avatar_url: string | null;
  content_type: string;
  body: string | null;
  reply_to_message_id: string | null;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
}

/** Bare message row, without the joined/aggregated fields a MessageDTO carries. */
export interface MessageRecord {
  id: string;
  conversationId: string;
  senderId: string;
  contentType: string;
  body: string | null;
  replyToMessageId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

const SELECT_MESSAGE = `
  SELECT m.id, m.conversation_id, m.sender_id, u.display_name AS sender_display_name,
         p.avatar_url AS sender_avatar_url, m.content_type, m.body, m.reply_to_message_id,
         m.created_at, m.edited_at, m.deleted_at
  FROM messages m
  JOIN users u ON u.id = m.sender_id
  LEFT JOIN user_profiles p ON p.user_id = m.sender_id
`;

const REPLY_PREVIEW_LENGTH = 200;

function toRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    contentType: row.content_type,
    body: row.body,
    replyToMessageId: row.reply_to_message_id,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
  };
}

function placeholders(values: unknown[], offset = 0): string {
  return values.map((_, i) => `$${i + 1 + offset}`).join(", ");
}

/**
 * Aggregate status of one message from its sender's point of view. The
 * recipients are the conversation's current active members, other than the
 * sender, who had already joined when the message was sent. A message is
 * "delivered"/"read" only once every such recipient has reached that state.
 */
export function aggregateStatus(
  message: { senderId: string; createdAt: Date },
  members: ActiveMembership[],
  receiptsByUser: Map<string, MessageStatus> | undefined
): MessageStatus {
  const recipients = members.filter(
    (member) => member.userId !== message.senderId && new Date(member.joinedAt) <= new Date(message.createdAt)
  );
  if (recipients.length === 0) return "sent";

  let allRead = true;
  for (const recipient of recipients) {
    const receipt = receiptsByUser?.get(recipient.userId);
    if (!receipt) return "sent";
    if (receipt !== "read") allRead = false;
  }
  return allRead ? "read" : "delivered";
}

export class MessagesRepository {
  constructor(
    private readonly db: DatabaseClient,
    private readonly mediaRepository: MediaRepository
  ) {}

  /**
   * Inserts a message plus its mentions and attachment link in one
   * transaction. Throws `AttachmentUnavailableError` if the attachment was
   * claimed by another message concurrently (the whole insert rolls back).
   */
  async create(input: {
    conversationId: string;
    senderId: string;
    contentType: string;
    body: string | null;
    replyToMessageId: string | null;
    mentionedUserIds: string[];
    attachmentId: string | null;
  }): Promise<string> {
    const id = generateId();
    await this.db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO messages (id, conversation_id, sender_id, content_type, body, reply_to_message_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, input.conversationId, input.senderId, input.contentType, input.body, input.replyToMessageId]
      );

      for (const userId of input.mentionedUserIds) {
        await tx.query("INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2)", [id, userId]);
      }

      if (input.attachmentId) {
        const attached = await this.mediaRepository.attachToMessage(
          input.attachmentId,
          id,
          input.senderId,
          input.conversationId,
          tx
        );
        if (!attached) throw new AttachmentUnavailableError();
      }
    });
    return id;
  }

  async updateBody(messageId: string, body: string | null, mentionedUserIds: string[]): Promise<void> {
    await this.db.withTransaction(async (tx) => {
      await tx.query("UPDATE messages SET body = $2, edited_at = now() WHERE id = $1", [messageId, body]);
      // Cached AI translations are of the old text — drop them (Phase 5).
      await tx.query("DELETE FROM ai_translations WHERE message_id = $1", [messageId]);
      await tx.query("DELETE FROM message_mentions WHERE message_id = $1", [messageId]);
      for (const userId of mentionedUserIds) {
        await tx.query("INSERT INTO message_mentions (message_id, user_id) VALUES ($1, $2)", [messageId, userId]);
      }
    });
  }

  /**
   * Soft-deletes a message: the row stays (so replies and receipts keep
   * their foreign keys) but its content is wiped, its mentions removed and
   * its attachment metadata deleted. Returns the storage keys of removed
   * attachments so the caller can delete the stored bytes.
   */
  async softDelete(messageId: string): Promise<string[]> {
    return this.db.withTransaction(async (tx) => {
      const attachments = await this.mediaRepository.findByMessageIds([messageId], tx);
      await tx.query("UPDATE messages SET body = NULL, deleted_at = now() WHERE id = $1", [messageId]);
      await tx.query("DELETE FROM message_mentions WHERE message_id = $1", [messageId]);
      // A soft-deleted message keeps its row, so its cached translations must go explicitly (Phase 5).
      await tx.query("DELETE FROM ai_translations WHERE message_id = $1", [messageId]);
      for (const attachment of attachments) {
        await this.mediaRepository.deleteById(attachment.id, tx);
      }
      return attachments.map((attachment) => attachment.storageKey);
    });
  }

  /**
   * True if the message exists, is not deleted, and was sent at or after
   * `userId` joined its conversation as a currently-active member. Compared
   * in SQL for exact (microsecond) timestamp precision.
   */
  async isVisibleTo(messageId: string, userId: string): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `SELECT m.id FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
       WHERE m.id = $1 AND m.deleted_at IS NULL AND cm.left_at IS NULL AND m.created_at >= cm.joined_at`,
      [messageId, userId]
    );
    return result.rows.length > 0;
  }

  async findRecordById(messageId: string): Promise<MessageRecord | null> {
    const result = await this.db.query<MessageRow>(`${SELECT_MESSAGE} WHERE m.id = $1`, [messageId]);
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async findById(messageId: string, members: ActiveMembership[]): Promise<MessageDTO | null> {
    const result = await this.db.query<MessageRow>(`${SELECT_MESSAGE} WHERE m.id = $1`, [messageId]);
    const [dto] = await this.hydrate(result.rows, members);
    return dto ?? null;
  }

  /**
   * Non-deleted messages the viewer may see (sent at or after they joined),
   * newest page first, returned oldest-first. The join-time cutoff is a SQL
   * subquery rather than a JS Date parameter: Postgres timestamps have
   * microsecond precision and would be truncated by a round-trip through JS.
   */
  async listByConversation(
    conversationId: string,
    viewerId: string,
    members: ActiveMembership[],
    before?: string,
    limit = 50
  ): Promise<MessagePage> {
    const fetchLimit = limit + 1; // fetch one extra to know if there's more
    const visibleToViewer =
      "m.created_at >= (SELECT joined_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2)";

    const rows = before
      ? (
          await this.db.query<MessageRow>(
            `${SELECT_MESSAGE}
             WHERE m.conversation_id = $1 AND m.deleted_at IS NULL AND ${visibleToViewer}
               AND m.created_at < (SELECT created_at FROM messages WHERE id = $3)
             ORDER BY m.created_at DESC
             LIMIT $4`,
            [conversationId, viewerId, before, fetchLimit]
          )
        ).rows
      : (
          await this.db.query<MessageRow>(
            `${SELECT_MESSAGE}
             WHERE m.conversation_id = $1 AND m.deleted_at IS NULL AND ${visibleToViewer}
             ORDER BY m.created_at DESC
             LIMIT $3`,
            [conversationId, viewerId, fetchLimit]
          )
        ).rows;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse(); // oldest first for rendering
    return { items: await this.hydrate(page, members), hasMore };
  }

  /** IDs of non-deleted messages in (after, upTo], not sent by `excludeSenderId` — used to find which messages a read just affected. */
  async listIdsInRange(
    conversationId: string,
    excludeSenderId: string,
    upToMessageId: string,
    afterMessageId: string | null,
    limit = 200
  ): Promise<Array<{ id: string; senderId: string; createdAt: Date }>> {
    const params: unknown[] = [conversationId, excludeSenderId, upToMessageId, limit];
    let afterClause = "";
    if (afterMessageId) {
      params.push(afterMessageId);
      afterClause = "AND m.created_at > (SELECT created_at FROM messages WHERE id = $5)";
    }
    const result = await this.db.query<{ id: string; sender_id: string; created_at: Date }>(
      `SELECT m.id, m.sender_id, m.created_at FROM messages m
       WHERE m.conversation_id = $1 AND m.sender_id != $2 AND m.deleted_at IS NULL
         AND m.created_at <= (SELECT created_at FROM messages WHERE id = $3)
         ${afterClause}
       ORDER BY m.created_at DESC
       LIMIT $4`,
      params
    );
    return result.rows.map((row) => ({ id: row.id, senderId: row.sender_id, createdAt: row.created_at }));
  }

  async getReceipts(messageIds: string[]): Promise<Map<string, Map<string, MessageStatus>>> {
    const byMessage = new Map<string, Map<string, MessageStatus>>();
    if (messageIds.length === 0) return byMessage;
    const result = await this.db.query<{ message_id: string; user_id: string; status: MessageStatus }>(
      `SELECT message_id, user_id, status FROM message_receipts WHERE message_id IN (${placeholders(messageIds)})`,
      messageIds
    );
    for (const row of result.rows) {
      const forMessage = byMessage.get(row.message_id) ?? new Map<string, MessageStatus>();
      forMessage.set(row.user_id, row.status);
      byMessage.set(row.message_id, forMessage);
    }
    return byMessage;
  }

  /** Marks a message as delivered to `recipientId`, unless it's already marked read (never downgrade). */
  async markDelivered(messageId: string, recipientId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO message_receipts (message_id, user_id, status, updated_at)
       VALUES ($1, $2, 'delivered', now())
       ON CONFLICT (message_id, user_id) DO UPDATE
       SET status = CASE WHEN message_receipts.status = 'read' THEN message_receipts.status ELSE 'delivered' END,
           updated_at = now()`,
      [messageId, recipientId]
    );
  }

  /** Marks every message in the conversation up to and including `upToMessageId`, not sent by `readerId`, as read by them. */
  async markReadUpTo(conversationId: string, readerId: string, upToMessageId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO message_receipts (message_id, user_id, status, updated_at)
       SELECT m.id, $2, 'read', now()
       FROM messages m
       WHERE m.conversation_id = $1
         AND m.sender_id != $2
         AND m.deleted_at IS NULL
         AND m.created_at <= (SELECT created_at FROM messages WHERE id = $3)
       ON CONFLICT (message_id, user_id) DO UPDATE
       SET status = 'read', updated_at = now()`,
      [conversationId, readerId, upToMessageId]
    );
  }

  /** Turns raw rows into full DTOs: reply previews, mentions, attachments and aggregate status, each fetched in one batched query. */
  private async hydrate(rows: MessageRow[], members: ActiveMembership[]): Promise<MessageDTO[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);

    const replyIds = [...new Set(rows.map((row) => row.reply_to_message_id).filter((id): id is string => Boolean(id)))];

    const [replies, mentions, attachments, receipts] = await Promise.all([
      this.loadReplyPreviews(replyIds),
      this.loadMentions(ids),
      this.mediaRepository.findByMessageIds(ids),
      this.getReceipts(ids),
    ]);

    const attachmentByMessage = new Map(attachments.map((a) => [a.messageId!, toAttachmentDTO(a)]));

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      sender: { id: row.sender_id, displayName: row.sender_display_name, avatarUrl: row.sender_avatar_url },
      contentType: row.content_type,
      body: row.body,
      status: aggregateStatus({ senderId: row.sender_id, createdAt: row.created_at }, members, receipts.get(row.id)),
      createdAt: row.created_at,
      editedAt: row.edited_at,
      replyTo: row.reply_to_message_id ? (replies.get(row.reply_to_message_id) ?? null) : null,
      mentions: mentions.get(row.id) ?? [],
      attachment: attachmentByMessage.get(row.id) ?? null,
    }));
  }

  private async loadReplyPreviews(messageIds: string[]): Promise<Map<string, ReplyPreview>> {
    const previews = new Map<string, ReplyPreview>();
    if (messageIds.length === 0) return previews;
    const result = await this.db.query<MessageRow>(
      `${SELECT_MESSAGE} WHERE m.id IN (${placeholders(messageIds)})`,
      messageIds
    );
    for (const row of result.rows) {
      const deleted = row.deleted_at !== null;
      previews.set(row.id, {
        id: row.id,
        senderId: row.sender_id,
        senderDisplayName: row.sender_display_name,
        body: deleted || row.body === null ? null : row.body.slice(0, REPLY_PREVIEW_LENGTH),
        contentType: row.content_type,
        deleted,
      });
    }
    return previews;
  }

  private async loadMentions(messageIds: string[]): Promise<Map<string, MessageMention[]>> {
    const byMessage = new Map<string, MessageMention[]>();
    const result = await this.db.query<{ message_id: string; user_id: string; display_name: string }>(
      `SELECT mm.message_id, mm.user_id, u.display_name
       FROM message_mentions mm
       JOIN users u ON u.id = mm.user_id
       WHERE mm.message_id IN (${placeholders(messageIds)})`,
      messageIds
    );
    for (const row of result.rows) {
      const list = byMessage.get(row.message_id) ?? [];
      list.push({ userId: row.user_id, displayName: row.display_name });
      byMessage.set(row.message_id, list);
    }
    return byMessage;
  }
}

export class AttachmentUnavailableError extends Error {
  constructor() {
    super("Attachment is no longer available to attach");
  }
}
