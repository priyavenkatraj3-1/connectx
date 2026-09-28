import { z } from "zod";

export const uploadQuerySchema = z
  .object({
    /** "message" (default): a chat attachment for `conversationId`. "status": status media (no conversation). */
    purpose: z.enum(["message", "status"]).default("message"),
    conversationId: z.string().uuid("conversationId must be a valid ID").optional(),
    filename: z.string().trim().min(1, "filename is required").max(255, "filename is too long"),
    /** Optional client-declared MIME type — a consistency check only; the stored type comes from validation. */
    mimeType: z.string().trim().max(120).optional(),
  })
  .refine((q) => (q.purpose === "message" ? !!q.conversationId : !q.conversationId), {
    message: "conversationId is required for message attachments and not allowed for status media",
    path: ["conversationId"],
  });

export const attachmentParamsSchema = z.object({
  attachmentId: z.string().uuid("attachmentId must be a valid ID"),
});

export type UploadQuery = z.infer<typeof uploadQuerySchema>;
