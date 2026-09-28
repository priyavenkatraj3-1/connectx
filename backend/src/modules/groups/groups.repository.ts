import type { DatabaseClient } from "../../db/pool";
import { generateId } from "../../utils/id";
import type { GroupMemberDTO, GroupRole } from "./groups.types";

interface GroupRow {
  id: string;
  conversation_id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface MemberRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  status_message: string | null;
  role: GroupRole;
  joined_at: Date;
  added_by: string | null;
}

export interface GroupRecord {
  id: string;
  conversationId: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: GroupRow): GroupRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    name: row.name,
    description: row.description,
    avatarUrl: row.avatar_url,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ROLE_ORDER: Record<GroupRole, number> = { owner: 0, admin: 1, member: 2 };

/**
 * Persistence for groups. Every membership change writes both
 * `conversation_members` (who can read/send — the authorization source of
 * truth shared with direct chats) and `group_members` (their role) inside
 * one transaction, so the two can never drift apart.
 */
export class GroupsRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: {
    name: string;
    description: string | null;
    avatarUrl: string | null;
    ownerId: string;
    memberIds: string[];
  }): Promise<GroupRecord> {
    return this.db.withTransaction(async (tx) => {
      const conversationId = generateId();
      const groupId = generateId();

      await tx.query("INSERT INTO conversations (id, type, created_by) VALUES ($1, 'group', $2)", [
        conversationId,
        input.ownerId,
      ]);
      const groupResult = await tx.query<GroupRow>(
        `INSERT INTO groups (id, conversation_id, name, description, avatar_url, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [groupId, conversationId, input.name, input.description, input.avatarUrl, input.ownerId]
      );

      await tx.query("INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)", [
        conversationId,
        input.ownerId,
      ]);
      await tx.query("INSERT INTO group_members (group_id, user_id, role, added_by) VALUES ($1, $2, 'owner', $2)", [
        groupId,
        input.ownerId,
      ]);

      for (const userId of input.memberIds) {
        await tx.query("INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)", [
          conversationId,
          userId,
        ]);
        await tx.query("INSERT INTO group_members (group_id, user_id, role, added_by) VALUES ($1, $2, 'member', $3)", [
          groupId,
          userId,
          input.ownerId,
        ]);
      }

      return toRecord(groupResult.rows[0]!);
    });
  }

  async findById(groupId: string): Promise<GroupRecord | null> {
    const result = await this.db.query<GroupRow>("SELECT * FROM groups WHERE id = $1", [groupId]);
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  /** The user's role, or null if they are not an active member. */
  async getRole(groupId: string, userId: string): Promise<GroupRole | null> {
    const result = await this.db.query<{ role: GroupRole }>(
      `SELECT gm.role
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       JOIN conversation_members cm ON cm.conversation_id = g.conversation_id AND cm.user_id = gm.user_id
       WHERE gm.group_id = $1 AND gm.user_id = $2 AND cm.left_at IS NULL`,
      [groupId, userId]
    );
    return result.rows[0]?.role ?? null;
  }

  /** Active members, owner first, then admins, then members (each by join time). */
  async listMembers(groupId: string): Promise<GroupMemberDTO[]> {
    const result = await this.db.query<MemberRow>(
      `SELECT gm.user_id, u.display_name, p.avatar_url, p.status_message, gm.role, cm.joined_at, gm.added_by
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       JOIN conversation_members cm ON cm.conversation_id = g.conversation_id AND cm.user_id = gm.user_id
       JOIN users u ON u.id = gm.user_id
       LEFT JOIN user_profiles p ON p.user_id = gm.user_id
       WHERE gm.group_id = $1 AND cm.left_at IS NULL`,
      [groupId]
    );
    return result.rows
      .map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        statusMessage: row.status_message,
        role: row.role,
        joinedAt: row.joined_at,
        addedBy: row.added_by,
      }))
      .sort(
        (a, b) =>
          ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime()
      );
  }

  async update(
    groupId: string,
    fields: { name?: string; description?: string | null; avatarUrl?: string | null }
  ): Promise<GroupRecord> {
    const columns: Array<[string, unknown]> = [];
    if (fields.name !== undefined) columns.push(["name", fields.name]);
    if (fields.description !== undefined) columns.push(["description", fields.description]);
    if (fields.avatarUrl !== undefined) columns.push(["avatar_url", fields.avatarUrl]);

    if (columns.length > 0) {
      const setClauses = columns.map(([column], i) => `${column} = $${i + 2}`).join(", ");
      await this.db.query(`UPDATE groups SET ${setClauses}, updated_at = now() WHERE id = $1`, [
        groupId,
        ...columns.map(([, value]) => value),
      ]);
    }
    return (await this.findById(groupId))!;
  }

  /**
   * Adds users as plain members. A user who previously left/was removed
   * gets their conversation_members row re-activated with a fresh
   * joined_at (so they don't regain history from before they rejoined).
   * Throws `DuplicateMemberError` if any user is already an active member.
   */
  async addMembers(group: GroupRecord, userIds: string[], addedBy: string): Promise<void> {
    await this.db.withTransaction(async (tx) => {
      for (const userId of userIds) {
        const existing = await tx.query<{ left_at: Date | null }>(
          "SELECT left_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2",
          [group.conversationId, userId]
        );
        const row = existing.rows[0];
        if (row && row.left_at === null) {
          throw new DuplicateMemberError(userId);
        }
        if (row) {
          await tx.query(
            `UPDATE conversation_members
             SET left_at = NULL, joined_at = now(), last_read_message_id = NULL
             WHERE conversation_id = $1 AND user_id = $2`,
            [group.conversationId, userId]
          );
        } else {
          await tx.query("INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2)", [
            group.conversationId,
            userId,
          ]);
        }
        // The (group_id, user_id) primary key is the database-level guard against duplicates.
        await tx.query("INSERT INTO group_members (group_id, user_id, role, added_by) VALUES ($1, $2, 'member', $3)", [
          group.id,
          userId,
          addedBy,
        ]);
      }
    });
  }

  /**
   * Deactivates a membership. If `successorId` is given (the owner is
   * leaving), that member becomes the new owner in the same transaction.
   * The leaving owner's row is deleted before the successor is promoted so
   * the one-owner-per-group unique index is never violated mid-transaction.
   */
  async removeMember(group: GroupRecord, userId: string, successorId: string | null = null): Promise<void> {
    await this.db.withTransaction(async (tx) => {
      await tx.query("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2", [group.id, userId]);
      await tx.query(
        "UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2",
        [group.conversationId, userId]
      );
      if (successorId) {
        await tx.query(
          "UPDATE group_members SET role = 'owner', updated_at = now() WHERE group_id = $1 AND user_id = $2",
          [group.id, successorId]
        );
      }
    });
  }

  async setRole(groupId: string, userId: string, role: "admin" | "member"): Promise<void> {
    await this.db.query("UPDATE group_members SET role = $3, updated_at = now() WHERE group_id = $1 AND user_id = $2", [
      groupId,
      userId,
      role,
    ]);
  }
}

export class DuplicateMemberError extends Error {
  constructor(public readonly userId: string) {
    super(`User ${userId} is already a member of this group`);
  }
}
