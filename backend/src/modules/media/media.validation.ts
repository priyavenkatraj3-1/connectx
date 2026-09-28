import { z } from "zod";

export const uploadQuerySchema = z.object({
  conversationId: z.string().uuid("conversationId must be a valid ID"),
  filename: z.string().trim().min(1, "filename is required").max(255, "filename is too long"),
  /** Optional client-declared MIME type — a consistency check only; the stored type comes from validation. */
  mimeType: z.string().trim().max(120).optional(),
});

export const attachmentParamsSchema = z.object({
  attachmentId: z.string().uuid("attachmentId must be a valid ID"),
});

export type UploadQuery = z.infer<typeof uploadQuerySchema>;
