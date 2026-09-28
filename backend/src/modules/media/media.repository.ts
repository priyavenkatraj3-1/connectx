import type { DatabaseClient } from "../../db/pool";
import type { AttachmentKind, AttachmentRecord } from "./media.types";

interface AttachmentRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  uploader_id: string;
  storage_key: string;
  original_filename: string;
  kind: AttachmentKind;
  mime_type: string;
  size_bytes: string | number;
  created_at: Date;
  updated_at: Date;
}

const ATTACHMENT_COLUMNS = `id, conversation_id, message_id, uploader_id, storage_key, original_filename, kind,
  mime_type, size_bytes, created_at, updated_at`;

function toRecord(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    uploaderId: row.uploader_id,
    storageKey: row.storage_key,
    originalFilename: row.original_filename,
    kind: row.kind,
    mimeType: row.mime_type,
    // BIGINT comes back from `pg` as a string.
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MediaRepository {
  constructor(private readonly db: DatabaseClient) {}

  async insert(input: {
    id: string;
    conversationId: string;
    uploaderId: string;
    storageKey: string;
    originalFilename: string;
    kind: AttachmentKind;
    mimeType: string;
    sizeBytes: number;
  }): Promise<AttachmentRecord> {
    const result = await this.db.query<AttachmentRow>(
      `INSERT INTO attachments (id, conversation_id, uploader_id, storage_key, original_filename, kind, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${ATTACHMENT_COLUMNS}`,
      [
        input.id,
        input.conversationId,
        input.uploaderId,
        input.storageKey,
        input.originalFilename,
        input.kind,
        input.mimeType,
        input.sizeBytes,
      ]
    );
    return toRecord(result.rows[0]!);
  }

  async findById(attachmentId: string, db: DatabaseClient = this.db): Promise<AttachmentRecord | null> {
    const result = await db.query<AttachmentRow>(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id = $1`, [
      attachmentId,
    ]);
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async findByMessageIds(messageIds: string[], db: DatabaseClient = this.db): Promise<AttachmentRecord[]> {
    if (messageIds.length === 0) return [];
    const placeholders = messageIds.map((_, i) => `$${i + 1}`).join(", ");
    const result = await db.query<AttachmentRow>(
      `SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`,
      messageIds
    );
    return result.rows.map(toRecord);
  }

  /**
   * Links an uploaded, not-yet-sent attachment to a message. The WHERE
   * clause re-asserts every precondition (same uploader, same conversation,
   * not already attached) so a concurrent send can't attach it twice.
   */
  async attachToMessage(
    attachmentId: string,
    messageId: string,
    uploaderId: string,
    conversationId: string,
    db: DatabaseClient = this.db
  ): Promise<boolean> {
    // `NOT (message_id IS NOT NULL)` is exactly `message_id IS NULL`; it is
    // spelled this way because pg-mem (the test engine) mis-evaluates
    // `id = $1 AND message_id IS NULL` via the message_id index once the
    // table has several rows. RETURNING (rather than rowCount) for the same
    // portability reason.
    const result = await db.query<{ id: string }>(
      `UPDATE attachments SET message_id = $2, updated_at = now()
       WHERE id = $1 AND uploader_id = $3 AND conversation_id = $4 AND NOT (message_id IS NOT NULL)
       RETURNING id`,
      [attachmentId, messageId, uploaderId, conversationId]
    );
    return result.rows.length > 0;
  }

  async deleteById(attachmentId: string, db: DatabaseClient = this.db): Promise<void> {
    await db.query("DELETE FROM attachments WHERE id = $1", [attachmentId]);
  }
}
