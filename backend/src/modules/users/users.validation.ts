import { z } from "zod";

export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    bio: z.string().trim().max(280).nullable().optional(),
    statusMessage: z.string().trim().max(140).nullable().optional(),
    // http(s) only: a javascript:/data: URL must never reach an <img src> or link on another user's screen.
    avatarUrl: z
      .string()
      .trim()
      .max(2048)
      .url("avatarUrl must be a valid URL")
      .refine((value) => /^https?:\/\//i.test(value), "avatarUrl must start with http:// or https://")
      .nullable()
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

export const userParamsSchema = z.object({
  userId: z.string().uuid("userId must be a valid ID"),
});

export const searchUsersQuerySchema = z.object({
  q: z.string().trim().min(1, "Search query is required").max(80),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
