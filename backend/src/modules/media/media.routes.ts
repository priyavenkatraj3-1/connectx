import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { AppError } from "../../middleware/errorHandler";
import { requireAuth } from "../../middleware/requireAuth";
import { validateParams, validateQuery } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { MediaController } from "./media.controller";
import type { MediaService } from "./media.service";
import { attachmentParamsSchema, uploadQuerySchema } from "./media.validation";

/**
 * Uploads are sent as the raw request body (no multipart parsing, so no
 * extra dependency): POST /media?conversationId=…&filename=…[&mimeType=…]
 * with Content-Type: application/octet-stream.
 */
export function createMediaRouter(
  mediaService: MediaService,
  maxUploadBytes: number,
  uploadLimiter: RequestHandler = (_req, _res, next) => next()
): Router {
  const controller = new MediaController(mediaService);
  const router = Router();
  const attachmentParams = validateParams(attachmentParamsSchema);

  // Accept any content type for the raw body; the file's real type is determined by validation, not by this header.
  const rawBody = express.raw({ type: () => true, limit: maxUploadBytes });

  // body-parser reports oversized bodies as a generic error; turn it into a clean 413.
  const handleBodyErrors = (err: unknown, _req: Request, _res: Response, next: NextFunction): void => {
    if (err && typeof err === "object" && "type" in err && (err as { type: string }).type === "entity.too.large") {
      next(new AppError(`File exceeds the maximum size of ${Math.floor(maxUploadBytes / (1024 * 1024))}MB`, 413));
      return;
    }
    next(err);
  };

  router.post(
    "/",
    requireAuth,
    uploadLimiter,
    validateQuery(uploadQuerySchema),
    rawBody,
    handleBodyErrors,
    asyncHandler(controller.upload)
  );
  router.get("/:attachmentId", requireAuth, attachmentParams, asyncHandler(controller.getMetadata));
  router.get("/:attachmentId/content", requireAuth, attachmentParams, asyncHandler(controller.getContent));
  router.delete("/:attachmentId", requireAuth, attachmentParams, asyncHandler(controller.remove));

  return router;
}
