import { z } from "zod";

export const startCallSchema = z.object({
  conversationId: z.string().uuid("conversationId must be a valid ID"),
  media: z.enum(["voice", "video"], { message: "media must be 'voice' or 'video'" }),
  /** The caller's WebSocket connection ID (the `cid` it connected with) — signaling for this call goes only to that tab/device. */
  connectionId: z.string().uuid("connectionId must be a valid ID"),
});

export const callParamsSchema = z.object({
  callId: z.string().uuid("callId must be a valid ID"),
});

export const callHistoryQuerySchema = z.object({
  conversationId: z.string().uuid("conversationId must be a valid ID").optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().uuid("before must be a valid call ID").optional(),
});

export const activeCallQuerySchema = z.object({
  conversationId: z.string().uuid("conversationId must be a valid ID"),
});

export type StartCallInput = z.infer<typeof startCallSchema>;
