import { z } from "zod";

export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    bio: z.string().trim().max(280).nullable().optional(),
    statusMessage: z.string().trim().max(140).nullable().optional(),
    avatarUrl: z.string().trim().url().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

export const searchUsersQuerySchema = z.object({
  q: z.string().trim().min(1, "Search query is required").max(80),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
