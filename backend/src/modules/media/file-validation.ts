import { env } from "../../config/env";
import type { AttachmentKind } from "./media.types";

/**
 * Upload validation for the media foundation.
 *
 * The client-supplied MIME type is never trusted on its own: every upload
 * must (1) have an allow-listed extension, and (2) have file contents whose
 * leading "magic bytes" match that extension. The MIME type we store is the
 * canonical one for the extension, not whatever the client declared.
 *
 * This is format validation, not malware scanning — a well-formed PDF or
 * Office file can still carry malicious content. See docs/security.md.
 */

interface FileTypeRule {
  mimeType: string;
  kind: AttachmentKind;
  /** Returns true if the file's leading bytes are consistent with this type. */
  matches(data: Buffer): boolean;
}

function startsWith(data: Buffer, bytes: number[], offset = 0): boolean {
  if (data.length < offset + bytes.length) return false;
  return bytes.every((byte, i) => data[offset + i] === byte);
}

function ascii(data: Buffer, offset: number, text: string): boolean {
  return startsWith(
    data,
    [...text].map((c) => c.charCodeAt(0)),
    offset
  );
}

/** ISO base media file (MP4/MOV/M4A): bytes 4..8 are "ftyp". */
const isIsoBmff = (data: Buffer) => ascii(data, 4, "ftyp");
/** EBML header used by WebM/Matroska. */
const isEbml = (data: Buffer) => startsWith(data, [0x1a, 0x45, 0xdf, 0xa3]);
const isOgg = (data: Buffer) => ascii(data, 0, "OggS");
const isZip = (data: Buffer) => startsWith(data, [0x50, 0x4b, 0x03, 0x04]);
const isMp3 = (data: Buffer) =>
  ascii(data, 0, "ID3") || (data.length >= 2 && data[0] === 0xff && ((data[1] ?? 0) & 0xe0) === 0xe0);

/**
 * Plain-text check: no NUL bytes in the first 8KB and decodes as UTF-8.
 * Good enough to stop a binary executable being uploaded as ".txt".
 */
function isPlainText(data: Buffer): boolean {
  const sample = data.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    // A multi-byte character may be cut at the 8KB boundary; retry without the last 3 bytes.
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 3)));
      return sample.length > 3;
    } catch {
      return false;
    }
  }
}

/**
 * Extension allow-list. Anything not listed here is rejected — notably
 * SVG and HTML (script-capable, XSS risk when served back), executables,
 * and scripts.
 */
export const FILE_TYPE_RULES: Readonly<Record<string, FileTypeRule>> = {
  // Images
  jpg: { mimeType: "image/jpeg", kind: "image", matches: (d) => startsWith(d, [0xff, 0xd8, 0xff]) },
  jpeg: { mimeType: "image/jpeg", kind: "image", matches: (d) => startsWith(d, [0xff, 0xd8, 0xff]) },
  png: { mimeType: "image/png", kind: "image", matches: (d) => startsWith(d, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  gif: { mimeType: "image/gif", kind: "image", matches: (d) => ascii(d, 0, "GIF87a") || ascii(d, 0, "GIF89a") },
  webp: { mimeType: "image/webp", kind: "image", matches: (d) => ascii(d, 0, "RIFF") && ascii(d, 8, "WEBP") },

  // Video
  mp4: { mimeType: "video/mp4", kind: "video", matches: isIsoBmff },
  mov: { mimeType: "video/quicktime", kind: "video", matches: isIsoBmff },
  webm: { mimeType: "video/webm", kind: "video", matches: isEbml },

  // Audio / voice
  mp3: { mimeType: "audio/mpeg", kind: "audio", matches: isMp3 },
  m4a: { mimeType: "audio/mp4", kind: "audio", matches: isIsoBmff },
  ogg: { mimeType: "audio/ogg", kind: "audio", matches: isOgg },
  oga: { mimeType: "audio/ogg", kind: "audio", matches: isOgg },
  opus: { mimeType: "audio/ogg", kind: "audio", matches: isOgg },
  wav: { mimeType: "audio/wav", kind: "audio", matches: (d) => ascii(d, 0, "RIFF") && ascii(d, 8, "WAVE") },
  weba: { mimeType: "audio/webm", kind: "audio", matches: isEbml },

  // Documents
  pdf: { mimeType: "application/pdf", kind: "document", matches: (d) => ascii(d, 0, "%PDF-") },
  txt: { mimeType: "text/plain", kind: "document", matches: isPlainText },
  csv: { mimeType: "text/csv", kind: "document", matches: isPlainText },
  docx: {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    kind: "document",
    matches: isZip,
  },
  xlsx: {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: "document",
    matches: isZip,
  },
  pptx: {
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    kind: "document",
    matches: isZip,
  },

  // Generic files
  zip: { mimeType: "application/zip", kind: "file", matches: isZip },
};

export const ALLOWED_EXTENSIONS = Object.keys(FILE_TYPE_RULES);

const MAX_FILENAME_LENGTH = 120;

/**
 * Reduces a client-supplied filename to a safe display name: strips any
 * directory components (both / and \), control characters and anything
 * outside a conservative character set, and collapses leading dots so the
 * result can never be "..", a hidden file, or a path. The stored file on
 * disk never uses this name — storage keys are server-generated UUIDs —
 * so this only protects the name we echo back in API responses and
 * Content-Disposition headers.
 */
export function sanitizeFilename(rawName: string): string {
  const baseName = rawName.split(/[\\/]/).pop() ?? "";
  let cleaned = baseName
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N} ._()-]/gu, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");

  if (cleaned.length > MAX_FILENAME_LENGTH) {
    const dot = cleaned.lastIndexOf(".");
    const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
    cleaned = cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
  }

  return cleaned || "file";
}

