import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { requireConversationMember, type MembershipChecker } from "../../middleware/requireConversationMember";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { MessagesController } from "./messages.controller";
import type { MessagesService } from "./messages.service";
import {
  editMessageSchema,
  listMessagesQuerySchema,
  markReadSchema,
  messageParamsSchema,
  sendMessageSchema,
} from "./messages.validation";

export function createMessagesRouter(messagesService: MessagesService, membershipChecker: MembershipChecker): Router {
  const controller = new MessagesController(messagesService);
  const router = Router();
  const guardMembership = asyncHandler(requireConversationMember(membershipChecker));

  router.get(
    "/:conversationId",
    requireAuth,
    guardMembership,
    validateQuery(listMessagesQuerySchema),
    asyncHandler(controller.list)
  );
  router.post(
    "/:conversationId",
    requireAuth,
    guardMembership,
    validateBody(sendMessageSchema),
    asyncHandler(controller.send)
  );
  router.post(
    "/:conversationId/read",
    requireAuth,
    guardMembership,
    validateBody(markReadSchema),
    asyncHandler(controller.markRead)
  );
  router.patch(
    "/:conversationId/:messageId",
    requireAuth,
    validateParams(messageParamsSchema),
    guardMembership,
    validateBody(editMessageSchema),
    asyncHandler(controller.edit)
  );
  router.delete(
    "/:conversationId/:messageId",
    requireAuth,
    validateParams(messageParamsSchema),
    guardMembership,
    asyncHandler(controller.remove)
  );

  return router;
}
