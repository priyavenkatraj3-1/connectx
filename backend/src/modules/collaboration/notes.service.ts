import type { DatabaseClient } from "../../db/pool";
import { AppError } from "../../middleware/errorHandler";
import { broadcast } from "../../realtime/broadcast";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import { generateId } from "../../utils/id";
import type { ConversationAccess, ConversationAccessService } from "./conversation-access";

export type NoteEditPolicy = "members" | "admins";

export interface SharedNoteDTO {
  id: string;
  conversationId: string;
  title: string;
  content: string;
  editPolicy: NoteEditPolicy;
  version: number;
  createdBy: { id: string; displayName: string };
  updatedBy: { id: string; displayName: string } | null;
  createdAt: Date;
  updatedAt: Date;
  /** Computed for the requesting user. */
  canEdit: boolean;
  canDelete: boolean;
}

interface NoteRow {
  id: string;
  conversation_id: string;
  title: string;
  content: string;
  edit_policy: NoteEditPolicy;
  version: number;
  created_by: string;
  created_by_name: string;
  updated_by: string | null;
  updated_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_NOTE = `
  SELECT n.*, cu.display_name AS created_by_name, uu.display_name AS updated_by_name
  FROM shared_notes n
  JOIN users cu ON cu.id = n.created_by
  LEFT JOIN users uu ON uu.id = n.updated_by
`;

/**
 * Who may do what with a note:
 *   read / create        — any active member of the conversation
 *   edit                 — any member, unless a group note's policy is
 *                          "admins": then only owner/admins and its creator
 *   change edit policy   — group owner/admins and the note's creator
 *   delete               — the note's creator and group owner/admins
 */
export function notePermissions(row: { created_by: string; edit_policy: NoteEditPolicy }, userId: string, access: ConversationAccess) {
  const isCreator = row.created_by === userId;
  const canEdit = access.type === "direct" || row.edit_policy === "members" || access.isAdmin || isCreator;
  return { canEdit, canDelete: isCreator || access.isAdmin, canChangePolicy: access.type === "group" && (isCreator || access.isAdmin) };
}

function toDTO(row: NoteRow, userId: string, access: ConversationAccess): SharedNoteDTO {
  const { canEdit, canDelete } = notePermissions(row, userId, access);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    title: row.title,
    content: row.content,
    editPolicy: row.edit_policy,
    version: Number(row.version),
    createdBy: { id: row.created_by, displayName: row.created_by_name },
    updatedBy: row.updated_by ? { id: row.updated_by, displayName: row.updated_by_name ?? "" } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canEdit,
    canDelete,
  };
}

export interface NoteUpdate {
  title?: string;
  content?: string;
  editPolicy?: NoteEditPolicy;
  /** Optimistic concurrency: reject the edit if someone else saved in between. */
  expectedVersion?: number;
}

export class SharedNotesService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly gateway: RealtimeGateway,
    private readonly access: ConversationAccessService
  ) {}

  private async loadRow(noteId: string): Promise<NoteRow | null> {
    const result = await this.db.query<NoteRow>(`${SELECT_NOTE} WHERE n.id = $1`, [noteId]);
    return result.rows[0] ?? null;
  }

  /** Loads a note and the caller's access; 404 for missing notes *and* for notes in conversations the caller can't see. */
  private async loadForMember(noteId: string, userId: string): Promise<{ row: NoteRow; access: ConversationAccess }> {
    const row = await this.loadRow(noteId);
    const access = row ? await this.access.find(row.conversation_id, userId) : null;
    if (!row || !access) throw new AppError("Note not found", 404);
    return { row, access };
  }

  async list(conversationId: string, userId: string): Promise<SharedNoteDTO[]> {
    const access = await this.access.require(conversationId, userId);
    const result = await this.db.query<NoteRow>(`${SELECT_NOTE} WHERE n.conversation_id = $1 ORDER BY n.updated_at DESC LIMIT 200`, [
      conversationId,
    ]);
    return result.rows.map((row) => toDTO(row, userId, access));
  }

  async get(noteId: string, userId: string): Promise<SharedNoteDTO> {
    const { row, access } = await this.loadForMember(noteId, userId);
    return toDTO(row, userId, access);
  }

  async create(
    userId: string,
    input: { conversationId: string; title: string; content?: string; editPolicy?: NoteEditPolicy }
  ): Promise<SharedNoteDTO> {
    const access = await this.access.require(input.conversationId, userId);
    const editPolicy = input.editPolicy ?? "members";
    if (editPolicy === "admins" && !(access.type === "group" && access.isAdmin)) {
      throw new AppError("Only group admins can create admin-only notes", 403);
    }
    const id = generateId();
    await this.db.query(
      `INSERT INTO shared_notes (id, conversation_id, title, content, edit_policy, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [id, input.conversationId, input.title, input.content ?? "", editPolicy, userId]
    );
    return this.publish(id, userId);
  }

  async update(noteId: string, userId: string, update: NoteUpdate): Promise<SharedNoteDTO> {
    const { row, access } = await this.loadForMember(noteId, userId);
    const permissions = notePermissions(row, userId, access);
    if (!permissions.canEdit) throw new AppError("Only group admins can edit this note", 403);
    if (update.editPolicy !== undefined && update.editPolicy !== row.edit_policy && !permissions.canChangePolicy) {
      throw new AppError("Only the note's creator or group admins can change who may edit it", 403);
    }

    const sets: string[] = [];
    const params: unknown[] = [noteId, userId];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (update.title !== undefined) push("title", update.title);
    if (update.content !== undefined) push("content", update.content);
    if (update.editPolicy !== undefined) push("edit_policy", update.editPolicy);

    let versionClause = "";
    if (update.expectedVersion !== undefined) {
      params.push(update.expectedVersion);
      versionClause = ` AND version = $${params.length}`;
    }
    const result = await this.db.query(
      `UPDATE shared_notes SET ${sets.join(", ")}, version = version + 1, updated_by = $2, updated_at = now()
       WHERE id = $1${versionClause} RETURNING id`,
      params
    );
    if (result.rowCount === 0) {
      throw new AppError("This note was changed by someone else. Reload it and try again.", 409, true, "note_conflict");
    }
    return this.publish(noteId, userId);
  }

  async remove(noteId: string, userId: string): Promise<void> {
    const { row, access } = await this.loadForMember(noteId, userId);
    if (!notePermissions(row, userId, access).canDelete) {
      throw new AppError("Only the note's creator or group admins can delete it", 403);
    }
    await this.db.query("DELETE FROM shared_notes WHERE id = $1", [noteId]);
    broadcast(this.gateway, await this.access.activeMemberIds(row.conversation_id), {
      type: "note:deleted",
      conversationId: row.conversation_id,
      noteId,
    });
  }

  /**
   * Sends the note to every active member. Permission flags differ per
   * member, so each gets their own copy computed from their own access.
   */
  private async publish(noteId: string, actorId: string): Promise<SharedNoteDTO> {
    const row = (await this.loadRow(noteId))!;
    let actorView: SharedNoteDTO | null = null;
    for (const memberId of await this.access.activeMemberIds(row.conversation_id)) {
      const access = await this.access.find(row.conversation_id, memberId);
      if (!access) continue;
      const note = toDTO(row, memberId, access);
      if (memberId === actorId) actorView = note;
      this.gateway.sendToUser(memberId, { type: "note:updated", conversationId: row.conversation_id, note });
    }
    return actorView!;
  }
}
