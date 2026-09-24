import rateLimit from "express-rate-limit";
import { env } from "../config/env";

/**
 * General-purpose API rate limiter. Individual routes (e.g. login, signup)
 * should layer stricter, purpose-specific limiters on top of this one.
 */
export const apiRateLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.maxRequests,
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
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many authentication attempts, please try again later." } },
});
