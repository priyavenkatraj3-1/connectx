import type { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger";

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  /** Optional machine-readable code returned alongside the message (e.g. "ai_not_configured"). */
  public readonly code: string | undefined;

  constructor(message: string, statusCode = 500, isOperational = true, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.code = code;
    // new.target keeps subclasses (e.g. the AI errors) instanceof-correct.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      message: `Route not found: ${req.method} ${req.originalUrl}`,
    },
  });
}

/**
 * PostgreSQL "data exception" SQLSTATEs (class 22) caused by client input
 * that slipped past route validation — e.g. a malformed UUID in a path
 * (22P02), a number or date out of range (22003, 22008), text too long for
 * a column (22001). These are the client's fault, so they become a generic
 * 400 instead of a logged 500. The database's own message is not echoed.
 */
function isInvalidInputDbError(err: unknown): boolean {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^22[0-9A-Z]{3}$/.test(code);
}

function exposedClientStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const { expose, status } = err as Error & { expose?: unknown; status?: unknown };
  if (expose === true && typeof status === "number" && status >= 400 && status < 500) return status;
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (isInvalidInputDbError(err)) {
    res.status(400).json({ error: { message: "Invalid request: a value has the wrong format or is out of range" } });
    return;
  }

  const isAppError = err instanceof AppError;
  // body-parser (express.json/raw) errors carry a client-safe 4xx `status`
  // and `expose: true` — e.g. malformed JSON (400) or an oversized body (413).
  const clientStatus = !isAppError ? exposedClientStatus(err) : null;
  const isExposedClientError = clientStatus !== null;
  const statusCode = isAppError ? err.statusCode : (clientStatus ?? 500);
  const message = err instanceof Error ? err.message : "Internal server error";

  if ((!isAppError && !isExposedClientError) || (isAppError && !err.isOperational)) {
    logger.error(`[unhandled error] ${req.method} ${req.path}`, err);
  }

  res.status(statusCode).json({
    error: {
      message: statusCode === 500 ? "Internal server error" : message,
      ...(isAppError && err.code && statusCode !== 500 ? { code: err.code } : {}),
    },
  });
}
