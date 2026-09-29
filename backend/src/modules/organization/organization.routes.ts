import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/requireAuth";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import type { ConversationAccessService } from "../collaboration/conversation-access";
import type { PreferencesService } from "../preferences/preferences.service";
import type { MessageOrganizationService } from "./organization.service";

const uuid = (field: string) => z.string().uuid(`${field} must be a valid ID`);

const conversationQuery = z.object({ conversationId: uuid("conversationId") });
const messageParams = z.object({ messageId: uuid("messageId") });
const conversationParams = z.object({ conversationId: uuid("conversationId") });
const pinSchema = z.object({ messageId: uuid("messageId") }).strict();

export const savedQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  label: z.string().trim().max(40).optional(),
  starred: z.enum(["true", "false"]).optional(),
  conversationId: uuid("conversationId").optional(),
});

export const saveSchema = z
  .object({
    label: z.string().trim().min(1).max(40).nullable().optional(),
    starred: z.boolean().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export const preferencesSchema = z
  .object({
    timezone: z.string().trim().min(1).max(64).nullable().optional(),
    productivityMode: z.boolean().optional(),
    notifyMentions: z.boolean().optional(),
    notifyTaskDue: z.boolean().optional(),
    notifyReminders: z.boolean().optional(),
    notifyScheduledMessages: z.boolean().optional(),
    notifyAssignments: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const handle = (fn: Handler) => asyncHandler(fn as Parameters<typeof asyncHandler>[0]);
const userId = (req: AuthenticatedRequest) => req.user!.userId;

/** /api/v1/pins — conversation-wide pinned messages. */
export function createPinsRouter(organization: MessageOrganizationService): Router {
  const router = Router();
  router.use(requireAuth);
  router.get(
    "/",
    validateQuery(conversationQuery),
    handle(async (req, res) => {
      const { conversationId } = conversationQuery.parse(req.query);
      res.json({ pins: await organization.listPins(conversationId, userId(req)) });
    })
  );
  router.post(
    "/",
    validateBody(pinSchema),
    handle(async (req, res) => void res.status(201).json({ pin: await organization.pin(req.body.messageId as string, userId(req)) }))
  );
  router.delete(
    "/:messageId",
    validateParams(messageParams),
    handle(async (req, res) => {
      await organization.unpin(req.params.messageId as string, userId(req));
      res.status(204).send();
    })
  );
  return router;
}

/** /api/v1/saved — private saved/starred messages. */
export function createSavedRouter(organization: MessageOrganizationService): Router {
  const router = Router();
  router.use(requireAuth);
  router.get(
    "/",
    validateQuery(savedQuerySchema),
    handle(async (req, res) => {
      const { starred, ...rest } = savedQuerySchema.parse(req.query);
      res.json({ saved: await organization.listSaved(userId(req), { ...rest, starred: starred === undefined ? undefined : starred === "true" }) });
    })
  );
  router.get("/labels", handle(async (req, res) => void res.json({ labels: await organization.listLabels(userId(req)) })));
  router.get(
    "/conversation/:conversationId",
    validateParams(conversationParams),
    handle(async (req, res) => {
      res.json({ saved: await organization.savedIdsInConversation(userId(req), req.params.conversationId as string) });
    })
  );
  router.put(
    "/:messageId",
    validateParams(messageParams),
    validateBody(saveSchema),
    handle(async (req, res) => void res.json({ saved: await organization.save(userId(req), req.params.messageId as string, req.body) }))
  );
  router.delete(
    "/:messageId",
    validateParams(messageParams),
    handle(async (req, res) => {
      await organization.unsave(userId(req), req.params.messageId as string);
      res.status(204).send();
    })
  );
  return router;
}

/** /api/v1/preferences — timezone, Productivity Mode, notification switches, focused conversations. */
export function createPreferencesRouter(preferences: PreferencesService, access: ConversationAccessService): Router {
  const router = Router();
  router.use(requireAuth);
  router.get("/", handle(async (req, res) => void res.json({ preferences: await preferences.get(userId(req)) })));
  router.patch(
    "/",
    validateBody(preferencesSchema),
    handle(async (req, res) => void res.json({ preferences: await preferences.update(userId(req), req.body) }))
  );
  router.get("/focus", handle(async (req, res) => void res.json({ conversationIds: await preferences.listFocused(userId(req)) })));
  router.put(
    "/focus/:conversationId",
    validateParams(conversationParams),
    handle(async (req, res) => {
      await access.require(req.params.conversationId as string, userId(req));
      res.json({ conversationIds: await preferences.setFocused(userId(req), req.params.conversationId as string, true) });
    })
  );
  router.delete(
    "/focus/:conversationId",
    validateParams(conversationParams),
    handle(async (req, res) => {
      res.json({ conversationIds: await preferences.setFocused(userId(req), req.params.conversationId as string, false) });
    })
  );
  return router;
}
