import { z } from "zod";

export const createDirectConversationSchema = z.object({
  userId: z.string().uuid("userId must be a valid user ID"),
});

export const chatPreferencesSchema = z
  .object({
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
    mute: z.enum(["8h", "1w", "always", "off"]).optional(),
  })
  .strict()
  .refine((v) => v.pinned !== undefined || v.archived !== undefined || v.mute !== undefined, { message: "Nothing to update" });

export type ChatPreferencesInput = z.infer<typeof chatPreferencesSchema>;
export type CreateDirectConversationInput = z.infer<typeof createDirectConversationSchema>;
