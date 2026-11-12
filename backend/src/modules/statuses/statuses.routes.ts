import { Router, type RequestHandler } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody, validateParams } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { StatusesController } from "./statuses.controller";
import type { AuthenticatedRequest } from "../../middleware/requireAuth";
import type { StatusRepliesService } from "./status-replies.service";
import type { StatusesService } from "./statuses.service";
import { createStatusSchema, statusParamsSchema, statusPrivacySchema, statusReplySchema } from "./statuses.validation";

/** All privacy/ownership checks live in StatusesService — see the rules there and in StatusesRepository. */
export function createStatusesRouter(
  statusesService: StatusesService,
  createLimiter: RequestHandler = (_req, _res, next) => next(),
  replies?: { service: StatusRepliesService; limiter: RequestHandler }
): Router {
  const controller = new StatusesController(statusesService);
  const router = Router();
  const statusParams = validateParams(statusParamsSchema);

  router.get("/", requireAuth, asyncHandler(controller.list));
  router.post("/", requireAuth, createLimiter, validateBody(createStatusSchema), asyncHandler(controller.create));
  // Registered before /:statusId so "privacy" is never parsed as a status ID.
  router.get("/privacy", requireAuth, asyncHandler(controller.getPrivacy));
  router.put("/privacy", requireAuth, validateBody(statusPrivacySchema), asyncHandler(controller.updatePrivacy));
  router.get("/:statusId", requireAuth, statusParams, asyncHandler(controller.get));
  router.post("/:statusId/view", requireAuth, statusParams, asyncHandler(controller.markViewed));
  if (replies) {
    // Sent as a direct message to the status owner (rate-limited like any other message).
    router.post(
      "/:statusId/reply",
      requireAuth,
      replies.limiter,
      statusParams,
      validateBody(statusReplySchema),
      asyncHandler(async (req: AuthenticatedRequest, res) => {
        const result = await replies.service.reply(req.params.statusId as string, req.user!.userId, (req.body as { body: string }).body);
        res.status(201).json(result);
      })
    );
  }
  router.get("/:statusId/viewers", requireAuth, statusParams, asyncHandler(controller.listViewers));
  router.delete("/:statusId", requireAuth, statusParams, asyncHandler(controller.remove));

  return router;
}
