import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { requireConversationMember } from "../../middleware/requireConversationMember";
import { validateBody, validateParams } from "../../middleware/validate";
import { conversationParamsSchema } from "../messages/messages.validation";
import { asyncHandler } from "../../utils/asyncHandler";
import { ConversationsController } from "./conversations.controller";
import type { ConversationsService } from "./conversations.service";
import { createDirectConversationSchema } from "./conversations.validation";

export function createConversationsRouter(conversationsService: ConversationsService): Router {
  const controller = new ConversationsController(conversationsService);
  const router = Router();

  router.get("/", requireAuth, asyncHandler(controller.list));
  router.post(
    "/direct",
    requireAuth,
    validateBody(createDirectConversationSchema),
    asyncHandler(controller.createDirect)
  );
  router.get(
    "/:conversationId",
    requireAuth,
    validateParams(conversationParamsSchema),
    asyncHandler(requireConversationMember(conversationsService)),
    asyncHandler(controller.getById)
  );

  return router;
}
