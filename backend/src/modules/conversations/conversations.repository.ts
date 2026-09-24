import type { DatabaseClient } from "../../db/pool";
import { generateId } from "../../utils/id";
import type { UsersRepository } from "../users/users.repository";
import type { Conversation } from "./conversation.interface";
import type { ConversationSummary, LastMessagePreview } from "./conversations.types";

interface ConversationRow {
  id: string;
  type: "direct" | "group";
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface MembershipRow {
  conversation_id: string;
  updated_at: Date;
  other_user_id: string;
  last_read_message_id: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  content_type: string;
  body: string | null;
  created_at: Date;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    type: row.type,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ConversationsRepository {
  constructor(
    private readonly db: DatabaseClient,
    private readonly usersRepository: UsersRepository
  ) {}

  async findDirectConversationId(userAId: string, userBId: string): Promise<string | null> {
    const result = await this.db.query<{ id: string }>(
      `SELECT c.id
       FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = $1
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = $2
       WHERE c.type = 'direct'
       LIMIT 1`,
      [userAId, userBId]
    );
    return result.rows[0]?.id ?? null;
  }

  async getOrCreateDirectConversation(userAId: string, userBId: string): Promise<Conversation> {
    const existingId = await this.findDirectConversationId(userAId, userBId);
    if (existingId) {
      const existing = await this.getById(existingId);
      if (existing) return existing;
    }

    return this.db.withTransaction(async (tx) => {
      // Re-check inside the transaction to close the race window between
      // two users starting a chat with each other at the same moment.
      const raceResult = await tx.query<{ id: string }>(
        `SELECT c.id
         FROM conversations c
         JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = $1
         JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = $2
         WHERE c.type = 'direct'
         LIMIT 1`,
        [userAId, userBId]
      );
      const raceId = raceResult.rows[0]?.id;
      if (raceId) {
        const row = await tx.query<ConversationRow>("SELECT * FROM conversations WHERE id = $1", [raceId]);
        return toConversation(row.rows[0]!);
      }

      const conversationId = generateId();
      const insertResult = await tx.query<ConversationRow>(
        `INSERT INTO conversations (id, type, created_by) VALUES ($1, 'direct', $2)
         RETURNING *`,
        [conversationId, userAId]
      );
      await tx.query("INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)", [
        conversationId,
        userAId,
      ]);
      await tx.query("INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)", [
        conversationId,
        userBId,
      ]);

      return toConversation(insertResult.rows[0]!);
    });
  }

  async getById(conversationId: string): Promise<Conversation | null> {
    const result = await this.db.query<ConversationRow>("SELECT * FROM conversations WHERE id = $1", [
      conversationId,
    ]);
    const row = result.rows[0];
    return row ? toConversation(row) : null;
  }

  async isMember(conversationId: string, userId: string): Promise<boolean> {
    const result = await this.db.query(
      "SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL",
      [conversationId, userId]
    );
    return result.rowCount > 0;
  }

  async getOtherMemberId(conversationId: string, userId: string): Promise<string | null> {
    const result = await this.db.query<{ user_id: string }>(
      "SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id != $2 LIMIT 1",
      [conversationId, userId]
    );
    return result.rows[0]?.user_id ?? null;
  }

  async getAllMemberIds(conversationId: string): Promise<string[]> {
    const result = await this.db.query<{ user_id: string }>(
      "SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL",
      [conversationId]
    );
    return result.rows.map((row) => row.user_id);
  }

  async touchUpdatedAt(conversationId: string): Promise<void> {
    await this.db.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [conversationId]);
  }

  async updateLastRead(conversationId: string, userId: string, messageId: string): Promise<void> {
    await this.db.query(
      "UPDATE conversation_members SET last_read_message_id = $3 WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, userId, messageId]
    );
  }

  private async getLastMessage(conversationId: string): Promise<LastMessagePreview | null> {
    const result = await this.db.query<MessageRow>(
      `SELECT id, conversation_id, sender_id, content_type, body, created_at
       FROM messages
       WHERE conversation_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [conversationId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      body: row.body,
      contentType: row.content_type,
      senderId: row.sender_id,
      createdAt: row.created_at,
    };
  }

  private async getUnreadCount(
    conversationId: string,
    userId: string,
    lastReadMessageId: string | null
  ): Promise<number> {
    let cutoff: Date | null = null;
    if (lastReadMessageId) {
      const cutoffResult = await this.db.query<{ created_at: Date }>(
        "SELECT created_at FROM messages WHERE id = $1",
        [lastReadMessageId]
      );
      cutoff = cutoffResult.rows[0]?.created_at ?? null;
    }

    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM messages
       WHERE conversation_id = $1
         AND sender_id != $2
         AND deleted_at IS NULL
         ${cutoff ? "AND created_at > $3" : ""}`,
      cutoff ? [conversationId, userId, cutoff] : [conversationId, userId]
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  async listForUser(userId: string): Promise<ConversationSummary[]> {
    const memberships = await this.db.query<MembershipRow>(
      `SELECT c.id AS conversation_id, c.updated_at, other.user_id AS other_user_id, cm.last_read_message_id
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
       JOIN conversation_members other ON other.conversation_id = c.id AND other.user_id != cm.user_id
       WHERE cm.user_id = $1 AND cm.left_at IS NULL
       ORDER BY c.updated_at DESC`,
      [userId]
    );

    if (memberships.rows.length === 0) return [];

    const otherProfiles = await this.usersRepository.findManyPublicProfiles(
      memberships.rows.map((row) => row.other_user_id)
    );

    const summaries: ConversationSummary[] = [];
    for (const row of memberships.rows) {
      const otherParticipant = otherProfiles.get(row.other_user_id);
      if (!otherParticipant) continue; // other user was deactivated/deleted

      const [lastMessage, unreadCount] = await Promise.all([
        this.getLastMessage(row.conversation_id),
        this.getUnreadCount(row.conversation_id, userId, row.last_read_message_id),
      ]);

      summaries.push({
        id: row.conversation_id,
        type: "direct",
        otherParticipant,
        lastMessage,
        unreadCount,
        updatedAt: row.updated_at,
      });
    }

    return summaries;
  }
}
