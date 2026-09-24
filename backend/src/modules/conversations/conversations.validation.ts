import { z } from "zod";

export const createDirectConversationSchema = z.object({
  userId: z.string().uuid("userId must be a valid user ID"),
});

export type CreateDirectConversationInput = z.infer<typeof createDirectConversationSchema>;
