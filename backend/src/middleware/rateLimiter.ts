import type { Request } from "express";
import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import { env } from "../config/env";
import type { AuthenticatedRequest } from "./requireAuth";

// The IP-keyed limiters are process-wide singletons shared by every Express
// app built in this process (see createApp) — that's correct for a single
// running server, but it also means every test file in the same vitest run
// shares one counter per limiter. Relaxing the ceiling in tests keeps the
// limiters wired into the request pipeline (so route registration and
// header behavior are still exercised) without tests tripping each other's
// limits. Limit *behavior* is tested directly (tests/unit/rate-limit.test.ts).
//
// Every counter lives in this process's memory: limits are per process, not
// shared across instances, and reset on restart. See docs/security.md.
const isTest = env.nodeEnv === "test";

function errorBody(message: string) {
  return { error: { message, code: "rate_limited" } };
}

/**
 * General-purpose API rate limiter (per client IP). Individual routes layer
 * stricter, purpose-specific limiters on top of this one.
 */
export const apiRateLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: isTest ? 100_000 : env.rateLimit.maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: errorBody("Too many requests, please try again later."),
});

/**
 * Stricter limiter for login and signup (per client IP) to slow down
 * brute-force and credential-stuffing attempts.
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 100_000 : env.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: errorBody("Too many authentication attempts, please try again later."),
});

/** Token refreshes (per client IP). Normal clients refresh about once per access-token lifetime. */
export const refreshRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 100_000 : env.rateLimit.refreshMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: errorBody("Too many session refreshes, please try again later."),
});

export interface UserRateLimitOptions {
  windowMs: number;
  max: number;
  message: string;
}

/**
 * Per-user limiter for authenticated routes: keys on the authenticated user
 * (falling back to the client IP), so one account can't flood an endpoint
 * and users behind a shared IP don't throttle each other. Must run after
 * requireAuth. Each call creates an independent counter.
 */
export function createUserRateLimiter(options: UserRateLimitOptions): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      const userId = (req as AuthenticatedRequest).user?.userId;
      return userId ? `user:${userId}` : `ip:${req.ip ?? "unknown"}`;
    },
    message: errorBody(options.message),
  });
}

const MINUTE_MS = 60_000;

/** The per-user limiters used by the routers, built from env (relaxed in tests, like the IP limiters). */
export function createUserRateLimiters() {
  const cap = (value: number) => (isTest ? 100_000 : value);
  return {
    messages: createUserRateLimiter({
      windowMs: MINUTE_MS,
      max: cap(env.rateLimit.messagesPerMinute),
      message: "You're sending messages too quickly. Please slow down.",
    }),
    uploads: createUserRateLimiter({
      windowMs: MINUTE_MS,
      max: cap(env.rateLimit.uploadsPerMinute),
      message: "Too many uploads in a short time. Please wait a moment.",
    }),
    search: createUserRateLimiter({
      windowMs: MINUTE_MS,
      max: cap(env.rateLimit.searchesPerMinute),
      message: "Too many searches in a short time. Please wait a moment.",
    }),
    callStarts: createUserRateLimiter({
      windowMs: MINUTE_MS,
      max: cap(env.rateLimit.callStartsPerMinute),
      message: "Too many calls started in a short time. Please wait a moment.",
    }),
    statuses: createUserRateLimiter({
      windowMs: 60 * MINUTE_MS,
      max: cap(env.rateLimit.statusesPerHour),
      message: "You've posted a lot of statuses recently. Please try again later.",
    }),
  };
}

export type UserRateLimiters = ReturnType<typeof createUserRateLimiters>;
