import type { DatabaseClient } from "../../db/pool";
import { AppError } from "../../middleware/errorHandler";
import type { GroupRole } from "../groups/groups.types";

export interface ConversationAccess {
  conversationId: string;
  type: "direct" | "group";
  /** The user's group role; null in direct conversations. */
  role: GroupRole | null;
  /** Group owner/admin. Always false in direct conversations. */
  isAdmin: boolean;
}

/**
 * The single authorization check for conversation-scoped Phase 6 resources
 * (shared notes, shared to-do lists, pins, scheduled messages, task
 * assignment). Built on the same source of truth as messaging:
 * conversation_members with left_at IS NULL, plus group_members for roles.
 */
export class ConversationAccessService {
  constructor(private readonly db: DatabaseClient) {}

  async find(conversationId: string, userId: string): Promise<ConversationAccess | null> {
    const result = await this.db.query<{ type: "direct" | "group"; role: GroupRole | null }>(
      `SELECT c.type, gm.role
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
       LEFT JOIN groups g ON g.conversation_id = c.id
       LEFT JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = cm.user_id
       WHERE cm.conversation_id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL`,
      [conversationId, userId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const role = row.type === "group" ? (row.role ?? "member") : null;
    return { conversationId, type: row.type, role, isAdmin: role === "owner" || role === "admin" };
  }

  /** Throws 403 unless `userId` is an active member of the conversation. */
  async require(conversationId: string, userId: string): Promise<ConversationAccess> {
    const access = await this.find(conversationId, userId);
    if (!access) throw new AppError("You do not have access to this conversation", 403);
    return access;
  }

  async activeMemberIds(conversationId: string): Promise<string[]> {
    const result = await this.db.query<{ user_id: string }>(
      "SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL",
      [conversationId]
    );
    return result.rows.map((row) => row.user_id);
  }

  async isActiveMember(conversationId: string, userId: string): Promise<boolean> {
    return (await this.find(conversationId, userId)) !== null;
  }

  /**
   * True if the message exists, isn't deleted, and `userId` can read it
   * (active member who joined before it was sent) — same rule as
   * MessagesRepository.isVisibleTo. Returns the conversation ID if so.
   */
  async visibleMessageConversation(messageId: string, userId: string): Promise<string | null> {
    const result = await this.db.query<{ conversation_id: string }>(
      `SELECT m.conversation_id FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
       WHERE m.id = $1 AND m.deleted_at IS NULL AND cm.left_at IS NULL AND m.created_at >= cm.joined_at`,
      [messageId, userId]
    );
    return result.rows[0]?.conversation_id ?? null;
  }
}
