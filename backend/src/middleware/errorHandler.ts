import type { NextFunction, Request, Response } from "express";

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      message: `Route not found: ${req.method} ${req.originalUrl}`,
    },
  });
}

function exposedClientStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const { expose, status } = err as Error & { expose?: unknown; status?: unknown };
  if (expose === true && typeof status === "number" && status >= 400 && status < 500) return status;
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const isAppError = err instanceof AppError;
  // body-parser (express.json/raw) errors carry a client-safe 4xx `status`
  // and `expose: true` — e.g. malformed JSON (400) or an oversized body (413).
  const clientStatus = !isAppError ? exposedClientStatus(err) : null;
  const isExposedClientError = clientStatus !== null;
  const statusCode = isAppError ? err.statusCode : (clientStatus ?? 500);
  const message = err instanceof Error ? err.message : "Internal server error";

  if ((!isAppError && !isExposedClientError) || (isAppError && !err.isOperational)) {
    // eslint-disable-next-line no-console
    console.error("[unhandled error]", err);
  }

  res.status(statusCode).json({
    error: {
      message: statusCode === 500 ? "Internal server error" : message,
    },
  });
}
