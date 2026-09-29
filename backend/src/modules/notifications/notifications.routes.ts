import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/requireAuth";
import { validateParams, validateQuery } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import type { NotificationsService } from "./notifications.service";

const listQuery = z.object({ unreadOnly: z.enum(["true", "false"]).optional() });
const idParams = validateParams(z.object({ notificationId: z.string().uuid("notificationId must be a valid ID") }));

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const handle = (fn: Handler) => asyncHandler(fn as Parameters<typeof asyncHandler>[0]);
const userId = (req: AuthenticatedRequest) => req.user!.userId;

/** /api/v1/notifications — the in-app notification center. Users only ever see their own. */
export function createNotificationsRouter(notifications: NotificationsService): Router {
  const router = Router();
  router.use(requireAuth);
  router.get(
    "/",
    validateQuery(listQuery),
    handle(async (req, res) => {
      const { unreadOnly } = listQuery.parse(req.query);
      const [items, unreadCount] = await Promise.all([
        notifications.list(userId(req), { unreadOnly: unreadOnly === "true" }),
        notifications.unreadCount(userId(req)),
      ]);
      res.json({ notifications: items, unreadCount });
    })
  );
  router.get("/unread-count", handle(async (req, res) => void res.json({ unreadCount: await notifications.unreadCount(userId(req)) })));
  router.post(
    "/read-all",
    handle(async (req, res) => {
      await notifications.markAllRead(userId(req));
      res.status(204).send();
    })
  );
  router.post(
    "/:notificationId/read",
    idParams,
    handle(async (req, res) => {
      await notifications.markRead(userId(req), req.params.notificationId as string);
      res.status(204).send();
    })
  );
  router.delete(
    "/:notificationId",
    idParams,
    handle(async (req, res) => {
      await notifications.remove(userId(req), req.params.notificationId as string);
      res.status(204).send();
    })
  );
  return router;
}
