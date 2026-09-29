import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/requireAuth";
import { validateBody, validateParams } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { WEEKDAYS, type BusinessService } from "./business.service";

const uuid = (field: string) => z.string().uuid(`${field} must be a valid ID`);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Times must look like HH:MM (24-hour)");
const interval = z.object({ open: time, close: time }).strict().refine((v) => v.open < v.close, { message: "open must be before close" });
const hoursShape = Object.fromEntries(WEEKDAYS.map((day) => [day, z.array(interval).max(3).optional()])) as Record<
  (typeof WEEKDAYS)[number],
  z.ZodOptional<z.ZodArray<typeof interval>>
>;
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === "" ? null : v));

export const businessProfileSchema = z
  .object({
    businessName: z.string().trim().min(1, "Business name is required").max(120),
    description: nullableText(1000),
    category: nullableText(60),
    website: z
      .string()
      .trim()
      .max(300)
      .url("Website must be a valid URL")
      .refine((v) => /^https?:\/\//i.test(v), "Website must start with http:// or https://")
      .nullable()
      .optional()
      .or(z.literal("").transform(() => null)),
    contactEmail: z.string().trim().max(254).email("Invalid contact email").nullable().optional().or(z.literal("").transform(() => null)),
    contactPhone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()\-.]{5,32}$/, "Invalid phone number")
      .nullable()
      .optional()
      .or(z.literal("").transform(() => null)),
    address: nullableText(300),
    businessHours: z.object(hoursShape).strict().optional(),
    isPublic: z.boolean().optional(),
  })
  .strict();

const shortcut = z
  .string()
  .trim()
  .regex(/^\/?[a-z0-9][a-z0-9_-]{0,30}$/i, "Shortcut: letters, numbers, - and _ (e.g. /hours)")
  .transform((v) => (v.startsWith("/") ? v.toLowerCase() : `/${v.toLowerCase()}`));

export const createQuickReplySchema = z
  .object({ shortcut, title: z.string().trim().min(1).max(80), body: z.string().trim().min(1).max(2000) })
  .strict();
export const updateQuickReplySchema = z
  .object({ shortcut: shortcut.optional(), title: z.string().trim().min(1).max(80).optional(), body: z.string().trim().min(1).max(2000).optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const handle = (fn: Handler) => asyncHandler(fn as Parameters<typeof asyncHandler>[0]);
const userId = (req: AuthenticatedRequest) => req.user!.userId;

/** /api/v1/business — the caller's own business profile and quick replies, plus public profile lookup. */
export function createBusinessRouter(business: BusinessService): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/profile", handle(async (req, res) => void res.json({ profile: await business.getOwn(userId(req)) })));
  router.put(
    "/profile",
    validateBody(businessProfileSchema),
    handle(async (req, res) => void res.json({ profile: await business.upsert(userId(req), req.body) }))
  );
  router.delete(
    "/profile",
    handle(async (req, res) => {
      await business.remove(userId(req));
      res.status(204).send();
    })
  );
  router.get(
    "/profiles/:userId",
    validateParams(z.object({ userId: uuid("userId") })),
    handle(async (req, res) => void res.json({ profile: await business.getPublic(req.params.userId as string) }))
  );

  router.get("/quick-replies", handle(async (req, res) => void res.json({ quickReplies: await business.listQuickReplies(userId(req)) })));
  router.post(
    "/quick-replies",
    validateBody(createQuickReplySchema),
    handle(async (req, res) => void res.status(201).json({ quickReply: await business.createQuickReply(userId(req), req.body) }))
  );
  const idParams = validateParams(z.object({ id: uuid("id") }));
  router.patch(
    "/quick-replies/:id",
    idParams,
    validateBody(updateQuickReplySchema),
    handle(async (req, res) => void res.json({ quickReply: await business.updateQuickReply(userId(req), req.params.id as string, req.body) }))
  );
  router.delete(
    "/quick-replies/:id",
    idParams,
    handle(async (req, res) => {
      await business.deleteQuickReply(userId(req), req.params.id as string);
      res.status(204).send();
    })
  );
  return router;
}
