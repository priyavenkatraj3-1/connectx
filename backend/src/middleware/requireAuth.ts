import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../modules/auth/token.service";
import { AppError } from "./errorHandler";

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    /** The session (device sign-in) this token belongs to — see SessionsService. */
    sessionId?: string;
  };
}

/**
 * Protects a route by requiring a valid access token in the Authorization header.
 * Attaches the decoded user identity to `req.user` on success.
 *
 * Whether the token's session is still active (not revoked from another
 * device) is checked once per request by `createSessionGuard`, mounted in
 * front of every /api/v1 router in app.ts.
 */
export function requireAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    throw new AppError("Authentication required", 401);
  }

  const token = header.slice("Bearer ".length);

  try {
    const payload = verifyAccessToken(token);
    req.user = { userId: payload.userId, sessionId: payload.sid };
    next();
  } catch {
    throw new AppError("Invalid or expired token", 401);
  }
}

export interface SessionValidator {
  isActive(userId: string, sessionId: string): Promise<boolean>;
}

/**
 * Rejects requests whose access token belongs to a revoked or expired
 * session (401, code "session_revoked"). Requests without a (valid) bearer
 * token pass through untouched — requireAuth on the route decides whether
 * one is needed. Tokens without a session ID are rejected: every token
 * ConnectX issues carries one, so a sid-less token can't be revoked.
 */
export function createSessionGuard(validator: SessionValidator) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return next();

    let payload: ReturnType<typeof verifyAccessToken>;
    try {
      payload = verifyAccessToken(header.slice("Bearer ".length));
    } catch {
      return next();
    }
    if (!payload.sid) return next(new AppError("This sign-in is no longer valid. Please sign in again.", 401, true, "session_revoked"));

    validator.isActive(payload.userId, payload.sid).then(
      (active) => next(active ? undefined : new AppError("This session has been signed out. Please sign in again.", 401, true, "session_revoked")),
      next
    );
  };
}
