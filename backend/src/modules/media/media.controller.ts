import type { Response } from "express";
import { AppError } from "../../middleware/errorHandler";
import type { AuthenticatedRequest } from "../../middleware/requireAuth";
import type { MediaService } from "./media.service";
import { uploadQuerySchema, type UploadQuery } from "./media.validation";

/** Kinds a browser may render inline; everything else is forced to download. */
const INLINE_KINDS = new Set(["image", "video", "audio"]);

function contentDisposition(kind: string, fileName: string): string {
  const disposition = INLINE_KINDS.has(kind) ? "inline" : "attachment";
  // ASCII fallback for old clients plus RFC 5987 UTF-8 form. The name is
  // already sanitized at upload time; quotes/backslashes are stripped again
  // defensively since this goes into a header.
  const asciiName = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  upload = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (!Buffer.isBuffer(req.body)) {
      throw new AppError("Send the file as the raw request body (Content-Type: application/octet-stream)", 400);
    }
    // Re-parse to apply defaults (validateQuery only checks; see middleware/validate.ts).
    const { purpose, conversationId, filename, mimeType } = uploadQuerySchema.parse(req.query) as UploadQuery;

    const attachment = await this.mediaService.upload({
      uploaderId: req.user!.userId,
      purpose,
      conversationId,
      originalName: filename,
      declaredMimeType: mimeType,
      data: req.body,
    });
    res.status(201).json({ attachment });
  };

  getMetadata = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const attachment = await this.mediaService.getMetadata(req.params.attachmentId as string, req.user!.userId);
    res.status(200).json({ attachment });
  };

  getContent = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { attachment, data } = await this.mediaService.getContent(req.params.attachmentId as string, req.user!.userId);
    res.setHeader("Content-Type", attachment.mimeType);
    res.setHeader("Content-Length", String(data.length));
    res.setHeader("Content-Disposition", contentDisposition(attachment.kind, attachment.originalFilename));
    res.setHeader("Cache-Control", "private, no-store");
    // Belt-and-braces: even if a stored file were somehow script-capable, it can't run as a page from our origin.
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.status(200).send(data);
  };

  remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await this.mediaService.delete(req.params.attachmentId as string, req.user!.userId);
    res.status(204).send();
  };
}
