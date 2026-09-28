import { AppError } from "../../middleware/errorHandler";
import { generateId } from "../../utils/id";
import type { ConversationsRepository } from "../conversations/conversations.repository";
import type { MessagesRepository } from "../messages/messages.repository";
import { validateUploadedFile } from "./file-validation";
import type { MediaRepository } from "./media.repository";
import { toAttachmentDTO, type AttachmentDTO, type AttachmentPurpose, type AttachmentRecord } from "./media.types";
import { buildStatusStorageKey, buildStorageKey, type StorageProvider } from "./storage/storage-provider.interface";

/**
 * How MediaService learns whether a viewer may see status media, without
 * depending on the statuses module (implemented by StatusesRepository).
 */
export interface StatusMediaAccess {
  /** The status that uses this attachment, or null if it hasn't been published yet. */
  findStatusIdByAttachment(attachmentId: string): Promise<string | null>;
  /** Applies the status' privacy setting and expiry. */
  isVisibleTo(statusId: string, viewerId: string): Promise<boolean>;
}

/**
 * Media foundation. Upload flow:
 *   1. POST /media — bytes are validated, stored, and an *unattached*
 *      attachment row is created (visible only to its uploader).
 *   2. POST /messages/:conversationId with { attachmentId } — the
 *      attachment is linked to the new message and becomes visible to
 *      conversation members.
 *
 * Access rules for reading a message attachment (metadata or bytes):
 *   * the requester must be an active member of the attachment's conversation;
 *   * unattached: only the uploader;
 *   * attached: the message must not be deleted and must have been sent
 *     after the requester joined (same visibility as the message itself).
 *
 * Status media (Phase 4, purpose = "status") goes through the same upload
 * validation and storage, but has no conversation. It is readable by its
 * uploader, and — once published as a status — by exactly the viewers that
 * status' privacy setting allows, until it expires.
 */
export class MediaService {
  constructor(
    private readonly mediaRepository: MediaRepository,
    private readonly conversationsRepository: ConversationsRepository,
    private readonly messagesRepository: MessagesRepository,
    private readonly storage: StorageProvider,
    private readonly maxUploadBytes: number,
    private readonly statusMediaAccess: StatusMediaAccess
  ) {}

  async upload(input: {
    uploaderId: string;
    purpose?: AttachmentPurpose;
    conversationId?: string;
    originalName: string;
    declaredMimeType?: string;
    data: Buffer;
  }): Promise<AttachmentDTO> {
    const purpose = input.purpose ?? "message";
    if (purpose === "message") {
      if (!input.conversationId) throw new AppError("conversationId is required", 400);
      const isMember = await this.conversationsRepository.isMember(input.conversationId, input.uploaderId);
      if (!isMember) {
        throw new AppError("You do not have access to this conversation", 403);
      }
    }

    const validation = validateUploadedFile(
      { originalName: input.originalName, declaredMimeType: input.declaredMimeType, data: input.data },
      this.maxUploadBytes
    );
    if (!validation.ok) {
      throw new AppError(validation.reason, validation.statusCode);
    }
    if (purpose === "status" && validation.kind !== "image" && validation.kind !== "video") {
      throw new AppError("A status can only be a photo or a video", 415);
    }

    const id = generateId();
    const conversationId = purpose === "message" ? input.conversationId! : null;
    const storageKey =
      purpose === "message" ? buildStorageKey(conversationId!, id) : buildStatusStorageKey(input.uploaderId, id);
    await this.storage.save(storageKey, input.data);

    try {
      const record = await this.mediaRepository.insert({
        id,
        conversationId,
        purpose,
        uploaderId: input.uploaderId,
        storageKey,
        originalFilename: validation.fileName,
        kind: validation.kind,
        mimeType: validation.mimeType,
        sizeBytes: validation.sizeBytes,
      });
      return toAttachmentDTO(record);
    } catch (err) {
      // Never leave bytes on disk without metadata pointing at them.
      await this.storage.delete(storageKey).catch(() => undefined);
      throw err;
    }
  }

  private async requireReadable(attachmentId: string, userId: string): Promise<AttachmentRecord> {
    const attachment = await this.mediaRepository.findById(attachmentId);
    if (!attachment) throw new AppError("Attachment not found", 404);

    if (attachment.purpose === "status") {
      if (attachment.uploaderId === userId) return attachment;
      const statusId = await this.statusMediaAccess.findStatusIdByAttachment(attachment.id);
      // Same 404 whether unpublished, expired or hidden by privacy — never confirm the file exists.
      if (!statusId || !(await this.statusMediaAccess.isVisibleTo(statusId, userId))) {
        throw new AppError("Attachment not found", 404);
      }
      return attachment;
    }

    const membership = await this.conversationsRepository.getActiveMembership(attachment.conversationId!, userId);
    if (!membership) throw new AppError("You do not have access to this attachment", 403);

    if (attachment.messageId === null) {
      if (attachment.uploaderId !== userId) throw new AppError("You do not have access to this attachment", 403);
      return attachment;
    }

    const message = await this.messagesRepository.findRecordById(attachment.messageId);
    if (!message || message.deletedAt !== null) throw new AppError("Attachment not found", 404);
    if (!(await this.messagesRepository.isVisibleTo(message.id, userId))) {
      throw new AppError("You do not have access to this attachment", 403);
    }
    return attachment;
  }

  async getMetadata(attachmentId: string, userId: string): Promise<AttachmentDTO> {
    return toAttachmentDTO(await this.requireReadable(attachmentId, userId));
  }

  async getContent(attachmentId: string, userId: string): Promise<{ attachment: AttachmentDTO; data: Buffer }> {
    const attachment = await this.requireReadable(attachmentId, userId);
    let data: Buffer;
    try {
      data = await this.storage.read(attachment.storageKey);
    } catch {
      throw new AppError("Attachment content is unavailable", 404);
    }
    return { attachment: toAttachmentDTO(attachment), data };
  }

  /** Only the uploader may delete, and only before it is sent — a sent attachment is removed by deleting its message. */
  async delete(attachmentId: string, userId: string): Promise<void> {
    const attachment = await this.mediaRepository.findById(attachmentId);
    if (!attachment) throw new AppError("Attachment not found", 404);
    if (attachment.uploaderId !== userId) {
      throw new AppError("You can only delete your own attachments", 403);
    }
    if (attachment.messageId !== null) {
      throw new AppError("This attachment has been sent; delete the message instead", 409);
    }
    if (attachment.purpose === "status" && (await this.statusMediaAccess.findStatusIdByAttachment(attachment.id))) {
      throw new AppError("This media is part of a published status; delete the status instead", 409);
    }

    await this.mediaRepository.deleteById(attachmentId);
    await this.storage.delete(attachment.storageKey).catch(() => undefined);
  }
}
