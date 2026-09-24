import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { notImplemented } from "../../utils/notImplemented";

/**
 * Route shapes for every Phase-1-scaffolded AI feature. Each maps to a
 * service interface in ./interfaces — no route here does real inference
 * yet (see providers/none.provider.ts). Routes are protected because even
 * a placeholder response should not reveal which endpoints exist to
 * unauthenticated callers.
 */
export const aiRouter = Router();

aiRouter.post("/ask", requireAuth, notImplemented("Ask Your Chats"));
aiRouter.get("/memories", requireAuth, notImplemented("List AI memories"));
aiRouter.delete("/memories/:memoryId", requireAuth, notImplemented("Delete AI memory"));
aiRouter.post("/voice/:attachmentId/analyze", requireAuth, notImplemented("Voice intelligence"));
aiRouter.post("/conversations/:conversationId/summarize", requireAuth, notImplemented("Group decision summary"));
aiRouter.post("/spam-shield/analyze", requireAuth, notImplemented("Spam/scam analysis"));
aiRouter.post("/conversations/:conversationId/actions", requireAuth, notImplemented("Smart action extraction"));
aiRouter.post("/translate", requireAuth, notImplemented("Translation"));
