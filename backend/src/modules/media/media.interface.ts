export interface Attachment {
  id: string;
  messageId: string | null;
  uploaderId: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}

/**
 * Contract for media/file storage. Implemented in a later phase once an
 * object storage backend (e.g. S3-compatible) is wired up. File metadata is
 * validated on the way in via `middleware/uploadValidation.ts` regardless
 * of which storage backend ends up implementing this interface.
 */
export interface MediaService {
  uploadAttachment(input: {
    uploaderId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    data: Buffer;
  }): Promise<Attachment>;
  getAttachment(attachmentId: string, requestingUserId: string): Promise<Attachment | null>;
  deleteAttachment(attachmentId: string, requestingUserId: string): Promise<void>;
}
