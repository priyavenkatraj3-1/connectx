import type { DatabaseClient } from "../../db/pool";
import { generateId } from "../../utils/id";
import type { MessageDTO, MessagePage, MessageStatus } from "./messages.types";

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  content_type: string;
  body: string | null;
  created_at: Date;
  edited_at: Date | null;
  receipt_status: MessageStatus | null;
}

function toDTO(row: MessageRow): MessageDTO {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    contentType: row.content_type,
    body: row.body,
    status: row.receipt_status ?? "sent",
    createdAt: row.created_at,
    editedAt: row.edited_at,
  };
}

const SELECT_WITH_RECEIPT = `
  SELECT m.id, m.conversation_id, m.sender_id, m.content_type, m.body, m.created_at, m.edited_at,
         r.status AS receipt_status
  FROM messages m
  LEFT JOIN message_receipts r ON r.message_id = m.id AND r.user_id != m.sender_id
`;

export class MessagesRepository {
  constructor(private readonly db: DatabaseClient) {}

  async insert(input: { conversationId: string; senderId: string; body: string }): Promise<MessageDTO> {
    const id = generateId();
    const result = await this.db.query<Omit<MessageRow, "receipt_status">>(
      `INSERT INTO messages (id, conversation_id, sender_id, content_type, body)
       VALUES ($1, $2, $3, 'text', $4)
       RETURNING id, conversation_id, sender_id, content_type, body, created_at, edited_at`,
      [id, input.conversationId, input.senderId, input.body]
    );
    // A message has no receipts yet the instant it's created, so status is
    // always "sent" here — no need to round-trip through SELECT_WITH_RECEIPT.
    return toDTO({ ...result.rows[0]!, receipt_status: null });
  }

  async findById(messageId: string): Promise<MessageDTO | null> {
    const result = await this.db.query<MessageRow>(`${SELECT_WITH_RECEIPT} WHERE m.id = $1`, [messageId]);
    const row = result.rows[0];
    return row ? toDTO(row) : null;
  }

  async listByConversation(conversationId: string, before?: string, limit = 50): Promise<MessagePage> {
    const fetchLimit = limit + 1; // fetch one extra to know if there's more

    const rows = before
      ? (
          await this.db.query<MessageRow>(
            `${SELECT_WITH_RECEIPT}
             WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
               AND m.created_at < (SELECT created_at FROM messages WHERE id = $2)
             ORDER BY m.created_at DESC
             LIMIT $3`,
            [conversationId, before, fetchLimit]
          )
        ).rows
      : (
          await this.db.query<MessageRow>(
            `${SELECT_WITH_RECEIPT}
             WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
             ORDER BY m.created_at DESC
             LIMIT $2`,
            [conversationId, fetchLimit]
          )
        ).rows;

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse(); // oldest first for rendering
    return { items: page.map(toDTO), hasMore };
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
}
