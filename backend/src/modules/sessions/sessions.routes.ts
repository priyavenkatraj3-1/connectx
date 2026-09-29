import { Router, type Response } from "express";
import { z } from "zod";
import { AppError } from "../../middleware/errorHandler";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/requireAuth";
import { validateBody, validateParams } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import type { SessionsService } from "./sessions.service";

const sessionParams = z.object({ sessionId: z.string().uuid("sessionId must be a valid ID") });
const renameSchema = z.object({ deviceName: z.string().trim().min(1, "Device name is required").max(120) }).strict();

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const handle = (fn: Handler) => asyncHandler(fn as Parameters<typeof asyncHandler>[0]);

/**
 * /api/v1/sessions — the signed-in devices of the current user. Users can
 * only see and revoke their own sessions; no token or token hash is ever
 * returned.
 */
export function createSessionsRouter(sessions: SessionsService): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    "/",
    handle(async (req, res) => {
      res.json({ sessions: await sessions.list(req.user!.userId, req.user!.sessionId) });
    })
  );
  router.patch(
    "/:sessionId",
    validateParams(sessionParams),
    validateBody(renameSchema),
    handle(async (req, res) => {
      await sessions.rename(req.user!.userId, req.params.sessionId as string, (req.body as z.infer<typeof renameSchema>).deviceName);
      res.json({ sessions: await sessions.list(req.user!.userId, req.user!.sessionId) });
    })
  );
  router.delete(
    "/:sessionId",
    validateParams(sessionParams),
    handle(async (req, res) => {
      await sessions.revoke(req.user!.userId, req.params.sessionId as string);
      res.status(204).send();
    })
  );
  router.post(
    "/revoke-others",
    handle(async (req, res) => {
      if (!req.user!.sessionId) throw new AppError("Current session unknown", 400);
      const revoked = await sessions.revokeOthers(req.user!.userId, req.user!.sessionId);
      res.json({ revoked });
    })
  );
  return router;
}
