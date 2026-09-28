export type AttachmentKind = "image" | "video" | "audio" | "document" | "file";

/** Mirrors backend AttachmentDTO. */
export interface AttachmentDTO {
  id: string;
  conversationId: string;
  messageId: string | null;
  uploaderId: string;
  kind: AttachmentKind;
  mimeType: string;
  sizeBytes: number;
  originalFilename: string;
  createdAt: string;
}