export function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

export type FileValidationResult =
  | { ok: true; fileName: string; mimeType: string; kind: AttachmentKind; sizeBytes: number }
  | { ok: false; statusCode: 400 | 413 | 415; reason: string };

export interface FileValidationInput {
  originalName: string;
  /** Whatever the client claimed the type was. Used only as a consistency check, never as the stored type. */
  declaredMimeType?: string;
  data: Buffer;
}

/** Declared types that carry no information and are always acceptable. */
const GENERIC_DECLARED_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

export function validateUploadedFile(input: FileValidationInput, maxBytes = env.maxUploadSizeMb * 1024 * 1024): FileValidationResult {
  const sizeBytes = input.data.length;
  if (sizeBytes === 0) {
    return { ok: false, statusCode: 400, reason: "File is empty" };
  }
  if (sizeBytes > maxBytes) {
    return { ok: false, statusCode: 413, reason: `File exceeds the maximum size of ${Math.floor(maxBytes / (1024 * 1024))}MB` };
  }

  const fileName = sanitizeFilename(input.originalName);
  const extension = getExtension(fileName);
  const rule = FILE_TYPE_RULES[extension];
  if (!rule) {
    return {
      ok: false,
      statusCode: 415,
      reason: extension ? `File type ".${extension}" is not supported` : "File must have a supported extension",
    };
  }

  if (!rule.matches(input.data)) {
    return { ok: false, statusCode: 415, reason: `File contents do not match the ".${extension}" file type` };
  }

  const declared = (input.declaredMimeType ?? "").split(";")[0]!.trim().toLowerCase();
  if (!GENERIC_DECLARED_TYPES.has(declared)) {
    // The declared type must at least agree on the top-level family (e.g.
    // "image/*" for a .png). An upload declared as text/html but named
    // ".png" is suspicious and rejected outright.
    const declaredFamily = declared.split("/")[0];
    const ruleFamily = rule.mimeType.split("/")[0];
    const compatible =
      declared === rule.mimeType ||
      declaredFamily === ruleFamily ||
      // Browsers often report .webm audio recordings as video/webm and vice versa.
      (extension === "webm" && declared.startsWith("audio/")) ||
      (extension === "weba" && declared.startsWith("video/"));
    if (!compatible) {
      return { ok: false, statusCode: 415, reason: `Declared type "${declared}" does not match the ".${extension}" file type` };
    }
  }

  return { ok: true, fileName, mimeType: rule.mimeType, kind: rule.kind, sizeBytes };
}
