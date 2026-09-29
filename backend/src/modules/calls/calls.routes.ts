import { Router, type RequestHandler } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { CallsController } from "./calls.controller";
import type { CallsService } from "./calls.service";
import { activeCallQuerySchema, callHistoryQuerySchema, callParamsSchema, startCallSchema } from "./calls.validation";

/**
 * REST side of calling: start a call, look calls up, history, and a
 * hang-up fallback. Everything real-time after the start (accept, decline,
 * SDP/ICE signaling, …) goes over the WebSocket — see realtime/events.ts.
 * All authorization lives in CallsService.
 */
export function createCallsRouter(callsService: CallsService, startLimiter: RequestHandler = (_req, _res, next) => next()): Router {
  const controller = new CallsController(callsService);
  const router = Router();
  const callParams = validateParams(callParamsSchema);

  router.get("/ice-servers", requireAuth, asyncHandler(controller.iceServers));
  router.get("/active", requireAuth, validateQuery(activeCallQuerySchema), asyncHandler(controller.active));
  router.get("/", requireAuth, validateQuery(callHistoryQuerySchema), asyncHandler(controller.history));
  router.post("/", requireAuth, startLimiter, validateBody(startCallSchema), asyncHandler(controller.start));
  router.get("/:callId", requireAuth, callParams, asyncHandler(controller.get));
  router.post("/:callId/end", requireAuth, callParams, asyncHandler(controller.end));

  return router;
}
