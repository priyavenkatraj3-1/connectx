import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { notImplemented } from "../../utils/notImplemented";

export const notificationsRouter = Router();

notificationsRouter.get("/", requireAuth, notImplemented("List notifications"));
notificationsRouter.post("/:notificationId/read", requireAuth, notImplemented("Mark notification read"));
