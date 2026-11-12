import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { AIController, type AIServices } from "./ai.controller";
import {
  actionParamsSchema,
  actionUpdateSchema,
  askSchema,
  attachmentParamsSchema,
  conversationParamsSchema,
  decisionSummarySchema,
  extractActionsSchema,
  listActionsQuerySchema,
  memoryCreateSchema,
  memoryParamsSchema,
  messageParamsSchema,
  safetyFeedbackSchema,
  safetyScanSchema,
  settingsUpdateSchema,
  transcribeSchema,
  translateSchema,
  voiceTranslateSchema,
} from "./ai.validation";

/**
 * Phase 5 AI API. Every route: requireAuth → param/body validation →
 * controller → service, where consent, provider configuration,
 * conversation/message/attachment authorization and ownership are enforced
 * (never only in the frontend). See docs/api.md and docs/ai.md.
 */
export function createAIRouter(services: AIServices): Router {
  const controller = new AIController(services);
  const router = Router();
  router.use(requireAuth);

  router.get("/settings", asyncHandler(controller.getSettings));
  router.patch("/settings", validateBody(settingsUpdateSchema), asyncHandler(controller.updateSettings));

  router.get("/exclusions", asyncHandler(controller.listExclusions));
  router.put("/exclusions/:conversationId", validateParams(conversationParamsSchema), asyncHandler(controller.addExclusion));
  router.delete("/exclusions/:conversationId", validateParams(conversationParamsSchema), asyncHandler(controller.removeExclusion));

  router.post("/ask", validateBody(askSchema), asyncHandler(controller.ask));

  router.get("/memories", asyncHandler(controller.listMemories));
  router.post("/memories", validateBody(memoryCreateSchema), asyncHandler(controller.createMemory));
  router.delete("/memories", asyncHandler(controller.clearMemories));
  router.delete("/memories/:memoryId", validateParams(memoryParamsSchema), asyncHandler(controller.deleteMemory));

  router.post(
    "/conversations/:conversationId/actions/extract",
    validateParams(conversationParamsSchema),
    validateBody(extractActionsSchema),
    asyncHandler(controller.extractActions)
  );
  router.get("/actions", validateQuery(listActionsQuerySchema), asyncHandler(controller.listActions));
  router.patch(
    "/actions/:actionId",
    validateParams(actionParamsSchema),
    validateBody(actionUpdateSchema),
    asyncHandler(controller.updateAction)
  );
  router.post("/actions/:actionId/confirm", validateParams(actionParamsSchema), asyncHandler(controller.confirmAction));
  router.post("/actions/:actionId/dismiss", validateParams(actionParamsSchema), asyncHandler(controller.dismissAction));

  router.post(
    "/conversations/:conversationId/decision-summary",
    validateParams(conversationParamsSchema),
    validateBody(decisionSummarySchema),
    asyncHandler(controller.decisionSummary)
  );

  router.post(
    "/messages/:messageId/translate",
    validateParams(messageParamsSchema),
    validateBody(translateSchema),
    asyncHandler(controller.translate)
  );

  router.post(
    "/conversations/:conversationId/safety-scan",
    validateParams(conversationParamsSchema),
    validateBody(safetyScanSchema),
    asyncHandler(controller.safetyScan)
  );
  router.post("/messages/:messageId/scam-check", validateParams(messageParamsSchema), asyncHandler(controller.scamCheck));
  router.post(
    "/messages/:messageId/safety-feedback",
    validateParams(messageParamsSchema),
    validateBody(safetyFeedbackSchema),
    asyncHandler(controller.safetyFeedback)
  );

  router.get("/voice/:attachmentId", validateParams(attachmentParamsSchema), asyncHandler(controller.getVoice));
  router.post(
    "/voice/:attachmentId/transcribe",
    validateParams(attachmentParamsSchema),
    validateBody(transcribeSchema),
    asyncHandler(controller.transcribe)
  );
  router.post("/voice/:attachmentId/analyze", validateParams(attachmentParamsSchema), asyncHandler(controller.analyzeVoice));
  router.get(
    "/voice/:attachmentId/translations",
    validateParams(attachmentParamsSchema),
    asyncHandler(controller.listVoiceTranslations)
  );
  router.post(
    "/voice/:attachmentId/translate",
    validateParams(attachmentParamsSchema),
    validateBody(voiceTranslateSchema),
    asyncHandler(controller.translateVoice)
  );

  return router;
}
