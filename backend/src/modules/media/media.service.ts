import { AppError } from "../../middleware/errorHandler";
import { generateId } from "../../utils/id";
import type { ConversationsRepository } from "../conversations/conversations.repository";
import type { MessagesRepository } from "../messages/messages.repository";
import { validateUploadedFile } from "./file-validation";
import type { MediaRepository } from "./media.repository";
import { toAttachmentDTO, type AttachmentDTO, type AttachmentRecord } from "./media.types";
import { buildStorageKey, type StorageProvider } from "./storage/storage-provider.interface";

/**
 * Media foundation. Upload flow:
 *   1. POST /media — bytes are validated, stored, and an *unattached*
 *      attachment row is created (visible only to its uploader).
 *   2. POST /messages/:conversationId with { attachmentId } — the
 *      attachment is linked to the new message and becomes visible to
 *      conversation members.
 *
 * Access rules for reading an attachment (metadata or bytes):
 *   * the requester must be an active member of the attachment's conversation;
 *   * unattached: only the uploader;
 *   * attached: the message must not be deleted and must have been sent
 *     after the requester joined (same visibility as the message itself).
 */
export class MediaService {
  constructor(
    private readonly mediaRepository: MediaRepository,
    private readonly conversationsRepository: ConversationsRepository,
    private readonly messagesRepository: MessagesRepository,
    private readonly storage: StorageProvider,
    private readonly maxUploadBytes: number
  ) {}

  async upload(input: {
    uploaderId: string;
    conversationId: string;
    originalName: string;
    declaredMimeType?: string;
    data: Buffer;
  }): Promise<AttachmentDTO> {
    const isMember = await this.conversationsRepository.isMember(input.conversationId, input.uploaderId);
    if (!isMember) {
      throw new AppError("You do not have access to this conversation", 403);
    }

    const validation = validateUploadedFile(
      { originalName: input.originalName, declaredMimeType: input.declaredMimeType, data: input.data },
      this.maxUploadBytes
    );
    if (!validation.ok) {
      throw new AppError(validation.reason, validation.statusCode);
    }

    const id = generateId();
    const storageKey = buildStorageKey(input.conversationId, id);
    await this.storage.save(storageKey, input.data);

    try {
      const record = await this.mediaRepository.insert({
        id,
        conversationId: input.conversationId,
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

    const membership = await this.conversationsRepository.getActiveMembership(attachment.conversationId, userId);
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

    await this.mediaRepository.deleteById(attachmentId);
    await this.storage.delete(attachment.storageKey).catch(() => undefined);
  }
}
