import { z } from "zod";

const MAX_BODY_LENGTH = 4000;
const MAX_MENTIONS = 50;

const mentionedUserIdsSchema = z
  .array(z.string().uuid("mentionedUserIds must contain valid user IDs"))
  .max(MAX_MENTIONS, `At most ${MAX_MENTIONS} mentions per message`)
  .optional();

/**
 * A message needs text, an attachment, or both (attachment + caption).
 * `body` alone keeps the exact Phase 2 request shape valid.
 */
export const sendMessageSchema = z
  .object({
    body: z.string().trim().max(MAX_BODY_LENGTH, "Message is too long").optional(),
    replyToMessageId: z.string().uuid("replyToMessageId must be a valid message ID").optional(),
    mentionedUserIds: mentionedUserIdsSchema,
    attachmentId: z.string().uuid("attachmentId must be a valid attachment ID").optional(),
    clientMessageId: z.string().uuid("clientMessageId must be a UUID").optional(),
  })
  .refine((data) => (data.body !== undefined && data.body.length > 0) || data.attachmentId !== undefined, {
    message: "Message cannot be empty",
    path: ["body"],
  });

export const editMessageSchema = z.object({
  body: z.string().trim().max(MAX_BODY_LENGTH, "Message is too long"),
  mentionedUserIds: mentionedUserIdsSchema,
});

export const markReadSchema = z.object({
  upToMessageId: z.string().uuid("upToMessageId must be a valid message ID"),
});

export const listMessagesQuerySchema = z.object({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const conversationParamsSchema = z.object({
  conversationId: z.string().uuid("conversationId must be a valid ID"),
});

export const messageParamsSchema = z.object({
  conversationId: z.string().uuid("conversationId must be a valid ID"),
  messageId: z.string().uuid("messageId must be a valid ID"),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type EditMessageInput = z.infer<typeof editMessageSchema>;
export type MarkReadInput = z.infer<typeof markReadSchema>;
