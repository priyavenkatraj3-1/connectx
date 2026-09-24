import { env } from "../config/env";

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "application/pdf",
]);

export interface FileMetadata {
  mimeType: string;
  sizeBytes: number;
  originalName: string;
}

export interface UploadValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates uploaded file metadata before accepting a media attachment.
 * This is deliberately independent of any specific upload middleware
 * (e.g. multer) so the media module can plug in a storage backend later
 * without changing validation rules.
 */
export function validateUpload(file: FileMetadata): UploadValidationResult {
  const maxBytes = env.maxUploadSizeMb * 1024 * 1024;

  if (file.sizeBytes <= 0) {
    return { valid: false, reason: "File is empty" };
  }

  if (file.sizeBytes > maxBytes) {
    return { valid: false, reason: `File exceeds maximum size of ${env.maxUploadSizeMb}MB` };
  }

  if (!ALLOWED_MIME_TYPES.has(file.mimeType)) {
    return { valid: false, reason: `File type "${file.mimeType}" is not allowed` };
  }

  if (/[\\/]/.test(file.originalName) || file.originalName.includes("..")) {
    return { valid: false, reason: "Invalid file name" };
  }

  return { valid: true };
}
