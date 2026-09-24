import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { notImplemented } from "../../utils/notImplemented";

/**
 * Route shapes for conversation management. Handlers are intentionally
 * unimplemented placeholders in Phase 1 — see conversation.interface.ts for
 * the service contract that will back these routes.
 */
export const conversationsRouter = Router();

conversationsRouter.get("/", requireAuth, notImplemented("List conversations"));
conversationsRouter.post("/", requireAuth, notImplemented("Create conversation"));
conversationsRouter.get("/:conversationId", requireAuth, notImplemented("Get conversation"));
