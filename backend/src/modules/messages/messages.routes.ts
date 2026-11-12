import { Router, type RequestHandler } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { requireConversationMember, type MembershipChecker } from "../../middleware/requireConversationMember";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { MessagesController } from "./messages.controller";
import type { MessagesService } from "./messages.service";
import {
  conversationParamsSchema,
  editMessageSchema,
  listMessagesQuerySchema,
  markReadSchema,
  messageParamsSchema,
  reactionSchema,
  searchMessagesQuerySchema,
  sendMessageSchema,
} from "./messages.validation";

/** Default when no limiter is supplied (e.g. unit tests building a bare router). */
const passThrough: RequestHandler = (_req, _res, next) => next();

export function createMessagesRouter(
  messagesService: MessagesService,
  membershipChecker: MembershipChecker,
  sendLimiter: RequestHandler = passThrough,
  searchLimiter: RequestHandler = passThrough
): Router {
  const controller = new MessagesController(messagesService);
  const router = Router();
  const guardMembership = asyncHandler(requireConversationMember(membershipChecker));
  const conversationParams = validateParams(conversationParamsSchema);

  router.get(
    "/:conversationId",
    requireAuth,
    conversationParams,
    guardMembership,
    validateQuery(listMessagesQuerySchema),
    asyncHandler(controller.list)
  );
  router.get(
    "/:conversationId/search",
    requireAuth,
    searchLimiter,
    conversationParams,
    guardMembership,
    validateQuery(searchMessagesQuerySchema),
    asyncHandler(controller.search)
  );
  router.post(
    "/:conversationId",
    requireAuth,
    sendLimiter,
    conversationParams,
    guardMembership,
    validateBody(sendMessageSchema),
    asyncHandler(controller.send)
  );
  router.post(
    "/:conversationId/read",
    requireAuth,
    conversationParams,
    guardMembership,
    validateBody(markReadSchema),
    asyncHandler(controller.markRead)
  );
  // Reactions: one per person; PUT sets/replaces it, DELETE removes it. Rate-limited like sending.
  router.put(
    "/:conversationId/:messageId/reaction",
    requireAuth,
    sendLimiter,
    validateParams(messageParamsSchema),
    guardMembership,
    validateBody(reactionSchema),
    asyncHandler(controller.react)
  );
  router.delete(
    "/:conversationId/:messageId/reaction",
    requireAuth,
    validateParams(messageParamsSchema),
    guardMembership,
    asyncHandler(controller.unreact)
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
