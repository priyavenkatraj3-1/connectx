export type AttachmentKind = "image" | "video" | "audio" | "document" | "file";

/** Attachment metadata as exposed to API clients. `storageKey` is deliberately never included. */
export interface AttachmentDTO {
  id: string;
  conversationId: string;
  messageId: string | null;
  uploaderId: string;
  kind: AttachmentKind;
  mimeType: string;
  sizeBytes: number;
  originalFilename: string;
  createdAt: Date;
}

/** Full attachment record, including server-only fields. */
export interface AttachmentRecord extends AttachmentDTO {
  storageKey: string;
  updatedAt: Date;
}

export function toAttachmentDTO(record: AttachmentRecord): AttachmentDTO {
  return {
    id: record.id,
    conversationId: record.conversationId,
    messageId: record.messageId,
    uploaderId: record.uploaderId,
    kind: record.kind,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    originalFilename: record.originalFilename,
    createdAt: record.createdAt,
  };
}
