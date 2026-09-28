import type { DatabaseClient } from "../../db/pool";
import { generateId } from "../../utils/id";
import type { StatusMediaAccess } from "../media/media.service";
import type {
  StatusBackgroundColor,
  StatusMediaDTO,
  StatusPrivacySettingsDTO,
  StatusType,
  StatusViewerDTO,
  StatusVisibility,
} from "./statuses.types";

interface StatusRow {
  id: string;
  user_id: string;
  content_type: StatusType;
  body: string | null;
  background_color: StatusBackgroundColor | null;
  attachment_id: string | null;
  visibility: StatusVisibility;
  expires_at: Date;
  created_at: Date;
  attachment_kind: "image" | "video" | null;
  attachment_mime_type: string | null;
  attachment_size_bytes: string | number | null;
  attachment_storage_key: string | null;
}

export interface StatusRecord {
  id: string;
  userId: string;
  type: StatusType;
  text: string | null;
  backgroundColor: StatusBackgroundColor | null;
  media: StatusMediaDTO | null;
  /** Server-only: where the media bytes live. */
  storageKey: string | null;
  visibility: StatusVisibility;
  audienceUserIds: string[];
  createdAt: Date;
  expiresAt: Date;
}

const STATUS_SELECT = `
  SELECT s.id, s.user_id, s.content_type, s.body, s.background_color, s.attachment_id, s.visibility,
         s.expires_at, s.created_at,
         a.kind AS attachment_kind, a.mime_type AS attachment_mime_type, a.size_bytes AS attachment_size_bytes,
         a.storage_key AS attachment_storage_key
  FROM statuses s
  LEFT JOIN attachments a ON a.id = s.attachment_id
`;

function placeholders(values: unknown[], offset = 0): string {
  return values.map((_, i) => `$${i + 1 + offset}`).join(", ");
}

