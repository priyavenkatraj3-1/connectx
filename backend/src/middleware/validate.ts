import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";
import { AppError } from "./errorHandler";

/**
 * Validates `req.body` against a Zod schema and replaces it with the parsed,
 * type-safe result. Rejects the request with a 400 before it reaches a
 * controller if validation fails, so handlers can trust their input shape.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const message = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new AppError(`Validation failed: ${message}`, 400);
    }

    req.body = result.data;
    next();
  };
}

/**
 * Validates `req.params` (e.g. that IDs are UUIDs) so malformed IDs get a
 * clean 400 instead of reaching the database. Must be registered on the
 * route itself — Express only populates params per matched route.
 */
export function validateParams(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      const message = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new AppError(`Validation failed: ${message}`, 400);
    }

    next();
  };
}

/**
 * Validates `req.query` against a Zod schema. Express types `req.query` as
 * read-only-ish `ParsedQs`; we validate it but deliberately don't reassign
 * it (unlike validateBody) since Express 4 getters make that unreliable —
 * handlers should re-parse via the schema if they need the typed value.
 */
export function validateQuery(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      const message = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new AppError(`Validation failed: ${message}`, 400);
    }

    next();
  };
}
