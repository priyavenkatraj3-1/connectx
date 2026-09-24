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
