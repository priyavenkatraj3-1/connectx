import type { DatabaseClient } from "../../db/pool";
import { placeholders } from "../../db/errors";
import { AppError } from "../../middleware/errorHandler";
import { broadcast } from "../../realtime/broadcast";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import type { ConversationAccessService } from "../collaboration/conversation-access";

export const MAX_PINS_PER_CONVERSATION = 50;
const PREVIEW_LENGTH = 300;

export interface MessagePreviewDTO {
  id: string;
  conversationId: string;
  senderId: string;
  senderDisplayName: string;
  contentType: string;
  body: string | null;
  createdAt: Date;
}

export interface PinnedMessageDTO {
  conversationId: string;
  messageId: string;
  pinnedBy: { id: string; displayName: string } | null;
  pinnedAt: Date;
  message: MessagePreviewDTO;
}

export interface SavedMessageDTO {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  label: string | null;
  starred: boolean;
  note: string | null;
  savedAt: Date;
  updatedAt: Date;
  message: MessagePreviewDTO;
}

interface PreviewColumns {
  m_id: string;
  m_conversation_id: string;
  m_sender_id: string;
  m_sender_name: string;
  m_content_type: string;
  m_body: string | null;
  m_created_at: Date;
}

/** Columns + joins for a message preview, restricted to messages `viewerParam` can read. */
const VISIBLE_MESSAGE_JOIN = (messageIdColumn: string, viewerParam: string) => `
  JOIN messages m ON m.id = ${messageIdColumn} AND m.deleted_at IS NULL
  JOIN conversation_members vcm ON vcm.conversation_id = m.conversation_id AND vcm.user_id = ${viewerParam}
       AND vcm.left_at IS NULL AND m.created_at >= vcm.joined_at
  JOIN users mu ON mu.id = m.sender_id`;
const PREVIEW_SELECT = `m.id AS m_id, m.conversation_id AS m_conversation_id, m.sender_id AS m_sender_id,
  mu.display_name AS m_sender_name, m.content_type AS m_content_type, m.body AS m_body, m.created_at AS m_created_at`;

