import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/requireAuth";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { isoDateTime, localDateTime, timezoneField } from "../productivity/productivity.validation";
import type { ScheduledMessagesService } from "./scheduled-messages.service";

const uuid = (field: string) => z.string().uuid(`${field} must be a valid ID`);
const body = z.string().trim().min(1, "Message cannot be empty").max(4000, "Message is too long");

export const createScheduledSchema = z
  .object({
    conversationId: uuid("conversationId"),
    body,
    scheduledFor: isoDateTime.optional(),
    scheduledForLocal: localDateTime.optional(),
    timezone: timezoneField.nullable().optional(),
  })
  .strict()
  .refine((v) => v.scheduledFor !== undefined || v.scheduledForLocal !== undefined, {
    message: "scheduledFor or scheduledForLocal is required",
    path: ["scheduledFor"],
  });

export const updateScheduledSchema = z
  .object({
    body: body.optional(),
    scheduledFor: isoDateTime.optional(),
    scheduledForLocal: localDateTime.optional(),
    timezone: timezoneField.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

export const listScheduledQuerySchema = z.object({
  conversationId: uuid("conversationId").optional(),
  status: z.enum(["scheduled", "sending", "sent", "failed", "cancelled"]).optional(),
});

const idParams = validateParams(z.object({ id: uuid("id") }));

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const handle = (fn: Handler) => asyncHandler(fn as Parameters<typeof asyncHandler>[0]);
const userId = (req: AuthenticatedRequest) => req.user!.userId;

/** /api/v1/scheduled-messages — only the sender can see or change their scheduled messages. */
export function createScheduledMessagesRouter(scheduled: ScheduledMessagesService): Router {
  const router = Router();
  router.use(requireAuth);
  router.get(
    "/",
    validateQuery(listScheduledQuerySchema),
    handle(async (req, res) => {
      res.json({ scheduledMessages: await scheduled.list(userId(req), listScheduledQuerySchema.parse(req.query)) });
    })
  );
  router.post(
    "/",
    validateBody(createScheduledSchema),
    handle(async (req, res) => void res.status(201).json({ scheduledMessage: await scheduled.create(userId(req), req.body) }))
  );
  router.patch(
    "/:id",
    idParams,
    validateBody(updateScheduledSchema),
    handle(async (req, res) => void res.json({ scheduledMessage: await scheduled.update(userId(req), req.params.id as string, req.body) }))
  );
  router.post(
    "/:id/cancel",
    idParams,
    handle(async (req, res) => void res.json({ scheduledMessage: await scheduled.cancel(userId(req), req.params.id as string) }))
  );
  router.delete(
    "/:id",
    idParams,
    handle(async (req, res) => {
      await scheduled.remove(userId(req), req.params.id as string);
      res.status(204).send();
    })
  );
  return router;
}
