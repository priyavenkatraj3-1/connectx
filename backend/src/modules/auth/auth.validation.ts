import { z } from "zod";

/** Optional client-supplied description of the signing-in device (Phase 6). Shown in the device list only. */
const deviceSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    platform: z.enum(["web", "ios", "android", "desktop"]).optional(),
  })
  .optional();

export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password is too long")
    .regex(/[a-z]/, "Password must contain a lowercase letter")
    .regex(/[A-Z]/, "Password must contain an uppercase letter")
    .regex(/[0-9]/, "Password must contain a number"),
  displayName: z.string().trim().min(1, "Display name is required").max(80, "Display name is too long"),
  device: deviceSchema,
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
  device: deviceSchema,
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "refreshToken is required").max(4096),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