function toPreview(row: PreviewColumns): MessagePreviewDTO {
  return {
    id: row.m_id,
    conversationId: row.m_conversation_id,
    senderId: row.m_sender_id,
    senderDisplayName: row.m_sender_name,
    contentType: row.m_content_type,
    body: row.m_body ? row.m_body.slice(0, PREVIEW_LENGTH) : null,
    createdAt: row.m_created_at,
  };
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Pinned messages (shared by a conversation) and saved/starred messages
 * (private to one user). Both only ever surface messages the viewer can
 * currently read: active member, joined before the message was sent, and
 * the message not deleted. Deleting a message removes its pins/saves
 * (MessagesRepository.softDelete).
 */
export class MessageOrganizationService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly gateway: RealtimeGateway,
    private readonly access: ConversationAccessService
  ) {}

  // --- Pins -----------------------------------------------------------------

  async listPins(conversationId: string, userId: string): Promise<PinnedMessageDTO[]> {
    await this.access.require(conversationId, userId);
    const result = await this.db.query<PreviewColumns & { pinned_by: string | null; pinned_by_name: string | null; created_at: Date }>(
      `SELECT p.pinned_by, pu.display_name AS pinned_by_name, p.created_at, ${PREVIEW_SELECT}
       FROM pinned_messages p
       ${VISIBLE_MESSAGE_JOIN("p.message_id", "$2")}
       LEFT JOIN users pu ON pu.id = p.pinned_by
       WHERE p.conversation_id = $1
       ORDER BY p.created_at DESC`,
      [conversationId, userId]
    );
    return result.rows.map((row) => ({
      conversationId,
      messageId: row.m_id,
      pinnedBy: row.pinned_by ? { id: row.pinned_by, displayName: row.pinned_by_name ?? "" } : null,
      pinnedAt: row.created_at,
      message: toPreview(row),
    }));
  }

  /** In groups only the owner/admins may pin or unpin; in direct chats either person may. */
  private async requirePinPermission(conversationId: string, userId: string): Promise<void> {
    const access = await this.access.require(conversationId, userId);
    if (access.type === "group" && !access.isAdmin) throw new AppError("Only group admins can pin messages", 403);
  }

  async pin(messageId: string, userId: string): Promise<PinnedMessageDTO> {
    const conversationId = await this.access.visibleMessageConversation(messageId, userId);
    if (!conversationId) throw new AppError("Message not found", 404);
    await this.requirePinPermission(conversationId, userId);

    const existing = await this.db.query("SELECT 1 FROM pinned_messages WHERE conversation_id = $1 AND message_id = $2", [conversationId, messageId]);
    if (existing.rowCount === 0) {
      const count = await this.db.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM pinned_messages WHERE conversation_id = $1",
        [conversationId]
      );
      if (Number(count.rows[0]?.count ?? "0") >= MAX_PINS_PER_CONVERSATION) {
        throw new AppError(`A conversation can have at most ${MAX_PINS_PER_CONVERSATION} pinned messages`, 409);
      }
      await this.db.query(
        "INSERT INTO pinned_messages (conversation_id, message_id, pinned_by) VALUES ($1, $2, $3) ON CONFLICT (conversation_id, message_id) DO NOTHING",
        [conversationId, messageId, userId]
      );
    }

    const pin = (await this.listPins(conversationId, userId)).find((p) => p.messageId === messageId)!;
    broadcast(this.gateway, await this.access.activeMemberIds(conversationId), { type: "message:pinned", conversationId, pin });
    return pin;
  }

  async unpin(messageId: string, userId: string): Promise<void> {
    const pinned = await this.db.query<{ conversation_id: string }>("SELECT conversation_id FROM pinned_messages WHERE message_id = $1", [
      messageId,
    ]);
    const conversationId = pinned.rows[0]?.conversation_id;
    if (!conversationId || !(await this.access.isActiveMember(conversationId, userId))) throw new AppError("Pinned message not found", 404);
    await this.requirePinPermission(conversationId, userId);
    await this.db.query("DELETE FROM pinned_messages WHERE conversation_id = $1 AND message_id = $2", [conversationId, messageId]);
    broadcast(this.gateway, await this.access.activeMemberIds(conversationId), { type: "message:unpinned", conversationId, messageId });
  }

  // --- Saved / starred ------------------------------------------------------

  async listSaved(
    userId: string,
    filters: { q?: string; label?: string; starred?: boolean; conversationId?: string } = {}
  ): Promise<SavedMessageDTO[]> {
    const params: unknown[] = [userId];
    const where: string[] = ["s.user_id = $1"];
    if (filters.label) {
      params.push(filters.label);
      where.push(`s.label = $${params.length}`);
    }
    if (filters.starred !== undefined) {
      params.push(filters.starred);
      where.push(`s.starred = $${params.length}`);
    }
    if (filters.conversationId) {
      params.push(filters.conversationId);
      where.push(`s.conversation_id = $${params.length}`);
    }
    if (filters.q) {
      params.push(`%${escapeLike(filters.q)}%`);
      where.push(`(m.body ILIKE $${params.length} OR s.note ILIKE $${params.length} OR s.label ILIKE $${params.length})`);
    }
    const result = await this.db.query<
      PreviewColumns & { label: string | null; starred: boolean; note: string | null; created_at: Date; updated_at: Date }
    >(
      `SELECT s.label, s.starred, s.note, s.created_at, s.updated_at, ${PREVIEW_SELECT}
       FROM saved_messages s
       ${VISIBLE_MESSAGE_JOIN("s.message_id", "$1")}
       WHERE ${where.join(" AND ")}
       ORDER BY s.created_at DESC
       LIMIT 500`,
      params
    );
    const titles = await this.conversationTitles(userId, [...new Set(result.rows.map((row) => row.m_conversation_id))]);
    return result.rows.map((row) => ({
      messageId: row.m_id,
      conversationId: row.m_conversation_id,
      conversationTitle: titles.get(row.m_conversation_id) ?? "Conversation",
      label: row.label,
      starred: row.starred,
      note: row.note,
      savedAt: row.created_at,
      updatedAt: row.updated_at,
      message: toPreview(row),
    }));
  }

  async listLabels(userId: string): Promise<string[]> {
    const result = await this.db.query<{ label: string }>(
      "SELECT DISTINCT label FROM saved_messages WHERE user_id = $1 AND label IS NOT NULL ORDER BY label",
      [userId]
    );
    return result.rows.map((row) => row.label);
  }

  /** Saves a message (or updates an existing save's label/star/note). */
  async save(userId: string, messageId: string, input: { label?: string | null; starred?: boolean; note?: string | null }): Promise<SavedMessageDTO> {
    const conversationId = await this.access.visibleMessageConversation(messageId, userId);
    if (!conversationId) throw new AppError("Message not found", 404);

    const existing = await this.db.query("SELECT 1 FROM saved_messages WHERE user_id = $1 AND message_id = $2", [userId, messageId]);
    if (existing.rowCount === 0) {
      await this.db.query(
        `INSERT INTO saved_messages (user_id, message_id, conversation_id, label, starred, note) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, message_id) DO NOTHING`,
        [userId, messageId, conversationId, input.label ?? null, input.starred ?? false, input.note ?? null]
      );
    } else {
      const sets: string[] = [];
      const params: unknown[] = [userId, messageId];
      for (const [key, column] of [["label", "label"], ["starred", "starred"], ["note", "note"]] as const) {
        if (input[key] !== undefined) {
          params.push(input[key]);
          sets.push(`${column} = $${params.length}`);
        }
      }
      if (sets.length > 0) {
        await this.db.query(`UPDATE saved_messages SET ${sets.join(", ")}, updated_at = now() WHERE user_id = $1 AND message_id = $2`, params);
      }
    }
    const saved = (await this.listSaved(userId, { conversationId })).find((s) => s.messageId === messageId)!;
    this.gateway.sendToUser(userId, { type: "saved:updated", messageId, saved });
    return saved;
  }

  async unsave(userId: string, messageId: string): Promise<void> {
    const result = await this.db.query("DELETE FROM saved_messages WHERE user_id = $1 AND message_id = $2 RETURNING message_id", [userId, messageId]);
    if (result.rowCount === 0) throw new AppError("Saved message not found", 404);
    this.gateway.sendToUser(userId, { type: "saved:updated", messageId, saved: null });
  }

  /** Which of these messages the user has saved — used to render bookmark state in a chat. */
  async savedIdsInConversation(userId: string, conversationId: string): Promise<Array<{ messageId: string; starred: boolean }>> {
    await this.access.require(conversationId, userId);
    const result = await this.db.query<{ message_id: string; starred: boolean }>(
      "SELECT message_id, starred FROM saved_messages WHERE user_id = $1 AND conversation_id = $2",
      [userId, conversationId]
    );
    return result.rows.map((row) => ({ messageId: row.message_id, starred: row.starred }));
  }

  /** Display titles: the group name, or the other person's name in a direct chat. */
  private async conversationTitles(userId: string, conversationIds: string[]): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    if (conversationIds.length === 0) return titles;
    const groups = await this.db.query<{ conversation_id: string; name: string }>(
      `SELECT conversation_id, name FROM groups WHERE conversation_id IN (${placeholders(conversationIds)})`,
      conversationIds
    );
    for (const row of groups.rows) titles.set(row.conversation_id, row.name);
    const others = await this.db.query<{ conversation_id: string; display_name: string }>(
      `SELECT cm.conversation_id, u.display_name FROM conversation_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.user_id <> $1 AND cm.conversation_id IN (${placeholders(conversationIds, 1)})`,
      [userId, ...conversationIds]
    );
    for (const row of others.rows) if (!titles.has(row.conversation_id)) titles.set(row.conversation_id, row.display_name);
    return titles;
  }
}
