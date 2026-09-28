import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody, validateParams } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { StatusesController } from "./statuses.controller";
import type { StatusesService } from "./statuses.service";
import { createStatusSchema, statusParamsSchema, statusPrivacySchema } from "./statuses.validation";

/** All privacy/ownership checks live in StatusesService — see the rules there and in StatusesRepository. */
export function createStatusesRouter(statusesService: StatusesService): Router {
  const controller = new StatusesController(statusesService);
  const router = Router();
  const statusParams = validateParams(statusParamsSchema);

  router.get("/", requireAuth, asyncHandler(controller.list));
  router.post("/", requireAuth, validateBody(createStatusSchema), asyncHandler(controller.create));
  // Registered before /:statusId so "privacy" is never parsed as a status ID.
  router.get("/privacy", requireAuth, asyncHandler(controller.getPrivacy));
  router.put("/privacy", requireAuth, validateBody(statusPrivacySchema), asyncHandler(controller.updatePrivacy));
  router.get("/:statusId", requireAuth, statusParams, asyncHandler(controller.get));
  router.post("/:statusId/view", requireAuth, statusParams, asyncHandler(controller.markViewed));
  router.get("/:statusId/viewers", requireAuth, statusParams, asyncHandler(controller.listViewers));
  router.delete("/:statusId", requireAuth, statusParams, asyncHandler(controller.remove));

  return router;
}
