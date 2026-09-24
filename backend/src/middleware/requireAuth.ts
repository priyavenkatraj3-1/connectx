import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../modules/auth/token.service";
import { AppError } from "./errorHandler";

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
  };
}

/**
 * Protects a route by requiring a valid access token in the Authorization header.
 * Attaches the decoded user identity to `req.user` on success.
 */
export function requireAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    throw new AppError("Authentication required", 401);
  }

  const token = header.slice("Bearer ".length);

  try {
    const payload = verifyAccessToken(token);
    req.user = { userId: payload.userId };
    next();
  } catch {
    throw new AppError("Invalid or expired token", 401);
  }
}
