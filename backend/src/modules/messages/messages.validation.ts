import { z } from "zod";

export const sendMessageSchema = z.object({
  body: z.string().trim().min(1, "Message cannot be empty").max(4000, "Message is too long"),
});

export const markReadSchema = z.object({
  upToMessageId: z.string().uuid("upToMessageId must be a valid message ID"),
});

export const listMessagesQuerySchema = z.object({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type MarkReadInput = z.infer<typeof markReadSchema>;