function toRecord(row: StatusRow, audienceUserIds: string[]): StatusRecord {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.content_type,
    text: row.body,
    backgroundColor: row.background_color,
    media:
      row.attachment_id && row.attachment_kind
        ? {
            attachmentId: row.attachment_id,
            kind: row.attachment_kind,
            mimeType: row.attachment_mime_type!,
            sizeBytes: Number(row.attachment_size_bytes),
          }
        : null,
    storageKey: row.attachment_storage_key,
    visibility: row.visibility,
    audienceUserIds,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Persistence and privacy rules for statuses.
 *
 * Every "is this still active?" check is done in SQL against the
 * database clock (`expires_at > now()`), so the backend alone decides
 * expiry — a client with a wrong clock can't see (or hide) anything.
 *
 * Relationship definitions used by the privacy rules:
 *   * contacts(owner): users in a direct conversation with the owner that
 *     the *owner* engaged in — they started it or have sent a message in
 *     it. Someone who merely opened a chat with you can't make themselves
 *     your contact.
 *   * chatPeers(owner): contacts plus everyone who shares an active group
 *     with the owner.
 */
export class StatusesRepository implements StatusMediaAccess {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: {
    ownerId: string;
    type: StatusType;
    text: string | null;
    backgroundColor: StatusBackgroundColor | null;
    attachmentId: string | null;
    visibility: StatusVisibility;
    audienceUserIds: string[];
    expiresAt: Date;
  }): Promise<StatusRecord> {
    const id = generateId();
    await this.db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO statuses (id, user_id, content_type, body, background_color, attachment_id, visibility, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, input.ownerId, input.type, input.text, input.backgroundColor, input.attachmentId, input.visibility, input.expiresAt]
      );
      for (const userId of input.audienceUserIds) {
        await tx.query("INSERT INTO status_audience (status_id, user_id) VALUES ($1, $2)", [id, userId]);
      }
    });
    return (await this.findById(id))!;
  }

  /** Any status by ID, including expired ones (callers decide what expiry means for them). */
  async findById(statusId: string): Promise<StatusRecord | null> {
    const result = await this.db.query<StatusRow>(`${STATUS_SELECT} WHERE s.id = $1`, [statusId]);
    const row = result.rows[0];
    if (!row) return null;
    const audience = await this.audienceFor([row.id]);
    return toRecord(row, audience.get(row.id) ?? []);
  }

  async isActive(statusId: string): Promise<boolean> {
    const result = await this.db.query("SELECT 1 FROM statuses WHERE id = $1 AND expires_at > now()", [statusId]);
    return result.rowCount > 0;
  }

  /** Active (unexpired) statuses of the given owners, oldest first. */
  async listActiveByOwners(ownerIds: string[]): Promise<StatusRecord[]> {
    if (ownerIds.length === 0) return [];
    const result = await this.db.query<StatusRow>(
      `${STATUS_SELECT} WHERE s.user_id IN (${placeholders(ownerIds)}) AND s.expires_at > now() ORDER BY s.created_at ASC`,
      ownerIds
    );
    const audience = await this.audienceFor(result.rows.map((row) => row.id));
    return result.rows.map((row) => toRecord(row, audience.get(row.id) ?? []));
  }

  /** Owners with an active status whose explicit allow-list ("selected") includes the viewer. */
  async findOwnersSelectingViewer(viewerId: string): Promise<string[]> {
    const result = await this.db.query<{ user_id: string }>(
      `SELECT DISTINCT s.user_id
       FROM status_audience sa
       JOIN statuses s ON s.id = sa.status_id
       WHERE sa.user_id = $1 AND s.visibility = 'selected' AND s.expires_at > now()`,
      [viewerId]
    );
    return result.rows.map((row) => row.user_id);
  }

  async listExpired(limit = 200): Promise<StatusRecord[]> {
    const result = await this.db.query<StatusRow>(
      `${STATUS_SELECT} WHERE s.expires_at <= now() ORDER BY s.expires_at ASC LIMIT $1`,
      [limit]
    );
    const audience = await this.audienceFor(result.rows.map((row) => row.id));
    return result.rows.map((row) => toRecord(row, audience.get(row.id) ?? []));
  }

  /** Deletes the status (views and audience cascade) and its media metadata row. Media bytes are the caller's job. */
  async delete(status: StatusRecord): Promise<void> {
    await this.db.withTransaction(async (tx) => {
      await tx.query("DELETE FROM statuses WHERE id = $1", [status.id]);
      if (status.media) {
        await tx.query("DELETE FROM attachments WHERE id = $1", [status.media.attachmentId]);
      }
    });
  }

  // --- Relationships -------------------------------------------------------

  /** See the class comment for the definition. */
  async contactIds(ownerId: string): Promise<Set<string>> {
    const conversations = await this.db.query<{ id: string }>(
      `SELECT c.id
       FROM conversations c
       JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = $1 AND me.left_at IS NULL
       WHERE c.type = 'direct'
         AND (c.created_by = $1 OR c.id IN (SELECT conversation_id FROM messages WHERE sender_id = $1 AND deleted_at IS NULL))`,
      [ownerId]
    );
    return this.otherActiveMembers(
      conversations.rows.map((row) => row.id),
      ownerId
    );
  }

  /** Contacts plus active co-members of the owner's groups. */
  async chatPeerIds(ownerId: string): Promise<Set<string>> {
    const groups = await this.db.query<{ conversation_id: string }>(
      `SELECT cm.conversation_id
       FROM conversation_members cm
       JOIN conversations c ON c.id = cm.conversation_id
       WHERE cm.user_id = $1 AND cm.left_at IS NULL AND c.type = 'group'`,
      [ownerId]
    );
    const [contacts, groupPeers] = await Promise.all([
      this.contactIds(ownerId),
      this.otherActiveMembers(
        groups.rows.map((row) => row.conversation_id),
        ownerId
      ),
    ]);
    return new Set([...contacts, ...groupPeers]);
  }

  /** Everyone the viewer shares an active conversation (direct or group) with — candidate status owners for their feed. */
  async conversationPeerIds(userId: string): Promise<Set<string>> {
    const conversations = await this.db.query<{ conversation_id: string }>(
      "SELECT conversation_id FROM conversation_members WHERE user_id = $1 AND left_at IS NULL",
      [userId]
    );
    return this.otherActiveMembers(
      conversations.rows.map((row) => row.conversation_id),
      userId
    );
  }

  private async otherActiveMembers(conversationIds: string[], excludeUserId: string): Promise<Set<string>> {
    if (conversationIds.length === 0) return new Set();
    const result = await this.db.query<{ user_id: string }>(
      `SELECT DISTINCT cm.user_id
       FROM conversation_members cm
       JOIN users u ON u.id = cm.user_id AND u.is_active = TRUE
       WHERE cm.left_at IS NULL AND cm.user_id != $1 AND cm.conversation_id IN (${placeholders(conversationIds, 1)})`,
      [excludeUserId, ...conversationIds]
    );
    return new Set(result.rows.map((row) => row.user_id));
  }

  // --- Privacy ---------------------------------------------------------------

  /**
   * The single privacy decision point: may `viewerId` see this status?
   * Owners always see their own; nobody (owner included, via this path)
   * sees an expired status.
   */
  async canView(status: StatusRecord, viewerId: string, contactsCache?: Map<string, Set<string>>): Promise<boolean> {
    if (status.userId === viewerId) return true;
    switch (status.visibility) {
      case "selected":
        return status.audienceUserIds.includes(viewerId);
      case "contacts":
        return (await this.cachedContacts(status.userId, contactsCache)).has(viewerId);
      case "except":
        return !status.audienceUserIds.includes(viewerId) && (await this.cachedContacts(status.userId, contactsCache)).has(viewerId);
      case "everyone":
        return (await this.chatPeerIds(status.userId)).has(viewerId);
    }
  }

  /** Every user (other than the owner) currently allowed to see the status — used to target realtime events. */
  async audienceOf(status: StatusRecord): Promise<string[]> {
    switch (status.visibility) {
      case "selected":
        return status.audienceUserIds;
      case "contacts":
        return [...(await this.contactIds(status.userId))];
      case "except": {
        const excluded = new Set(status.audienceUserIds);
        return [...(await this.contactIds(status.userId))].filter((id) => !excluded.has(id));
      }
      case "everyone":
        return [...(await this.chatPeerIds(status.userId))];
    }
  }

  private async cachedContacts(ownerId: string, cache?: Map<string, Set<string>>): Promise<Set<string>> {
    const cached = cache?.get(ownerId);
    if (cached) return cached;
    const contacts = await this.contactIds(ownerId);
    cache?.set(ownerId, contacts);
    return contacts;
  }

  // StatusMediaAccess (used by MediaService to authorize status media reads)

  async findStatusIdByAttachment(attachmentId: string): Promise<string | null> {
    const result = await this.db.query<{ id: string }>("SELECT id FROM statuses WHERE attachment_id = $1", [attachmentId]);
    return result.rows[0]?.id ?? null;
  }

  async isVisibleTo(statusId: string, viewerId: string): Promise<boolean> {
    if (!(await this.isActive(statusId))) return false;
    const status = await this.findById(statusId);
    return !!status && (await this.canView(status, viewerId));
  }

  // --- Views -----------------------------------------------------------------

  /** Records a view once per (status, viewer). Returns true if this was the first view. */
  async recordView(statusId: string, viewerId: string): Promise<boolean> {
    // Existence is checked explicitly rather than trusting RETURNING after
    // ON CONFLICT DO NOTHING, which pg-mem (the test engine) reports
    // differently from PostgreSQL. The primary key still guarantees one row.
    const existing = await this.db.query("SELECT 1 FROM status_views WHERE status_id = $1 AND viewer_id = $2", [
      statusId,
      viewerId,
    ]);
    if (existing.rowCount > 0) return false;
    await this.db.query(
      `INSERT INTO status_views (status_id, viewer_id) VALUES ($1, $2)
       ON CONFLICT (status_id, viewer_id) DO NOTHING`,
      [statusId, viewerId]
    );
    return true;
  }

  async listViewers(statusId: string): Promise<StatusViewerDTO[]> {
    const result = await this.db.query<{ viewer_id: string; display_name: string; avatar_url: string | null; viewed_at: Date }>(
      `SELECT v.viewer_id, u.display_name, p.avatar_url, v.viewed_at
       FROM status_views v
       JOIN users u ON u.id = v.viewer_id
       LEFT JOIN user_profiles p ON p.user_id = v.viewer_id
       WHERE v.status_id = $1
       ORDER BY v.viewed_at DESC`,
      [statusId]
    );
    return result.rows.map((row) => ({
      userId: row.viewer_id,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      viewedAt: row.viewed_at,
    }));
  }

  async viewCounts(statusIds: string[]): Promise<Map<string, number>> {
    if (statusIds.length === 0) return new Map();
    const result = await this.db.query<{ status_id: string; count: string }>(
      `SELECT status_id, COUNT(*)::text AS count FROM status_views WHERE status_id IN (${placeholders(statusIds)}) GROUP BY status_id`,
      statusIds
    );
    return new Map(result.rows.map((row) => [row.status_id, Number(row.count)]));
  }

  async viewedBy(statusIds: string[], viewerId: string): Promise<Set<string>> {
    if (statusIds.length === 0) return new Set();
    const result = await this.db.query<{ status_id: string }>(
      `SELECT status_id FROM status_views WHERE viewer_id = $1 AND status_id IN (${placeholders(statusIds, 1)})`,
      [viewerId, ...statusIds]
    );
    return new Set(result.rows.map((row) => row.status_id));
  }

  // --- Default privacy settings --------------------------------------------

  async getPrivacySettings(ownerId: string): Promise<StatusPrivacySettingsDTO> {
    const [settings, users] = await Promise.all([
      this.db.query<{ visibility: StatusVisibility }>("SELECT visibility FROM status_privacy_settings WHERE user_id = $1", [ownerId]),
      this.db.query<{ user_id: string }>("SELECT user_id FROM status_privacy_users WHERE owner_id = $1", [ownerId]),
    ]);
    return {
      visibility: settings.rows[0]?.visibility ?? "contacts",
      userIds: users.rows.map((row) => row.user_id),
    };
  }

  async savePrivacySettings(ownerId: string, settings: StatusPrivacySettingsDTO): Promise<void> {
    await this.db.withTransaction(async (tx) => {
      const existing = await tx.query("SELECT 1 FROM status_privacy_settings WHERE user_id = $1", [ownerId]);
      if (existing.rowCount > 0) {
        await tx.query("UPDATE status_privacy_settings SET visibility = $2, updated_at = now() WHERE user_id = $1", [
          ownerId,
          settings.visibility,
        ]);
      } else {
        await tx.query("INSERT INTO status_privacy_settings (user_id, visibility) VALUES ($1, $2)", [ownerId, settings.visibility]);
      }
      await tx.query("DELETE FROM status_privacy_users WHERE owner_id = $1", [ownerId]);
      for (const userId of settings.userIds) {
        await tx.query("INSERT INTO status_privacy_users (owner_id, user_id) VALUES ($1, $2)", [ownerId, userId]);
      }
    });
  }

  private async audienceFor(statusIds: string[]): Promise<Map<string, string[]>> {
    const byStatus = new Map<string, string[]>();
    if (statusIds.length === 0) return byStatus;
    const result = await this.db.query<{ status_id: string; user_id: string }>(
      `SELECT status_id, user_id FROM status_audience WHERE status_id IN (${placeholders(statusIds)})`,
      statusIds
    );
    for (const row of result.rows) {
      const list = byStatus.get(row.status_id) ?? [];
      list.push(row.user_id);
      byStatus.set(row.status_id, list);
    }
    return byStatus;
  }
}
