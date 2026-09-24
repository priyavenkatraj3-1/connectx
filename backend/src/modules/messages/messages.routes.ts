import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { notImplemented } from "../../utils/notImplemented";

export const messagesRouter = Router();

messagesRouter.get("/:conversationId", requireAuth, notImplemented("List messages"));
messagesRouter.post("/:conversationId", requireAuth, notImplemented("Send message"));
messagesRouter.delete("/:messageId", requireAuth, notImplemented("Delete message"));
messagesRouter.post("/:messageId/reactions", requireAuth, notImplemented("Add reaction"));
