import type { DatabaseClient } from "../../db/pool";
import { generateId } from "../../utils/id";
import type { GroupRole } from "../groups/groups.types";
import type { UsersRepository } from "../users/users.repository";
import type { Conversation } from "./conversation.interface";
import type { ActiveMembership, ConversationSummary, LastMessagePreview } from "./conversations.types";

interface ConversationRow {
  id: string;
  type: "direct" | "group";
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface MembershipRow {
  conversation_id: string;
  type: "direct" | "group";
  updated_at: Date;
  last_read_message_id: string | null;
  group_id: string | null;
  group_name: string | null;
  group_description: string | null;
  group_avatar_url: string | null;
  group_role: GroupRole | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_display_name: string;
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

function placeholders(values: unknown[], offset = 0): string {
  return values.map((_, i) => `$${i + 1 + offset}`).join(", ");
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

  /** The user's active membership (with join time), or null if they are not an active member. */
  async getActiveMembership(conversationId: string, userId: string): Promise<ActiveMembership | null> {
    const result = await this.db.query<{ user_id: string; joined_at: Date }>(
      `SELECT user_id, joined_at FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [conversationId, userId]
    );
    const row = result.rows[0];
    return row ? { userId: row.user_id, joinedAt: row.joined_at } : null;
  }

  async getOtherMemberId(conversationId: string, userId: string): Promise<string | null> {
    const result = await this.db.query<{ user_id: string }>(
      "SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id != $2 LIMIT 1",
      [conversationId, userId]
    );
    return result.rows[0]?.user_id ?? null;
  }

  async getAllMemberIds(conversationId: string): Promise<string[]> {
    const members = await this.getActiveMembers(conversationId);
    return members.map((member) => member.userId);
  }

  async getActiveMembers(conversationId: string): Promise<ActiveMembership[]> {
    const result = await this.db.query<{ user_id: string; joined_at: Date }>(
      "SELECT user_id, joined_at FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL",
      [conversationId]
    );
    return result.rows.map((row) => ({ userId: row.user_id, joinedAt: row.joined_at }));
  }

  async touchUpdatedAt(conversationId: string): Promise<void> {
    await this.db.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [conversationId]);
  }

  async getLastReadMessageId(conversationId: string, userId: string): Promise<string | null> {
    const result = await this.db.query<{ last_read_message_id: string | null }>(
      "SELECT last_read_message_id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, userId]
    );
    return result.rows[0]?.last_read_message_id ?? null;
  }

  async updateLastRead(conversationId: string, userId: string, messageId: string): Promise<void> {
    await this.db.query(
      "UPDATE conversation_members SET last_read_message_id = $3 WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, userId, messageId]
    );
  }

  /**
   * Latest non-deleted message the user is allowed to see (sent at or after
   * they joined — group members don't see history from before they joined).
   *
   * Timestamp comparisons stay inside SQL (subqueries) on purpose: Postgres
   * stores microseconds but a JS Date only holds milliseconds, so a
   * timestamp round-tripped through JS compares wrongly against the
   * original row.
   */
  private async getLastMessage(conversationId: string, userId: string): Promise<LastMessagePreview | null> {
    const result = await this.db.query<MessageRow>(
      `SELECT m.id, m.conversation_id, m.sender_id, u.display_name AS sender_display_name, m.content_type, m.body, m.created_at
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
         AND m.created_at >= (SELECT joined_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2)
       ORDER BY m.created_at DESC
       LIMIT 1`,
      [conversationId, userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      body: row.body,
      contentType: row.content_type,
      senderId: row.sender_id,
      senderDisplayName: row.sender_display_name,
      createdAt: row.created_at,
    };
  }

  /**
   * Messages from other people, visible to the user, newer than their read
   * marker. Both cutoffs are compared in SQL — see getLastMessage for why.
   */
  async getUnreadCount(conversationId: string, userId: string, lastReadMessageId: string | null): Promise<number> {
    const params: unknown[] = [conversationId, userId];
    let readCutoff = "";
    if (lastReadMessageId) {
      params.push(lastReadMessageId);
      readCutoff = "AND created_at > (SELECT created_at FROM messages WHERE id = $3)";
    }

    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM messages
       WHERE conversation_id = $1
         AND sender_id != $2
         AND deleted_at IS NULL
         AND created_at >= (SELECT joined_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2)
         ${readCutoff}`,
      params
    );
    return Number(result.rows[0]?.count ?? "0");
  }

  /** Unread count for one conversation, computed from the user's own membership row. */
  async getUnreadCountForMember(conversationId: string, userId: string): Promise<number> {
    const result = await this.db.query<{ last_read_message_id: string | null }>(
      `SELECT last_read_message_id FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [conversationId, userId]
    );
    const row = result.rows[0];
    if (!row) return 0;
    return this.getUnreadCount(conversationId, userId, row.last_read_message_id);
  }

  async listForUser(userId: string): Promise<ConversationSummary[]> {
    const memberships = await this.db.query<MembershipRow>(
      `SELECT c.id AS conversation_id, c.type, c.updated_at, cm.last_read_message_id,
              g.id AS group_id, g.name AS group_name, g.description AS group_description,
              g.avatar_url AS group_avatar_url, gm.role AS group_role
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
       LEFT JOIN groups g ON g.conversation_id = c.id
       LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = cm.user_id
       WHERE cm.user_id = $1 AND cm.left_at IS NULL
       ORDER BY c.updated_at DESC`,
      [userId]
    );

    if (memberships.rows.length === 0) return [];

    const directIds = memberships.rows.filter((row) => row.type === "direct").map((row) => row.conversation_id);
    const groupIds = memberships.rows.filter((row) => row.type === "group").map((row) => row.conversation_id);

    // Direct: who is on the other side of each conversation.
    const otherUserByConversation = new Map<string, string>();
    if (directIds.length > 0) {
      const others = await this.db.query<{ conversation_id: string; user_id: string }>(
        `SELECT conversation_id, user_id FROM conversation_members
         WHERE user_id != $1 AND conversation_id IN (${placeholders(directIds, 1)})`,
        [userId, ...directIds]
      );
      for (const row of others.rows) otherUserByConversation.set(row.conversation_id, row.user_id);
    }
    const otherProfiles = await this.usersRepository.findManyPublicProfiles([...otherUserByConversation.values()]);

    // Groups: active member counts.
    const memberCounts = new Map<string, number>();
    if (groupIds.length > 0) {
      const counts = await this.db.query<{ conversation_id: string; member_count: string }>(
        `SELECT conversation_id, COUNT(*)::text AS member_count FROM conversation_members
         WHERE left_at IS NULL AND conversation_id IN (${placeholders(groupIds)})
         GROUP BY conversation_id`,
        groupIds
      );
      for (const row of counts.rows) memberCounts.set(row.conversation_id, Number(row.member_count));
    }

    const summaries: ConversationSummary[] = [];
    for (const row of memberships.rows) {
      const [lastMessage, unreadCount] = await Promise.all([
        this.getLastMessage(row.conversation_id, userId),
        this.getUnreadCount(row.conversation_id, userId, row.last_read_message_id),
      ]);

      if (row.type === "direct") {
        const otherUserId = otherUserByConversation.get(row.conversation_id);
        const otherParticipant = otherUserId ? otherProfiles.get(otherUserId) : undefined;
        if (!otherParticipant) continue; // other user was deactivated/deleted

        summaries.push({
          id: row.conversation_id,
          type: "direct",
          otherParticipant,
          group: null,
          lastMessage,
          unreadCount,
          updatedAt: row.updated_at,
        });
      } else {
        if (!row.group_id || !row.group_name || !row.group_role) continue; // inconsistent group row — skip rather than crash

        summaries.push({
          id: row.conversation_id,
          type: "group",
          otherParticipant: null,
          group: {
            id: row.group_id,
            name: row.group_name,
            description: row.group_description,
            avatarUrl: row.group_avatar_url,
            memberCount: memberCounts.get(row.conversation_id) ?? 0,
            myRole: row.group_role,
          },
          lastMessage,
          unreadCount,
          updatedAt: row.updated_at,
        });
      }
    }

    return summaries;
  }
}
