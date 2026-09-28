import { z } from "zod";
import { STATUS_AUDIENCE_MAX, STATUS_BACKGROUND_COLORS, STATUS_TEXT_MAX, STATUS_VISIBILITIES } from "./statuses.types";

export const statusPrivacySchema = z.object({
  visibility: z.enum(STATUS_VISIBILITIES as [string, ...string[]], {
    message: "visibility must be one of: everyone, contacts, selected, except",
  }) as z.ZodType<(typeof STATUS_VISIBILITIES)[number]>,
  /** Allow-list for "selected", deny-list for "except"; ignored otherwise. */
  userIds: z
    .array(z.string().uuid("userIds must contain valid user IDs"))
    .max(STATUS_AUDIENCE_MAX, `At most ${STATUS_AUDIENCE_MAX} people`)
    .optional(),
});

export const createStatusSchema = z
  .object({
    type: z.enum(["text", "image", "video"], { message: "type must be text, image or video" }),
    /** Text of a text status, or the caption of a photo/video. */
    text: z.string().trim().max(STATUS_TEXT_MAX, `Status text can be at most ${STATUS_TEXT_MAX} characters`).optional(),
    backgroundColor: z.enum(STATUS_BACKGROUND_COLORS).optional(),
    /** An upload made with POST /media?purpose=status. */
    attachmentId: z.string().uuid("attachmentId must be a valid ID").optional(),
    /** Per-status privacy. Omitted: your saved default (GET /statuses/privacy). */
    privacy: statusPrivacySchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === "text") {
      if (!data.text) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "A text status needs some text" });
      if (data.attachmentId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["attachmentId"], message: "A text status can't have media" });
      }
    } else {
      if (!data.attachmentId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["attachmentId"], message: `A ${data.type} status needs an upload` });
      }
      if (data.backgroundColor) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["backgroundColor"], message: "Only text statuses have a background" });
      }
    }
  });

export const statusParamsSchema = z.object({
  statusId: z.string().uuid("statusId must be a valid ID"),
});

export type CreateStatusInput = z.infer<typeof createStatusSchema>;
export type StatusPrivacyInput = z.infer<typeof statusPrivacySchema>;
