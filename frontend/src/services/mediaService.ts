import type { AttachmentDTO, AttachmentKind } from "../types/media";
import { API_BASE_URL, ApiError, apiRequest, buildQueryString } from "./apiClient";

/**
 * Client-side mirror of the backend allow-list (backend/src/modules/media/
 * file-validation.ts). It only exists to give instant "unsupported file"
 * feedback — the server re-validates every upload (extension + file
 * contents) and is the only authority.
 */
const KIND_BY_EXTENSION: Record<string, AttachmentKind> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  mp3: "audio",
  m4a: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  wav: "audio",
  weba: "audio",
  pdf: "document",
  txt: "document",
  csv: "document",
  docx: "document",
  xlsx: "document",
  pptx: "document",
  zip: "file",
};

export const ACCEPTED_FILE_EXTENSIONS = Object.keys(KIND_BY_EXTENSION).map((ext) => `.${ext}`);

export const MAX_UPLOAD_BYTES = Number(import.meta.env.VITE_MAX_UPLOAD_MB ?? 25) * 1024 * 1024;

export function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

/** Returns a user-facing reason if the file will certainly be rejected, else null. */
export function precheckFile(file: File): string | null {
  const extension = getExtension(file.name);
  if (!KIND_BY_EXTENSION[extension]) {
    return extension ? `".${extension}" files aren't supported` : "Files need an extension (e.g. .pdf, .jpg)";
  }
  if (file.size === 0) return "That file is empty";
  if (file.size > MAX_UPLOAD_BYTES) {
    return `Files can be at most ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB`;
  }
  return null;
}

export function guessKind(fileName: string): AttachmentKind {
  return KIND_BY_EXTENSION[getExtension(fileName)] ?? "file";
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface UploadHandle {
  promise: Promise<AttachmentDTO>;
  abort(): void;
}

/** Status media is limited to photos and videos (the server enforces the same rule). */
export function precheckStatusFile(file: File): string | null {
  const generic = precheckFile(file);
  if (generic) return generic;
  const kind = guessKind(file.name);
  return kind === "image" || kind === "video" ? null : "A status can only be a photo or a video";
}

function uploadRaw(
  accessToken: string,
  query: Record<string, string | undefined>,
  file: File,
  onProgress?: (fraction: number) => void
): UploadHandle {
  const xhr = new XMLHttpRequest();

  const promise = new Promise<AttachmentDTO>((resolve, reject) => {
    xhr.open("POST", `${API_BASE_URL}/media${buildQueryString(query)}`);
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let data: { attachment?: AttachmentDTO; error?: { message?: string } } = {};
      try {
        data = JSON.parse(xhr.responseText) as typeof data;
      } catch {
        // Non-JSON error body; fall through to the generic message.
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.attachment) {
        resolve(data.attachment);
      } else {
        reject(new ApiError(data.error?.message ?? "Upload failed. Please try again.", xhr.status));
      }
    };
    xhr.onerror = () => reject(new ApiError("Upload failed — check your connection and try again.", 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelled", 0));
    xhr.send(file);
  });

  return { promise, abort: () => xhr.abort() };
}

export const mediaService = {
  /**
   * Uploads a file as the raw request body. Uses XMLHttpRequest (not
   * fetch) because only XHR reports upload progress. The promise rejects
   * with an ApiError carrying the server's message on any non-2xx response
   * — callers must never treat a rejected upload as attached.
   */
  upload(
    accessToken: string,
    conversationId: string,
    file: File,
    onProgress?: (fraction: number) => void
  ): UploadHandle {
    return uploadRaw(accessToken, { conversationId, filename: file.name, mimeType: file.type || undefined }, file, onProgress);
  },

  /**
   * Uploads status media (Phase 4) through the same validated pipeline,
   * with `purpose=status` instead of a conversation. The result can only
   * be used by publishing it with statusService.create.
   */
  uploadStatusMedia(accessToken: string, file: File, onProgress?: (fraction: number) => void): UploadHandle {
    return uploadRaw(accessToken, { purpose: "status", filename: file.name, mimeType: file.type || undefined }, file, onProgress);
  },

  /** Fetches attachment bytes with the access token (an <img src> can't send an Authorization header). */
  async fetchContent(accessToken: string, attachmentId: string): Promise<Blob> {
    const response = await fetch(`${API_BASE_URL}/media/${attachmentId}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new ApiError(data?.error?.message ?? "Couldn't load this file", response.status);
    }
    return response.blob();
  },

  /** Deletes an upload that was never sent (e.g. the user removed it from the composer). */
  remove(accessToken: string, attachmentId: string): Promise<void> {
    return apiRequest<void>(`/media/${attachmentId}`, { method: "DELETE", accessToken });
  },
};
