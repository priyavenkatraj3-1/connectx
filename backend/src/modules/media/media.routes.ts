import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { notImplemented } from "../../utils/notImplemented";

export const mediaRouter = Router();

mediaRouter.post("/", requireAuth, notImplemented("Upload attachment"));
mediaRouter.get("/:attachmentId", requireAuth, notImplemented("Get attachment"));
mediaRouter.delete("/:attachmentId", requireAuth, notImplemented("Delete attachment"));
