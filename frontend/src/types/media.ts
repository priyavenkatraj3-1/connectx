export type AttachmentKind = "image" | "video" | "audio" | "document" | "file";

/** Mirrors backend AttachmentDTO. */
export interface AttachmentDTO {
  id: string;
  /** Null for status media (Phase 4). */
  conversationId: string | null;
  /** "message" (chat attachment) or "status" (status media). Optional so Phase 3-shaped payloads still type-check. */
  purpose?: "message" | "status";
  messageId: string | null;
  uploaderId: string;
  kind: AttachmentKind;
  mimeType: string;
  sizeBytes: number;
  originalFilename: string;
  createdAt: string;
}
