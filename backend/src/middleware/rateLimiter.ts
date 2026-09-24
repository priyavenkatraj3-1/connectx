import rateLimit from "express-rate-limit";
import { env } from "../config/env";

// Both limiters are process-wide singletons shared by every Express app
// built in this process (see createApp) — that's correct for a single
// running server, but it also means every test file in the same vitest
// run shares one counter per limiter. Relaxing the ceiling in tests keeps
// the limiters wired into the request pipeline (so route registration and
// header behavior are still exercised) without tests tripping each other's
// limits.
const isTest = env.nodeEnv === "test";

/**
 * General-purpose API rate limiter. Individual routes (e.g. login, signup)
 * should layer stricter, purpose-specific limiters on top of this one.
 */
export const apiRateLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: isTest ? 100_000 : env.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many requests, please try again later." } },
});

/**
 * Stricter limiter intended for authentication endpoints (login, signup,
 * password reset) to slow down brute-force and credential-stuffing attempts.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 100_000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many authentication attempts, please try again later." } },
});
